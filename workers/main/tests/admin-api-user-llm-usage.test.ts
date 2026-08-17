import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { handleAdminApi } from "../src/routes/admin/index";
import type { Env as WorkerEnv } from "../src/types";
import { createOrg, createUser, type TestEnv } from "./test-helpers";

const testEnv = env as unknown as TestEnv;
const key = "usage-admin-test-key";

function workerEnv(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  return { ...testEnv, ADMIN_API_KEY: key, ...overrides } as unknown as WorkerEnv;
}

async function request(path: string, init: RequestInit = {}, environment = workerEnv()) {
  const req = new Request(`http://example.test/api/admin${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, ...(init.headers ?? {}) },
  });
  return handleAdminApi({
    req,
    env: environment,
    ctx: {} as ExecutionContext,
    url: new URL(req.url),
    match: req.url.match(/^.*$/)!,
  });
}

describe("admin per-user LLM usage routes", () => {
  it("configures pricing and limits, filters rows, and returns the user report", async () => {
    const { userId } = await createUser(
      testEnv,
      `usage-api-${crypto.randomUUID()}@example.test`,
      "password123",
      "Usage API User",
    );
    const { org } = await createOrg(testEnv, "Usage API Org", userId);
    const { userId: zeroUsageUserId } = await createUser(
      testEnv,
      `usage-api-zero-${crypto.randomUUID()}@example.test`,
      "password123",
      "Zero Usage Member",
    );
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    await orgStub.addMember(zeroUsageUserId, "member", userId);
    const now = Date.now();

    const pricingResponse = await request(`/orgs/${org.id}/usage/pricing`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "x-admin-mcp-user-id": "forged-mcp-admin",
      },
      body: JSON.stringify({ prices: [{
        provider: "custom",
        model: "api-model",
        input_usd_per_million: 1,
        output_usd_per_million: 2,
      }] }),
    });
    expect(pricingResponse?.status).toBe(200);

    const limitsResponse = await request(`/orgs/${org.id}/usage/users/${userId}/limits`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "x-admin-mcp-user-id": "forged-mcp-admin",
      },
      body: JSON.stringify({ limits: [{ window_hours: 1.1, limit_usd: 5, label: "66-minute" }] }),
    });
    expect(limitsResponse?.status).toBe(200);
    await expect(limitsResponse?.json()).resolves.toMatchObject({
      org_id: org.id,
      user_id: userId,
      limits: [{ window_hours: 1.1, limit_usd: 5, label: "66-minute" }],
    });
    await runInDurableObject(orgStub, (_instance, state) => {
      const pricingActor = state.storage.sql.exec<{ updated_by: string }>(
        "SELECT updated_by FROM llm_model_pricing_overrides WHERE provider = 'custom' AND model = 'api-model'",
      ).one().updated_by;
      const limitActor = state.storage.sql.exec<{ updated_by: string }>(
        "SELECT updated_by FROM user_llm_usage_limits WHERE user_id = ?",
        userId,
      ).one().updated_by;
      expect(pricingActor).toBe("admin_api_key");
      expect(limitActor).toBe("admin_api_key");
    });

    await orgStub.recordUsage({
      user_id: userId,
      provider: "custom",
      model: "api-model",
      usage_kind: "llm",
      usage_surface: "virtual_ai",
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      created_at_ms: now - 10,
      source: "virtual_ai",
      source_id: crypto.randomUUID(),
    });

    const log = await request(
      `/orgs/${org.id}/usage/log?from=${now - 1_000}&to=${now + 1_000}&user_id=${userId}&provider=custom&model=api-model&usage_kind=llm&usage_surface=virtual_ai`,
    );
    expect(log?.status).toBe(200);
    await expect(log?.json()).resolves.toMatchObject({
      count: 1,
      entries: [{ metered_cost_usd: 3, cost_source: "org_override" }],
    });

    const sum = await request(
      `/orgs/${org.id}/usage/log/sum?from=${now - 1_000}&to=${now + 1_000}&user_id=${userId}&provider=custom&model=api-model&usage_kind=llm&usage_surface=virtual_ai`,
    );
    await expect(sum?.json()).resolves.toMatchObject({
      total_requests: 1,
      metered_cost_usd: 3,
      unpriced_requests: 0,
    });

    const report = await request(
      `/orgs/${org.id}/usage/users?from=${now - 1_000}&to=${now + 1_000}&user_id=${userId}`,
    );
    expect(report?.status).toBe(200);
    await expect(report?.json()).resolves.toMatchObject({
      org_id: org.id,
      count: 1,
      users: [{
        user_id: userId,
        membership_status: "current",
        totals: { requests: 1, spend_usd: 3 },
        models: [{ provider: "custom", model: "api-model", spend_usd: 3 }],
      }],
    });

    const firstPage = await request(
      `/orgs/${org.id}/usage/users?from=${now - 1_000}&to=${now + 1_000}&limit=1`,
    );
    const firstPageBody = await firstPage?.json() as {
      users: Array<{ user_id: string; totals: { requests: number } }>;
      has_more: boolean;
      next_cursor: string;
    };
    expect(firstPageBody).toMatchObject({ count: 1, has_more: true });
    const secondPage = await request(
      `/orgs/${org.id}/usage/users?from=${now - 1_000}&to=${now + 1_000}&limit=1&cursor=${encodeURIComponent(firstPageBody.next_cursor)}`,
    );
    const secondPageBody = await secondPage?.json() as typeof firstPageBody;
    expect(secondPageBody).toMatchObject({ count: 1, has_more: false, next_cursor: null });
    const pagedUsers = [...firstPageBody.users, ...secondPageBody.users];
    expect(new Set(pagedUsers.map((user) => user.user_id))).toEqual(new Set([userId, zeroUsageUserId]));
    expect(pagedUsers.find((user) => user.user_id === zeroUsageUserId)?.totals.requests).toBe(0);

    const malformedCursor = await request(
      `/orgs/${org.id}/usage/users?from=${now - 1_000}&to=${now + 1_000}&cursor=not-a-valid-cursor`,
    );
    expect(malformedCursor?.status).toBe(400);
    const reversedRange = await request(
      `/orgs/${org.id}/usage/users?from=${now + 1_000}&to=${now}`,
    );
    expect(reversedRange?.status).toBe(400);
    const reversedSumRange = await request(
      `/orgs/${org.id}/usage/log/sum?from=${now + 1_000}&to=${now}`,
    );
    expect(reversedSumRange?.status).toBe(400);
    const reversedLogRange = await request(
      `/orgs/${org.id}/usage/log?from=${now + 1_000}&to=${now}`,
    );
    expect(reversedLogRange?.status).toBe(400);
    const malformedLogCursor = await request(`/orgs/${org.id}/usage/log?cursor=garbage`);
    expect(malformedLogCursor?.status).toBe(400);
    const zeroUpperBound = await request(`/orgs/${org.id}/usage/log?to=0`);
    expect(zeroUpperBound?.status).toBe(200);
    await expect(zeroUpperBound?.json()).resolves.toMatchObject({ org_id: org.id, count: 0, entries: [] });
    const missingOrgLog = await request(`/orgs/missing-${crypto.randomUUID()}/usage/log`);
    expect(missingOrgLog?.status).toBe(404);
    const missingOrgSum = await request(
      `/orgs/missing-${crypto.randomUUID()}/usage/log/sum?from=${now - 1_000}&to=${now + 1_000}`,
    );
    expect(missingOrgSum?.status).toBe(404);

    const cleared = await request(`/orgs/${org.id}/usage/users/${userId}/limits`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limits: [] }),
    });
    await expect(cleared?.json()).resolves.toMatchObject({ limits: [], status: { reason: "no_limits" } });
  });

  it("accepts contract-valid high-magnitude decimal values", async () => {
    const { userId } = await createUser(
      testEnv,
      `usage-api-precision-${crypto.randomUUID()}@example.test`,
      "password123",
      "Usage Precision User",
    );
    const { org } = await createOrg(testEnv, "Usage Precision Org", userId);
    const pricing = await request(`/orgs/${org.id}/usage/pricing`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prices: [{
        provider: "custom",
        model: "precision-model",
        input_usd_per_million: 549225.806759,
        output_usd_per_million: 1,
      }] }),
    });
    expect(pricing?.status).toBe(200);

    const limits = await request(`/orgs/${org.id}/usage/users/${userId}/limits`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limits: [{
        window_hours: 35543.60400583333,
        limit_usd: 553045650.474688,
      }] }),
    });
    expect(limits?.status).toBe(200);
  });

  it("preserves the admin wrapper authentication contract", async () => {
    const openApi = await request("/openapi.json");
    expect(openApi?.status).toBe(200);
    const document = await openApi?.json() as { paths?: Record<string, unknown> };
    expect(document.paths).toHaveProperty("/api/admin/orgs/{id}/usage/users");
    expect(document.paths).toHaveProperty("/api/admin/orgs/{id}/usage/users/{userId}/limits");
    expect(document.paths).toHaveProperty("/api/admin/orgs/{id}/usage/pricing");

    const noBearer = new Request("http://example.test/api/admin/orgs/x/usage/pricing");
    await expect(handleAdminApi({
      req: noBearer,
      env: workerEnv(),
      ctx: {} as ExecutionContext,
      url: new URL(noBearer.url),
      match: noBearer.url.match(/^.*$/)!,
    })).resolves.toBeNull();

    const wrong = await request("/orgs/x/usage/pricing", {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(wrong?.status).toBe(401);

    const missing = await request("/orgs/x/usage/pricing", {}, workerEnv({ ADMIN_API_KEY: undefined }));
    expect(missing?.status).toBe(503);
  });
});
