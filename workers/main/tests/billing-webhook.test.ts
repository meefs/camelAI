import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { STRIPE_API_VERSION } from "../../../src/lib/billing.server";
import { handleStripeWebhook } from "../src/routes/billing";
import type { Env } from "../src/types";
import { createOrg, createUser, type TestEnv } from "./test-helpers";

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
  invoiceId?: string;
  envOverrides?: Partial<Env>;
}) {
  const invoiceId = args.invoiceId ?? "in_webhook_test";
  const payload = JSON.stringify({
    id: `evt_${args.eventType.replaceAll(".", "_")}`,
    type: args.eventType,
    data: { object: { id: invoiceId } },
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
      ...args.envOverrides,
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

  it("returns 200 and grants a delayed retired-price initial invoice", async () => {
    const testEnv = env as unknown as TestEnv;
    const { userId } = await createUser(
      testEnv,
      `billing-initial-${crypto.randomUUID()}@example.com`,
      "password",
      "Billing Owner",
    );
    const { org } = await createOrg(
      testEnv,
      `Billing Initial ${crypto.randomUUID()}`,
      userId,
      { billingPlan: "payg" },
    );
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    await orgStub.updateBillingState({
      billing_status: "active",
      billing_plan: "pro",
      billing_seat_count: 1,
      billing_customer_id: "cus_webhook_initial",
      billing_subscription_id: "sub_webhook_initial",
      billing_subscription_status: "active",
      billing_credit_grant_total_cents: 0,
    });
    const invoiceId = `in_webhook_initial_${crypto.randomUUID()}`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith(`/invoices/${invoiceId}`)) {
          return Response.json({
            id: invoiceId,
            status: "paid",
            customer: "cus_webhook_initial",
            billing_reason: "subscription_create",
            parent: {
              subscription_details: {
                subscription: "sub_webhook_initial",
                metadata: {
                  org_id: org.id,
                  billing_plan: "pro",
                  seat_count: "1",
                  subscription_included_credit_cents: "3000",
                  initial_included_credit_cents: "3000",
                },
              },
            },
          });
        }
        if (url.includes(`/invoices/${invoiceId}/lines?`)) {
          return Response.json({
            data: [
              {
                id: "line_webhook_initial_pro",
                amount: 3000,
                quantity: 1,
                price: "price_1TS5SoGvliMKf4vHmzDcxSXF",
                type: "subscription",
              },
            ],
            has_more: false,
          });
        }
        if (
          url.endsWith("/subscriptions/sub_webhook_initial") &&
          init?.method === "GET"
        ) {
          return Response.json({
            id: "sub_webhook_initial",
            status: "active",
            customer: "cus_webhook_initial",
            metadata: {
              org_id: org.id,
              billing_plan: "pro",
              seat_count: "1",
              subscription_included_credit_cents: "4000",
            },
            items: {
              data: [
                {
                  id: "si_webhook_initial_pro",
                  quantity: 1,
                  price: "price_webhook_pro",
                },
              ],
            },
          });
        }
        if (url.includes("/prices/") && init?.method === "GET") {
          const priceId = url.split("/prices/")[1];
          const amount =
            priceId === "price_webhook_starter"
              ? 1000
              : priceId === "price_webhook_pro"
                ? 4000
                : 5000;
          return Response.json({
            id: priceId,
            active: true,
            product: `prod_${priceId}`,
            unit_amount: amount,
            currency: "usd",
            recurring: { interval: "month", interval_count: 1 },
          });
        }
        throw new Error(
          `Unexpected Stripe request: ${init?.method ?? "GET"} ${url}`,
        );
      }),
    );
    const consoleInfo = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);

    const response = await sendWebhook({
      eventType: "invoice.paid",
      secret: "whsec_current",
      invoiceId,
      envOverrides: {
        STRIPE_STARTER_PRICE_ID: "price_webhook_starter",
        STRIPE_PRO_PRICE_ID: "price_webhook_pro",
        STRIPE_TEAM_PRICE_ID: "price_webhook_team",
      },
    });

    expect(response.status).toBe(200);
    expect(consoleInfo).toHaveBeenCalledWith(
      "[billing] paid invoice webhook processed",
      expect.objectContaining({
        eventType: "invoice.paid",
        outcome: "processed",
        grantCents: 3000,
      }),
    );
    await expect(orgStub.getInfo()).resolves.toMatchObject({
      billing_plan: "pro",
      billing_seat_count: 1,
      billing_credit_grant_total_cents: 3000,
    });
    await expect(
      orgStub.getSubscriptionInvoiceGrant(invoiceId),
    ).resolves.toMatchObject({
      source: "initial",
      plan: "pro",
      amount_cents: 3000,
    });
    consoleInfo.mockRestore();
  });

  it("retries failed migration cleanup on the duplicate paid-event alias", async () => {
    const testEnv = env as unknown as TestEnv;
    const { userId } = await createUser(
      testEnv,
      `billing-webhook-${crypto.randomUUID()}@example.com`,
      "password",
      "Billing Owner",
    );
    const { org } = await createOrg(
      testEnv,
      `Billing Webhook ${crypto.randomUUID()}`,
      userId,
      { billingPlan: "payg" },
    );
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    await orgStub.updateBillingState({
      billing_status: "active",
      billing_plan: "pro",
      billing_seat_count: 1,
      billing_customer_id: "cus_webhook_migration",
      billing_subscription_id: "sub_webhook_migration",
      billing_subscription_status: "active",
      billing_credit_grant_total_cents: 0,
    });
    const invoiceId = `in_webhook_migration_${crypto.randomUUID()}`;
    const customerMetadata: Record<string, string> = {
      org_id: org.id,
      v2_mig_org: org.id,
      v2_mig_sub: "sub_webhook_migration",
      v2_mig_plan: "pro",
      v2_mig_seats: "1",
      v2_mig_credits: "4000",
      v2_mig_price: "price_1QIfnqGvliMKf4vHaDTMG2Mu",
      pending_legacy_migration_org_id: org.id,
      pending_legacy_migration_subscription_id: "sub_webhook_migration",
      pending_legacy_migration_target_plan: "pro",
      pending_legacy_migration_seat_count: "1",
      pending_legacy_migration_included_credit_cents: "4000",
      pending_legacy_migration_source_price_id:
        "price_1QIfnqGvliMKf4vHaDTMG2Mu",
    };
    let customerGetCount = 0;
    let customerCleanupAttemptCount = 0;
    let successfulCleanupBody: URLSearchParams | null = null;
    let priceGetCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith(`/invoices/${invoiceId}`)) {
          return Response.json({
            id: invoiceId,
            status: "paid",
            customer: "cus_webhook_migration",
            billing_reason: "subscription_update",
            parent: {
              subscription_details: {
                subscription: "sub_webhook_migration",
                metadata: { org_id: org.id },
              },
            },
          });
        }
        if (url.includes(`/invoices/${invoiceId}/lines?`)) {
          return Response.json({
            data: [
              {
                id: "line_legacy_debit",
                amount: -500,
                quantity: 1,
                price: "price_1QIfnqGvliMKf4vHaDTMG2Mu",
                proration: true,
              },
              {
                id: "line_pro_credit",
                amount: 1000,
                quantity: 1,
                price: "price_webhook_pro",
                proration: true,
              },
            ],
            has_more: false,
          });
        }
        if (
          url.endsWith("/subscriptions/sub_webhook_migration") &&
          init?.method === "GET"
        ) {
          return Response.json({
            id: "sub_webhook_migration",
            status: "active",
            customer: "cus_webhook_migration",
            metadata: {
              org_id: org.id,
              billing_plan: "pro",
              seat_count: "1",
              subscription_included_credit_cents: "4000",
            },
            items: {
              data: [
                {
                  id: "si_webhook_pro",
                  quantity: 1,
                  price: "price_webhook_pro",
                },
              ],
            },
          });
        }
        if (
          url.endsWith("/customers/cus_webhook_migration") &&
          init?.method === "GET"
        ) {
          customerGetCount += 1;
          return Response.json({
            id: "cus_webhook_migration",
            metadata: customerMetadata,
          });
        }
        if (
          url.endsWith("/customers/cus_webhook_migration") &&
          init?.method === "POST"
        ) {
          customerCleanupAttemptCount += 1;
          if (customerCleanupAttemptCount === 1) {
            return new Response("temporary cleanup failure", { status: 503 });
          }
          successfulCleanupBody = new URLSearchParams(init.body as string);
          for (const [field, value] of successfulCleanupBody) {
            const match = /^metadata\[(.+)]$/.exec(field);
            if (!match) continue;
            if (value === "") delete customerMetadata[match[1]];
            else customerMetadata[match[1]] = value;
          }
          return Response.json({
            id: "cus_webhook_migration",
            metadata: customerMetadata,
          });
        }
        if (url.includes("/prices/") && init?.method === "GET") {
          priceGetCount += 1;
          const priceId = url.split("/prices/")[1];
          const amount =
            priceId === "price_webhook_starter"
              ? 1000
              : priceId === "price_webhook_pro"
                ? 4000
                : 5000;
          return Response.json({
            id: priceId,
            active: true,
            product: `prod_${priceId}`,
            unit_amount: amount,
            currency: "usd",
            recurring: { interval: "month", interval_count: 1 },
          });
        }
        throw new Error(
          `Unexpected Stripe request: ${init?.method ?? "GET"} ${url}`,
        );
      }),
    );
    const envOverrides = {
      STRIPE_STARTER_PRICE_ID: "price_webhook_starter",
      STRIPE_PRO_PRICE_ID: "price_webhook_pro",
      STRIPE_TEAM_PRICE_ID: "price_webhook_team",
    };
    const consoleInfo = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const first = await sendWebhook({
      eventType: "invoice.payment_succeeded",
      secret: "whsec_current",
      invoiceId,
      envOverrides,
    });
    const second = await sendWebhook({
      eventType: "invoice.paid",
      secret: "whsec_current",
      invoiceId,
      envOverrides,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(customerMetadata).toEqual({ org_id: org.id });
    expect(customerGetCount).toBe(2);
    expect(customerCleanupAttemptCount).toBe(2);
    expect(priceGetCount).toBe(3);
    expect(successfulCleanupBody).not.toBeNull();
    for (const key of [
      "v2_mig_org",
      "v2_mig_sub",
      "v2_mig_plan",
      "v2_mig_seats",
      "v2_mig_credits",
      "v2_mig_price",
      "pending_legacy_migration_org_id",
      "pending_legacy_migration_subscription_id",
      "pending_legacy_migration_target_plan",
      "pending_legacy_migration_seat_count",
      "pending_legacy_migration_included_credit_cents",
      "pending_legacy_migration_source_price_id",
    ]) {
      expect(successfulCleanupBody?.get(`metadata[${key}]`)).toBe("");
    }
    expect(consoleInfo).toHaveBeenCalledWith(
      "[billing] paid invoice webhook processed",
      expect.objectContaining({
        eventType: "invoice.payment_succeeded",
        outcome: "processed",
        grantCents: 4000,
      }),
    );
    expect(consoleInfo).toHaveBeenCalledWith(
      "[billing] paid invoice webhook processed",
      expect.objectContaining({
        eventType: "invoice.paid",
        outcome: "duplicate",
        grantCents: 0,
      }),
    );
    await expect(orgStub.getInfo()).resolves.toMatchObject({
      billing_credit_grant_total_cents: 4000,
    });
    await expect(
      orgStub.getSubscriptionInvoiceGrant(invoiceId),
    ).resolves.toMatchObject({
      source: "legacy_migration",
      amount_cents: 4000,
    });
    consoleInfo.mockRestore();
    consoleError.mockRestore();
  });

  it("acks unlinked legacy/API renewals instead of failing the webhook", async () => {
    const invoiceId = `in_webhook_orphan_${crypto.randomUUID()}`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith(`/invoices/${invoiceId}`)) {
          return Response.json({
            id: invoiceId,
            status: "paid",
            customer: "cus_legacy_orphan",
            subscription: "sub_legacy_orphan",
            billing_reason: "subscription_cycle",
          });
        }
        if (url.includes(`/invoices/${invoiceId}/lines?`)) {
          return Response.json({ data: [], has_more: false });
        }
        if (url.endsWith("/subscriptions/sub_legacy_orphan")) {
          return Response.json({
            id: "sub_legacy_orphan",
            status: "active",
            customer: "cus_legacy_orphan",
            metadata: { lookup_key: "api_standard_monthly" },
          });
        }
        if (url.endsWith("/customers/cus_legacy_orphan")) {
          return Response.json({
            id: "cus_legacy_orphan",
            metadata: { user_id: "101" },
          });
        }
        throw new Error(
          `Unexpected Stripe request: ${init?.method ?? "GET"} ${url}`,
        );
      }),
    );
    const consoleWarn = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const response = await sendWebhook({
      eventType: "invoice.payment_succeeded",
      secret: "whsec_current",
      invoiceId,
    });

    expect(response.status).toBe(200);
    expect(consoleError).not.toHaveBeenCalledWith(
      "[billing] webhook processing failed",
      expect.anything(),
    );
    expect(consoleWarn).toHaveBeenCalledWith(
      "[billing] paid invoice ignored (no platform organization)",
      expect.objectContaining({
        invoiceId,
        outcome: "ignored",
        reason: "organization_not_resolved",
        subscriptionId: "sub_legacy_orphan",
      }),
    );
    consoleWarn.mockRestore();
    consoleError.mockRestore();
  });
});
