import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { handleAdminApi } from "../src/routes/admin/index";
import { ChatThreadDO } from "../src/durable-objects";
import type { Env as WorkerEnv } from "../src/types";
import { createOrg, createUser, type TestEnv } from "./test-helpers";

const testEnv = env as unknown as TestEnv;

function testEmail() {
  return `usage-backfill-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

async function adminPostBackfill(body: unknown, legacyFetch: Fetcher["fetch"]) {
  const request = new Request("http://example/api/admin/usage/backfill-host", {
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
      SANDBOX_HOST: { fetch: legacyFetch } as unknown as Fetcher,
    } as unknown as WorkerEnv,
    ctx: {} as ExecutionContext,
    url: new URL(request.url),
    match: request.url.match(/^.*$/)!,
  });
  if (!response) {
    throw new Error("Admin API did not handle request");
  }
  return response;
}

describe("admin API host usage backfill", () => {
  it("copies legacy sandbox-host usage rows into OrgDO idempotently", async () => {
    const { userId } = await createUser(
      testEnv,
      testEmail(),
      "password123",
      "Usage Backfill User",
    );
    const { org } = await createOrg(testEnv, "Usage Backfill Org", userId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    const createdAt = Date.now() - 60_000;
    const legacyFetch = vi.fn(async (request: Request | string) => {
      const url = new URL(typeof request === "string" ? request : request.url);
      expect(url.pathname).toBe(`/v1/usage/orgs/${org.id}/log`);
      return Response.json({
        org_id: org.id,
        entries: [
          {
            id: 42,
            workspace_id: "workspace-1",
            user_id: userId,
            thread_id: "thread-1",
            model: "openai/gpt-5.5",
            provider: "openai",
            billing_source: "hosted",
            credit_chargeable: 1,
            input_tokens: 100,
            output_tokens: 20,
            cache_creation_input_tokens: 3,
            cache_read_input_tokens: 4,
            cost_usd: 1.23,
            duration_ms: 456,
            created_at_ms: createdAt,
          },
        ],
        count: 1,
        has_more: false,
        next_cursor: null,
      });
    });

    const first = await adminPostBackfill(
      { org_ids: [org.id], page_limit: 1000 },
      legacyFetch,
    );

    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      dry_run: false,
      orgs_scanned: 1,
      legacy_entries_scanned: 1,
      inserted: 1,
      skipped_duplicates: 0,
      errors: [],
      truncated: false,
    });
    await expect(
      orgStub.getUsageLogSum(0, Date.now(), true),
    ).resolves.toMatchObject({
      total_cost_usd: 1.23,
      total_requests: 1,
      total_input_tokens: 100,
      total_output_tokens: 20,
    });

    const second = await adminPostBackfill(
      { org_ids: [org.id], page_limit: 1000 },
      legacyFetch,
    );

    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      inserted: 0,
      skipped_duplicates: 1,
    });
    await expect(
      orgStub.getUsageLogSum(0, Date.now(), true),
    ).resolves.toMatchObject({
      total_cost_usd: 1.23,
      total_requests: 1,
    });
  });

  it("runs legacy usage backfill before hosted Pi credit enforcement", async () => {
    const { userId } = await createUser(
      testEnv,
      testEmail(),
      "password123",
      "Usage Gate User",
    );
    const { org } = await createOrg(testEnv, "Usage Gate Org", userId, {
      billingPlan: "starter",
    });
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    await orgStub.updateBillingState({
      billing_status: "active",
      billing_credit_purchase_total_cents: 200,
      billing_credit_grant_total_cents: 0,
    });
    const legacyFetch = vi.fn(async () =>
      Response.json({
        org_id: org.id,
        entries: [
          {
            id: 77,
            workspace_id: "workspace-1",
            user_id: userId,
            thread_id: "thread-1",
            model: "openai/gpt-5.5",
            provider: "openrouter",
            billing_source: "hosted",
            credit_chargeable: 1,
            input_tokens: 10,
            output_tokens: 20,
            cost_usd: 1.23,
            created_at_ms: Date.now() - 10_000,
          },
        ],
        has_more: false,
        next_cursor: null,
      })
    );
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {
      ...testEnv,
      SANDBOX_HOST: { fetch: legacyFetch } as unknown as Fetcher,
    };
    fake.formatCreditCents = ChatThreadDO.prototype["formatCreditCents"];

    await expect(
      ChatThreadDO.prototype["checkHostedPiModelAccess"].call(fake, {
        orgId: org.id,
      }),
    ).resolves.toBe(true);
    await expect(orgStub.getUsageLogSum(0, Date.now(), true)).resolves.toMatchObject({
      total_cost_usd: 1.23,
      total_requests: 1,
    });

    await expect(
      ChatThreadDO.prototype["checkHostedPiModelAccess"].call(fake, {
        orgId: org.id,
      }),
    ).resolves.toBe(true);
    expect(legacyFetch).toHaveBeenCalledTimes(1);
  });
});
