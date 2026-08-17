import { describe, expect, it, vi } from "vitest";
import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { OrgUsageControls } from "../src/identity/org/usage-controls";
import { createOrg, createUser, type TestEnv } from "./test-helpers";

const testEnv = env as unknown as TestEnv;

function email(label: string): string {
  return `${label}-${crypto.randomUUID()}@example.test`;
}

describe("OrgDO per-user LLM usage controls", () => {
  it("keeps a 1,000-subject report page with multi-window policies to bounded SQL queries", () => {
    const subjects = Array.from({ length: 1_000 }, (_, index) => ({
      user_id: `user-${String(index).padStart(4, "0")}`,
      current_member: 1,
    }));
    const limitRows = subjects.slice(0, 3).flatMap(({ user_id }) => [
      { user_id, window_ms: 3_600_000, limit_microusd: 1_000_000, label: "hourly" },
      { user_id, window_ms: 86_400_000, limit_microusd: 5_000_000, label: "daily" },
    ]);
    const aggregateRows = limitRows.map(({ user_id, window_ms }, index) => ({
      user_id, window_ms, spent: index === 0 ? 1_000_000 : 0, unpriced: 0,
    }));
    const exec = vi.fn((sql: string) => ({
      toArray: () => {
        if (sql.includes("WITH subjects(user_id)")) return subjects;
        if (sql.includes("expiry_candidates")) {
          return [{ user_id: "user-0000", window_ms: 3_600_000, retry_at_ms: 3_600_001 }];
        }
        if (sql.includes("SELECT limits.user_id")) return aggregateRows;
        if (sql.includes("FROM user_llm_usage_limits") && sql.includes("ORDER BY user_id")) return limitRows;
        return [];
      },
    }));
    const controls = new OrgUsageControls({
      sql: { exec } as unknown as SqlStorage,
      orgId: () => "org-scale",
      isCurrentMember: () => true,
      transactionSync: (callback) => callback(),
    });

    const report = controls.getUserReport({ from: 1, to: 2, limit: 1_000, now_ms: 2 });
    expect(report.count).toBe(1_000);
    expect(report.users[0]).toMatchObject({
      membership_status: "current",
      totals: { requests: 0 },
      limit_status: { reason: "limit_exceeded", limits: [{ label: "hourly" }, { label: "daily" }] },
    });
    expect(report.users[999].limit_status.reason).toBe("no_limits");
    expect(exec).toHaveBeenCalledTimes(6);
    const expirySql = exec.mock.calls.map(([sql]) => sql).find((sql) => sql.includes("expiry_candidates"));
    expect(expirySql).toContain("GROUP BY user_id, window_ms");
  });

  it("migrates and idempotently re-enters a real version-51 usage ledger", async () => {
    const { userId } = await createUser(testEnv, email("migration-owner"), "password123", "Migration Owner");
    const { org } = await createOrg(testEnv, "Usage Migration", userId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    await orgStub.recordUsage({
      user_id: userId, provider: "anthropic", model: "claude-sonnet-5",
      usage_kind: "llm", usage_surface: "agent", cost_usd: 1,
      source: "pi_assistant", source_id: "legacy-pi",
    });
    await orgStub.recordUsage({
      user_id: userId, provider: "camelai", model: "web-search",
      usage_kind: "capability", usage_surface: "capability", cost_usd: 2,
      billing_source: "hosted_capability", source: "web_search", source_id: "legacy-capability",
    });
    await orgStub.recordUsage({
      user_id: userId, provider: "custom", model: "legacy-virtual",
      usage_kind: "llm", usage_surface: "virtual_ai", cost_usd: 3,
      thread_id: "virtual-ai", source: "virtual_ai", source_id: "legacy-virtual",
    });
    await orgStub.recordUsage({
      user_id: userId, provider: "openrouter", model: "dynamic/auto_image",
      usage_kind: "image", usage_surface: "auxiliary", cost_usd: 4,
      thread_id: "virtual-ai", source: "virtual_ai", source_id: "legacy-auto-image",
    });
    await orgStub.recordUsage({
      user_id: userId, provider: "openrouter", model: "google/gemini-2.5-flash-image-preview",
      usage_kind: "image", usage_surface: "auxiliary", cost_usd: 5,
      thread_id: "virtual-ai", source: "virtual_ai", source_id: "legacy-concrete-image-response",
    });
    await runInDurableObject(orgStub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("DROP TABLE user_llm_usage_limits");
      sql.exec("DROP TABLE llm_model_pricing_overrides");
      sql.exec("DROP INDEX idx_usage_log_user_created_at");
      sql.exec("DROP INDEX idx_usage_log_user_model_created_at");
      sql.exec("ALTER TABLE usage_log DROP COLUMN usage_kind");
      sql.exec("ALTER TABLE usage_log DROP COLUMN usage_surface");
      sql.exec("ALTER TABLE usage_log DROP COLUMN metered_cost_microusd");
      sql.exec("ALTER TABLE usage_log DROP COLUMN cost_source");
      state.storage.kv.put("schemaVersion", 51);
    });
    await evictDurableObject(orgStub);

    const migrated = await orgStub.getUsageLog({ user_id: userId, limit: 10 });
    expect(migrated.entries.map((entry) => ({
      source: entry.source,
      kind: entry.usage_kind,
      surface: entry.usage_surface,
      metered: entry.metered_cost_usd,
      costSource: entry.cost_source,
    }))).toEqual([
      { source: "virtual_ai", kind: "unknown", surface: "virtual_ai", metered: 5, costSource: "legacy_estimate" },
      { source: "virtual_ai", kind: "image", surface: "auxiliary", metered: 4, costSource: "legacy_estimate" },
      { source: "virtual_ai", kind: "unknown", surface: "virtual_ai", metered: 3, costSource: "legacy_estimate" },
      { source: "web_search", kind: "capability", surface: "capability", metered: 2, costSource: "legacy_estimate" },
      { source: "pi_assistant", kind: "llm", surface: "agent", metered: 1, costSource: "legacy_estimate" },
    ]);
    await runInDurableObject(orgStub, (_instance, state) => {
      const indexes = state.storage.sql.exec<{ name: string }>("PRAGMA index_list(usage_log)").toArray();
      expect(indexes.map((index) => index.name)).toEqual(expect.arrayContaining([
        "idx_usage_log_user_created_at",
        "idx_usage_log_user_model_created_at",
      ]));
      expect(state.storage.kv.get("schemaVersion")).toBe(52);
    });
    await evictDurableObject(orgStub);
    const reentered = await orgStub.getUsageLog({ user_id: userId, limit: 10 });
    expect(reentered.entries).toEqual(migrated.entries);
  });

  it("enforces settled micro-USD spend, strict pricing, and idempotent rows", async () => {
    const { userId } = await createUser(testEnv, email("usage-owner"), "password123", "Usage Owner");
    const { org, defaultWorkspaceId } = await createOrg(testEnv, "Usage Limits", userId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    const now = 1_800_000_000_000;

    await expect(orgStub.checkUserLlmUsageAccess({
      user_id: userId,
      provider: "custom",
      model: "acme-code-70b",
      now_ms: now,
    })).resolves.toMatchObject({ allowed: true, reason: "no_limits" });

    await orgStub.setUserLlmUsageLimits(userId, [
      { window_hours: 24, limit_usd: 1, label: "daily" },
      { window_hours: 720, limit_usd: 10, label: "30-day" },
    ]);

    await expect(orgStub.checkUserLlmUsageAccess({
      user_id: userId,
      provider: "custom",
      model: "acme-code-70b",
      now_ms: now,
    })).resolves.toMatchObject({ allowed: false, reason: "pricing_unavailable" });
    await expect(orgStub.checkUserLlmUsageAccess({
      user_id: userId,
      provider: "custom",
      model: "acme-claude-sonnet-5-local",
      now_ms: now,
    })).resolves.toMatchObject({ allowed: false, reason: "pricing_unavailable" });
    await expect(orgStub.checkUserLlmUsageAccess({
      user_id: userId,
      provider: "custom",
      model: "gpt-5.6-terra-finetune",
      now_ms: now,
    })).resolves.toMatchObject({ allowed: false, reason: "pricing_unavailable" });
    await expect(orgStub.checkUserLlmUsageAccess({
      user_id: userId,
      provider: "openai",
      model: "acme-claude-sonnet-5-local",
      now_ms: now,
    })).resolves.toMatchObject({ allowed: false, reason: "pricing_unavailable" });
    await expect(orgStub.checkUserLlmUsageAccess({
      user_id: userId,
      provider: "bedrock",
      model: "anthropic.claude-haiku-4-5",
      now_ms: now,
    })).resolves.toMatchObject({ allowed: true, reason: "within_limits" });
    for (const model of ["openai.gpt-5.6-sol", "openai.gpt-5.6-terra"]) {
      await expect(orgStub.checkUserLlmUsageAccess({
        user_id: userId,
        provider: "bedrock",
        model,
        now_ms: now,
      })).resolves.toMatchObject({ allowed: true, reason: "within_limits" });
    }

    await orgStub.setLlmUsagePricing([{
      provider: "custom",
      model: "acme-code-70b",
      input_usd_per_million: 0,
      output_usd_per_million: 0,
    }]);
    await expect(orgStub.checkUserLlmUsageAccess({
      user_id: userId,
      provider: "another-provider",
      model: "acme-code-70b",
      now_ms: now,
    })).resolves.toMatchObject({ allowed: false, reason: "pricing_unavailable" });
    await expect(orgStub.checkUserLlmUsageAccess({
      user_id: userId,
      provider: "custom",
      model: "acme-code-70b",
      now_ms: now,
    })).resolves.toMatchObject({ allowed: true, reason: "within_limits" });

    const usage = {
      workspace_id: defaultWorkspaceId,
      user_id: userId,
      thread_id: "thread-1",
      provider: "custom",
      model: "acme-code-70b",
      usage_kind: "llm" as const,
      usage_surface: "agent" as const,
      input_tokens: 100,
      output_tokens: 20,
      reported_cost_usd: 1.25,
      created_at_ms: now - 1_000,
      source: "pi_assistant",
      source_id: "response-1",
    };
    await orgStub.recordUsage(usage);
    await orgStub.recordUsage(usage);

    const access = await orgStub.checkUserLlmUsageAccess({
      user_id: userId,
      provider: "custom",
      model: "acme-code-70b",
      now_ms: now,
    });
    expect(access).toMatchObject({ allowed: false, reason: "limit_exceeded" });
    expect(access.blocking_limit).toMatchObject({
      label: "daily",
      spent_usd: 1.25,
      limit_usd: 1,
      retry_at_ms: now - 1_000 + 24 * 60 * 60 * 1000 + 1,
    });
    await expect(orgStub.checkUserLlmUsageAccess({
      user_id: userId,
      provider: "custom",
      model: "acme-code-70b",
      now_ms: access.blocking_limit!.retry_at_ms!,
    })).resolves.toMatchObject({ allowed: true, reason: "within_limits" });

    const aggregate = await orgStub.getUsageLogAggregate({
      from: now - 10_000,
      to: now,
      user_id: userId,
      usage_kind: "llm",
    });
    expect(aggregate).toMatchObject({
      total_requests: 1,
      metered_cost_usd: 1.25,
      unpriced_requests: 0,
      total_input_tokens: 100,
      total_output_tokens: 20,
    });
  });

  it("excludes capability spend and uses half-open rolling-window boundaries", async () => {
    const { userId } = await createUser(testEnv, email("boundary-owner"), "password123", "Boundary Owner");
    const { org } = await createOrg(testEnv, "Usage Boundaries", userId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    const now = 1_805_000_000_000;
    await orgStub.setUserLlmUsageLimits(userId, [{ window_hours: 1, limit_usd: 1 }]);
    await orgStub.recordUsage({
      user_id: userId,
      provider: "camelai",
      model: "web-search",
      usage_kind: "capability",
      usage_surface: "capability",
      cost_usd: 100,
      created_at_ms: now - 100,
      source: "web_search",
      source_id: "capability-row",
    });
    await orgStub.recordUsage({
      user_id: userId,
      provider: "anthropic",
      model: "claude-sonnet-5",
      usage_kind: "llm",
      usage_surface: "agent",
      reported_cost_usd: 1,
      created_at_ms: now - 60 * 60 * 1000,
      source: "pi_assistant",
      source_id: "boundary-row",
    });

    await expect(orgStub.checkUserLlmUsageAccess({
      user_id: userId,
      provider: "anthropic",
      model: "claude-sonnet-5",
      now_ms: now,
    })).resolves.toMatchObject({ allowed: false, reason: "limit_exceeded" });
    await expect(orgStub.checkUserLlmUsageAccess({
      user_id: userId,
      provider: "anthropic",
      model: "claude-sonnet-5",
      now_ms: now + 1,
    })).resolves.toMatchObject({ allowed: true, reason: "within_limits" });
  });

  it("reports the latest blocking retry when multiple rolling windows are exceeded", async () => {
    const { userId } = await createUser(testEnv, email("multi-window-owner"), "password123", "Multi Window Owner");
    const { org } = await createOrg(testEnv, "Multi Window Limits", userId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    const now = 1_807_000_000_000;
    const createdAt = now - 1_000;
    await orgStub.setUserLlmUsageLimits(userId, [
      { window_hours: 1, limit_usd: 1, label: "hourly" },
      { window_hours: 24, limit_usd: 2, label: "daily" },
    ]);
    await orgStub.recordUsage({
      user_id: userId,
      provider: "anthropic",
      model: "claude-sonnet-5",
      usage_kind: "llm",
      usage_surface: "agent",
      reported_cost_usd: 3,
      created_at_ms: createdAt,
      source: "pi_assistant",
      source_id: "multi-window-row",
    });

    const access = await orgStub.checkUserLlmUsageAccess({
      user_id: userId,
      provider: "anthropic",
      model: "claude-sonnet-5",
      now_ms: now,
    });
    expect(access).toMatchObject({
      allowed: false,
      reason: "limit_exceeded",
      blocking_limit: {
        label: "daily",
        retry_at_ms: createdAt + 24 * 60 * 60 * 1000 + 1,
      },
    });
    await expect(orgStub.checkUserLlmUsageAccess({
      user_id: userId,
      provider: "anthropic",
      model: "claude-sonnet-5",
      now_ms: createdAt + 60 * 60 * 1000 + 1,
    })).resolves.toMatchObject({ allowed: false, reason: "limit_exceeded" });
    await expect(orgStub.checkUserLlmUsageAccess({
      user_id: userId,
      provider: "anthropic",
      model: "claude-sonnet-5",
      now_ms: access.blocking_limit!.retry_at_ms!,
    })).resolves.toMatchObject({ allowed: true, reason: "within_limits" });
  });

  it("reports current, former, and unattributed subjects and clears removed-member limits", async () => {
    const { userId: ownerId } = await createUser(testEnv, email("report-owner"), "password123", "Report Owner");
    const { userId: memberId } = await createUser(testEnv, email("report-member"), "password123", "Report Member");
    const { org } = await createOrg(testEnv, "Usage Report", ownerId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    const now = 1_810_000_000_000;
    await orgStub.addMember(memberId, "member", ownerId);
    await orgStub.setUserLlmUsageLimits(memberId, [{ window_hours: 1, limit_usd: 2 }]);
    await orgStub.recordUsage({
      user_id: memberId,
      provider: "anthropic",
      model: "claude-sonnet-5",
      usage_kind: "llm",
      usage_surface: "subagent",
      input_tokens: 10,
      output_tokens: 5,
      reported_cost_usd: 0.25,
      created_at_ms: now - 100,
      source: "pi_assistant",
      source_id: "member-row",
    });
    await orgStub.recordUsage({
      user_id: "",
      provider: "anthropic",
      model: "claude-sonnet-5",
      usage_kind: "llm",
      usage_surface: "virtual_ai",
      input_tokens: 3,
      output_tokens: 2,
      reported_cost_usd: 0.1,
      created_at_ms: now - 50,
      source: "virtual_ai",
      source_id: "unattributed-row",
    });

    await orgStub.removeMember(memberId, ownerId);
    expect((await orgStub.getUserLlmUsageLimits(memberId)).limits).toEqual([]);
    const report = await orgStub.getUserLlmUsageReport({
      from: now - 1_000,
      to: now,
      now_ms: now,
    });
    expect(report.users.map((user) => [user.user_id, user.membership_status])).toEqual([
      [null, "unattributed"],
      [ownerId, "current"],
      [memberId, "former"],
    ].sort((left, right) => {
      if (left[0] === null) return -1;
      if (right[0] === null) return 1;
      return String(left[0]).localeCompare(String(right[0]));
    }));
    expect(report.users.find((user) => user.user_id === ownerId)?.totals.requests).toBe(0);
    expect(report.users.find((user) => user.user_id === memberId)?.models[0]).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-5",
      requests: 1,
      spend_usd: 0.25,
    });
    expect(report.users.find((user) => user.user_id === null)?.totals.requests).toBe(1);
  });

  it("preserves historical row pricing after override replacement", async () => {
    const { userId } = await createUser(testEnv, email("validation-owner"), "password123", "Validation Owner");
    const { org } = await createOrg(testEnv, "Usage Validation", userId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    await orgStub.setLlmUsagePricing([{
      provider: "custom", model: "snapshot-model",
      input_usd_per_million: 1, output_usd_per_million: 2,
    }]);
    await orgStub.recordUsage({
      user_id: userId, provider: "custom", model: "snapshot-model",
      usage_kind: "llm", usage_surface: "agent",
      input_tokens: 1_000_000, output_tokens: 1_000_000,
      reported_cost_usd: 0,
      upstream_inference_cost_usd: 0,
      source: "pi_assistant", source_id: "snapshot-row",
    });
    await orgStub.setLlmUsagePricing([{
      provider: "custom", model: "snapshot-model",
      input_usd_per_million: 10, output_usd_per_million: 20,
    }]);
    const page = await orgStub.getUsageLog({ user_id: userId, model: "snapshot-model" });
    expect(page.entries[0]).toMatchObject({
      metered_cost_usd: 3,
      cost_source: "org_override",
      usage_kind: "llm",
      usage_surface: "agent",
    });
  });

  it("treats zero reported-cost placeholders as absent for strict pricing", async () => {
    const { userId } = await createUser(testEnv, email("zero-cost-owner"), "password123", "Zero Cost Owner");
    const { org } = await createOrg(testEnv, "Zero Cost Pricing", userId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    await orgStub.recordUsage({
      user_id: userId,
      provider: "anthropic",
      model: "claude-sonnet-5",
      usage_kind: "llm",
      usage_surface: "agent",
      input_tokens: 1_000_000,
      reported_cost_usd: 0,
      upstream_inference_cost_usd: 0,
      source: "pi_assistant",
      source_id: "zero-reported-builtin",
    });

    const page = await orgStub.getUsageLog({ user_id: userId });
    expect(page.entries[0].cost_source).toBe("builtin_pricing");
    expect(page.entries[0].metered_cost_usd).toBeGreaterThan(0);
  });

  it("uses provider total cost without adding its upstream component", async () => {
    const { userId } = await createUser(testEnv, email("provider-cost-owner"), "password123", "Provider Cost Owner");
    const { org } = await createOrg(testEnv, "Provider Cost", userId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    await orgStub.recordUsage({
      user_id: userId,
      provider: "openrouter",
      model: "openai/gpt-5.6-luna",
      usage_kind: "llm",
      usage_surface: "agent",
      input_tokens: 10,
      reported_cost_usd: 0.0012,
      upstream_inference_cost_usd: 0.0048,
      source: "pi_assistant",
      source_id: "provider-total-not-component-sum",
    });

    const page = await orgStub.getUsageLog({ user_id: userId });
    expect(page.entries[0]).toMatchObject({
      metered_cost_usd: 0.0012,
      cost_source: "provider_reported",
    });
  });

  it("settles Bedrock GPT request ids with built-in pricing", async () => {
    const { userId } = await createUser(testEnv, email("bedrock-gpt-owner"), "password123", "Bedrock GPT Owner");
    const { org } = await createOrg(testEnv, "Bedrock GPT Pricing", userId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    for (const model of ["openai.gpt-5.6-sol", "openai.gpt-5.6-terra"]) {
      await orgStub.recordUsage({
        user_id: userId,
        provider: "bedrock",
        model,
        usage_kind: "llm",
        usage_surface: "agent",
        input_tokens: 100_000,
        source: "pi_assistant",
        source_id: `bedrock-pricing-${model}`,
      });
    }

    const page = await orgStub.getUsageLog({ user_id: userId, limit: 10 });
    expect(page.entries).toHaveLength(2);
    expect(page.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        model: "openai.gpt-5.6-sol",
        cost_source: "builtin_pricing",
        metered_cost_usd: 0.5,
      }),
      expect.objectContaining({
        model: "openai.gpt-5.6-terra",
        cost_source: "builtin_pricing",
        metered_cost_usd: 0.2,
      }),
    ]));
  });
});
