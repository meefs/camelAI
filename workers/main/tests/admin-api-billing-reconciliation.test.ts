import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { handleAdminApi } from "../src/routes/admin/index";
import type { Env as WorkerEnv } from "../src/types";
import type { TestEnv } from "./test-helpers";

const testEnv = env as unknown as TestEnv;

async function reconcileRequest(body: unknown): Promise<Response> {
  const request = new Request("http://example/api/admin/billing/reconcile-subscription-invoices", {
    method: "POST",
    headers: {
      Authorization: "Bearer test-admin-api-key",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const response = await handleAdminApi({
    req: request,
    env: {
      ...testEnv,
      ADMIN_API_KEY: "test-admin-api-key",
      STRIPE_MODE: "test",
      STRIPE_SECRET_KEY: "sk_test_reconciliation",
    } as unknown as WorkerEnv,
    ctx: {} as ExecutionContext,
    url: new URL(request.url),
    match: request.url.match(/^.*$/)!,
  });
  if (!response) throw new Error("Admin API did not handle request");
  return response;
}

describe("admin paid-invoice reconciliation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("defaults to dry-run and reports deliberately ignored invoices", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/invoices/in_manual")) {
          return Response.json({
            id: "in_manual",
            status: "paid",
            subscription: "sub_manual",
            billing_reason: "manual",
          });
        }
        if (url.includes("/invoices/in_manual/lines?")) {
          return Response.json({ data: [], has_more: false });
        }
        throw new Error(`Unexpected Stripe request: ${url}`);
      }),
    );

    const response = await reconcileRequest({ invoice_ids: ["in_manual"] });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      mode: "dry-run",
      results: [
        {
          invoice_id: "in_manual",
          status: "ignored",
          subscription_id: "sub_manual",
          org_id: null,
          billing_reason: null,
          plan: null,
          seat_count: null,
          source: null,
          computed_grant_cents: null,
          credited_grant_cents: null,
          old_kv_marker: null,
          last_invoice_marker: null,
          ledger_status: null,
          reason: "unsupported_billing_reason",
        },
      ],
    });
  });

  it("reports per-invoice failures without hiding them from the CLI", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("temporary failure", { status: 503 })),
    );

    const response = await reconcileRequest({
      invoice_ids: ["in_retry"],
      apply: true,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      mode: "apply",
      results: [
        {
          invoice_id: "in_retry",
          status: "failed",
          reason: expect.stringContaining("returned 503"),
        },
      ],
    });
  });
});
