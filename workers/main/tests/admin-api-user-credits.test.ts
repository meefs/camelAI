import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { handleAdminApi } from "../src/routes/admin/index";
import type { Env as WorkerEnv } from "../src/types";
import { createOrg, createUser, type TestEnv } from "./test-helpers";

const testEnv = env as unknown as TestEnv;

function testEmail() {
  return `admin-api-credits-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

function adminEnv(options: { usageCostUsd?: number } = {}): WorkerEnv {
  return {
    ...testEnv,
    ADMIN_API_KEY: "test-admin-api-key",
    SANDBOX_HOST: {
      fetch: async (request: Request | string) => {
        const url = new URL(typeof request === "string" ? request : request.url);
        expect(url.pathname).toMatch(/^\/v1\/usage\/orgs\/[^/]+\/log\/sum$/);
        expect(url.searchParams.get("chargeable_only")).toBe("1");
        return Response.json({
          total_cost_usd: options.usageCostUsd ?? 0,
          total_requests: 3,
        });
      },
    } as unknown as Fetcher,
  } as unknown as WorkerEnv;
}

async function adminPutCredits(
  userId: string,
  body: unknown,
  options: { usageCostUsd?: number } = {},
): Promise<Response> {
  const request = new Request(`http://example/api/admin/users/${userId}/credits`, {
    method: "PUT",
    headers: {
      Authorization: "Bearer test-admin-api-key",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const response = await handleAdminApi({
    req: request,
    env: adminEnv(options),
    ctx: {} as ExecutionContext,
    url: new URL(request.url),
    match: request.url.match(/^.*$/)!,
  });

  if (!response) {
    throw new Error("Admin API did not handle request");
  }
  return response;
}

describe("admin API user credits route", () => {
  it("sets a user's visible available credits for a target org", async () => {
    const { userId } = await createUser(testEnv, testEmail(), "password123", "Credit User");
    const { org } = await createOrg(testEnv, "Credits Org", userId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

    await orgStub.updateBillingState({
      billing_credit_purchase_total_cents: 1000,
      billing_credit_grant_total_cents: 2000,
    });

    const response = await adminPutCredits(
      userId,
      {
        org_id: org.id,
        available_credits_cents: 5000,
      },
      { usageCostUsd: 12.34 },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      user_id: userId,
      org_id: org.id,
      chargeable_usage_cents: 1234,
      available_credits_cents: 5000,
      total_credit_limit_cents: 6234,
      billing_credit_purchase_total_cents: 1000,
      billing_credit_grant_total_cents: 5234,
      previous: {
        available_credits_cents: 1766,
        total_credit_limit_cents: 3000,
      },
    });

    const updated = await orgStub.getInfo();
    expect(updated?.billing_credit_purchase_total_cents).toBe(1000);
    expect(updated?.billing_credit_grant_total_cents).toBe(5234);
  });

  it("overrides raw credit totals and reports available credits after usage", async () => {
    const { userId } = await createUser(testEnv, testEmail(), "password123", "Raw Credit User");
    const { org } = await createOrg(testEnv, "Raw Credits Org", userId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

    const response = await adminPutCredits(
      userId,
      {
        org_id: org.id,
        billing_credit_purchase_total_cents: 1200,
        billing_credit_grant_total_cents: -200,
        billing_credit_usage_started_at: 123456,
      },
      { usageCostUsd: 6.25 },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      billing_credit_purchase_total_cents: 1200,
      billing_credit_grant_total_cents: -200,
      chargeable_usage_cents: 625,
      total_credit_limit_cents: 1000,
      available_credits_cents: 375,
      billing_credit_usage_started_at: 123456,
    });

    const updated = await orgStub.getInfo();
    expect(updated?.billing_credit_purchase_total_cents).toBe(1200);
    expect(updated?.billing_credit_grant_total_cents).toBe(-200);
    expect(updated?.billing_credit_usage_started_at).toBe(123456);
  });

  it("requires org_id when the user belongs to multiple orgs", async () => {
    const { userId } = await createUser(testEnv, testEmail(), "password123", "Multi Org User");
    await createOrg(testEnv, "First Credits Org", userId);
    await createOrg(testEnv, "Second Credits Org", userId);

    const response = await adminPutCredits(userId, {
      available_credits_cents: 500,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "org_id is required when the user belongs to zero or multiple organizations",
    });
  });
});
