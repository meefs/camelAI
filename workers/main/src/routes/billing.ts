import type { RouteContext } from "../types.js";
import { text } from "../helpers/response.js";
import { validateSandboxProxy } from "../sandbox-auth.js";
import {
  applySubscriptionIncludedCreditsFromInvoice,
  applyCreditsCheckoutCompleted,
  getBillingAccessSnapshot,
  syncOrgSubscriptionFromStripe,
  verifyStripeWebhookSignature,
  type StripeCheckoutSession,
  type StripeInvoice,
  type StripeSubscription,
  type StripeWebhookEvent,
} from "../../../../src/lib/billing.server.js";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleInternalBillingAccess({
  req,
  env,
}: RouteContext): Promise<Response> {
  if (req.method !== "GET") {
    return text("Method not allowed", 405);
  }

  const auth = validateSandboxProxy(req, env);
  if (!auth.valid) {
    return text("Unauthorized", 401);
  }

  const snapshot = await getBillingAccessSnapshot(env, auth.orgId);
  if (!snapshot) {
    return text("Organization not found", 404);
  }

  return jsonResponse(snapshot);
}

export async function handleStripeWebhook({
  req,
  env,
}: RouteContext): Promise<Response> {
  if (req.method !== "POST") {
    return text("Method not allowed", 405);
  }

  const webhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!webhookSecret || !env.STRIPE_SECRET_KEY?.trim()) {
    return text("Stripe billing is not configured", 503);
  }

  const payload = await req.text();
  const signatureHeader = req.headers.get("stripe-signature");
  const valid = await verifyStripeWebhookSignature({
    payload,
    signatureHeader,
    secret: webhookSecret,
  });
  if (!valid) {
    return text("Invalid Stripe signature", 400);
  }

  let event: StripeWebhookEvent;
  try {
    event = JSON.parse(payload) as StripeWebhookEvent;
  } catch {
    return text("Invalid JSON payload", 400);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await applyCreditsCheckoutCompleted(
          env,
          event.data.object as StripeCheckoutSession,
        );
        break;
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await syncOrgSubscriptionFromStripe(
          env,
          event.data.object as StripeSubscription,
        );
        break;
      case "invoice.payment_succeeded":
        await applySubscriptionIncludedCreditsFromInvoice(
          env,
          event.data.object as StripeInvoice,
        );
        break;
      default:
        break;
    }
  } catch (error) {
    console.error("[billing] webhook processing failed", {
      eventType: event.type,
      eventId: event.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return text("Webhook processing failed", 500);
  }

  return jsonResponse({ received: true });
}
