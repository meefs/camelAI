import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { STRIPE_API_VERSION } from "../../../src/lib/billing.server";
import { handleStripeWebhook } from "../src/routes/billing";
import type { Env } from "../src/types";

async function stripeSignature(payload: string, secret: string): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${payload}`),
  );
  const digest = Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `t=${timestamp},v1=${digest}`;
}

async function sendWebhook(args: {
  eventType: "invoice.paid" | "invoice.payment_succeeded";
  secret: string;
  next?: boolean;
}) {
  const payload = JSON.stringify({
    id: `evt_${args.eventType.replaceAll(".", "_")}`,
    type: args.eventType,
    data: { object: { id: "in_webhook_test" } },
  });
  const url = new URL(
    `https://camelai.test/api/billing/stripe/webhook${args.next ? "?version=next" : ""}`,
  );
  const req = new Request(url, {
    method: "POST",
    headers: {
      "stripe-signature": await stripeSignature(payload, args.secret),
    },
    body: payload,
  });
  return handleStripeWebhook({
    req,
    url,
    env: {
      ...(env as unknown as Env),
      STRIPE_MODE: "test",
      STRIPE_SECRET_KEY: "sk_test_webhook",
      STRIPE_WEBHOOK_SECRET: "whsec_current",
      STRIPE_WEBHOOK_SECRET_NEXT: "whsec_next",
    },
    ctx: {} as ExecutionContext,
    match: [] as unknown as RegExpMatchArray,
  });
}

describe("Stripe paid-invoice webhook routing", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["invoice.paid", "whsec_current", false],
    ["invoice.payment_succeeded", "whsec_next", true],
  ] as const)("routes %s through canonical invoice retrieval", async (eventType, secret, next) => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect((init?.headers as Headers).get("Stripe-Version")).toBe(STRIPE_API_VERSION);
      if (url.endsWith("/invoices/in_webhook_test")) {
        return Response.json({
          id: "in_webhook_test",
          status: "paid",
          subscription: "sub_ignored",
          billing_reason: "manual",
        });
      }
      if (url.includes("/invoices/in_webhook_test/lines?")) {
        return Response.json({ data: [], has_more: false });
      }
      throw new Error(`Unexpected Stripe request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await sendWebhook({ eventType, secret, next });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns 500 when canonical Stripe retrieval fails so Stripe retries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("temporary failure", { status: 503 })),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await sendWebhook({
      eventType: "invoice.paid",
      secret: "whsec_current",
    });

    expect(response.status).toBe(500);
    consoleError.mockRestore();
  });
});
