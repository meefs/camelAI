import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { createOrg, createUser, type TestEnv } from "./test-helpers";

const testEnv = env as unknown as TestEnv;
const testEmail = () =>
  `capability-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

describe("OrgDO capability allowances", () => {
  it("atomically consumes per-user daily allowance with idempotent retries", async () => {
    const { userId } = await createUser(testEnv, testEmail(), "password", "Owner");
    const { org } = await createOrg(testEnv, "Capability Org", userId, {
      billingPlan: "payg",
    });
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    const now = Date.parse("2026-07-15T12:00:00.000Z");

    const first = await orgStub.consumeCapabilityAllowance({
      capability: "oracle",
      user_id: userId,
      idempotency_key: "oracle:test-call",
      now_ms: now,
    });
    expect(first).toMatchObject({
      allowed: true,
      daily_limit: 100,
      used: 1,
      remaining: 99,
    });

    const retry = await orgStub.consumeCapabilityAllowance({
      capability: "oracle",
      user_id: userId,
      idempotency_key: "oracle:test-call",
      now_ms: now,
    });
    expect(retry).toMatchObject({ allowed: true, used: 1, remaining: 99 });

    for (let index = 1; index < 100; index += 1) {
      await orgStub.consumeCapabilityAllowance({
        capability: "oracle",
        user_id: userId,
        idempotency_key: `oracle:test-call-${index}`,
        now_ms: now,
      });
    }
    await expect(orgStub.consumeCapabilityAllowance({
      capability: "oracle",
      user_id: userId,
      idempotency_key: "oracle:over-limit",
      now_ms: now,
    })).resolves.toMatchObject({
      allowed: false,
      used: 100,
      remaining: 0,
    });

    const otherUser = await orgStub.consumeCapabilityAllowance({
      capability: "oracle",
      user_id: "another-user",
      idempotency_key: "oracle:test-call",
      now_ms: now,
    });
    expect(otherUser).toMatchObject({ allowed: true, used: 1, remaining: 99 });

    const otherCapability = await orgStub.consumeCapabilityAllowance({
      capability: "web_search",
      user_id: userId,
      idempotency_key: "oracle:test-call",
      now_ms: now,
    });
    expect(otherCapability).toMatchObject({ allowed: true, used: 1, remaining: 99 });

    const nextDay = await orgStub.consumeCapabilityAllowance({
      capability: "oracle",
      user_id: userId,
      idempotency_key: "oracle:tomorrow-call",
      now_ms: now + 24 * 60 * 60 * 1000,
    });
    expect(nextDay).toMatchObject({ allowed: true, used: 1, remaining: 99 });
  });

  it("does not meter enterprise capability calls", async () => {
    const { userId } = await createUser(testEnv, testEmail(), "password", "Owner");
    const { org } = await createOrg(testEnv, "Enterprise Capability Org", userId, {
      billingPlan: "payg",
    });
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    await orgStub.updateBillingState({
      billing_plan: "enterprise",
      billing_status: "enterprise",
    });

    await expect(orgStub.consumeCapabilityAllowance({
      capability: "research",
      user_id: userId,
    })).resolves.toMatchObject({
      allowed: true,
      daily_limit: null,
      remaining: null,
    });
  });
});
