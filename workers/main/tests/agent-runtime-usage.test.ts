import { describe, expect, it, vi } from "vitest";

import { handleAgentRuntimeUsageRequest, usageRowFor, verifyStandardWebhook, type RuntimeUsageEvent } from "../src/routes/agent-runtime-usage";
import type { Env } from "../src/types";

const KEY = new Uint8Array(32).map((_, index) => index + 1);
const SECRET = `whsec_${btoa(String.fromCharCode(...KEY))}`;

async function sign(id: string, timestamp: number, body: string, key = KEY) {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(`${id}.${timestamp}.${body}`)));
  return `v1,${btoa(String.fromCharCode(...signature))}`;
}

async function webhook(body: string, overrides: { id?: string; timestamp?: number; signature?: string } = {}) {
  const id = overrides.id ?? "msg_1";
  const timestamp = overrides.timestamp ?? Math.floor(Date.now() / 1000);
  return new Request("https://camel.test/agent-runtime/usage", {
    method: "POST",
    headers: {
      "webhook-id": id,
      "webhook-timestamp": String(timestamp),
      "webhook-signature": overrides.signature ?? await sign(id, timestamp, body),
      "content-type": "application/json",
    },
    body,
  });
}

const event: RuntimeUsageEvent = {
  id: "use_1",
  agent: "client_1",
  requestId: "r1",
  tenant: "chiridion",
  subject: "user1",
  actor: "user2",
  context: { org: "org1", workspace: "ws1", thread: "t1" },
  keyScope: "hosted",
  provider: "openrouter",
  model: "anthropic/claude-sonnet-5:nitro",
  kind: "turn",
  input: 12,
  output: 30,
  cacheRead: 2000,
  cacheWrite: 10,
  cost: { usd: 0.0042, source: "provider" },
  at: 1_790_000_000_000,
};

describe("verifyStandardWebhook", () => {
  it("accepts the runtime's signature and refuses a wrong, stale or missing one", async () => {
    const body = JSON.stringify(event);
    const now = Math.floor(Date.now() / 1000);
    const headers = async (signature: string, timestamp = now) => new Headers({ "webhook-id": "msg_1", "webhook-timestamp": String(timestamp), "webhook-signature": signature });
    expect(await verifyStandardWebhook(SECRET, await headers(await sign("msg_1", now, body)), body)).toBe(true);
    // One of several signatures (a key rotation) is enough.
    expect(await verifyStandardWebhook(SECRET, await headers(`v1,bogus ${await sign("msg_1", now, body)}`), body)).toBe(true);
    expect(await verifyStandardWebhook(SECRET, await headers(await sign("msg_1", now, body, new Uint8Array(32))), body)).toBe(false);
    expect(await verifyStandardWebhook(SECRET, await headers(await sign("msg_1", now - 3600, body), now - 3600), body)).toBe(false);
    expect(await verifyStandardWebhook(SECRET, new Headers(), body)).toBe(false);
  });
});

describe("usageRowFor", () => {
  it("bills hosted usage as camelAI's, as the acting user, keyed by the event id", () => {
    expect(usageRowFor(event, { billing_status: "active" })).toMatchObject({
      workspace_id: "ws1",
      user_id: "user2",
      thread_id: "t1",
      provider: "openrouter",
      model: "anthropic/claude-sonnet-5:nitro",
      billing_source: "hosted",
      credit_chargeable: true,
      usage_surface: "agent",
      input_tokens: 12,
      output_tokens: 30,
      cache_read_input_tokens: 2000,
      cache_creation_input_tokens: 10,
      reported_cost_usd: 0.0042,
      source: "agent_runtime",
      source_id: "use_1",
    });
  });

  it("does not charge credits for the free tier, enterprise orgs, BYOK or Codex", () => {
    expect(usageRowFor({ ...event, provider: "openrouter", model: "openai/gpt-6-luna" }, { billing_status: "active" }).credit_chargeable).toBe(false);
    expect(usageRowFor(event, { billing_status: "enterprise" }).credit_chargeable).toBe(false);
    expect(usageRowFor({ ...event, keyScope: "org_org1", provider: "anthropic", model: "claude-opus-5", cost: { usd: 0.01, source: "catalog" } }, null))
      .toMatchObject({ billing_source: "byok", credit_chargeable: false, estimated_cost_usd: 0.01 });
    expect(usageRowFor({ ...event, keyScope: null, provider: "chiridion", model: "openai-codex/gpt-5.6-sol", actor: undefined }, null))
      .toMatchObject({ billing_source: "byok", provider: "openai", model: "gpt-5.6-sol", user_id: "user1" });
    expect(usageRowFor({ ...event, kind: "compaction" }, null).usage_surface).toBe("compaction");
  });
});

describe("handleAgentRuntimeUsageRequest", () => {
  function fakeEnv() {
    const recordUsage = vi.fn(async () => ({ id: 1, cost_usd: 0, inserted: true }));
    const env = {
      AGENT_RUNTIME_WEBHOOK_SECRET: SECRET,
      AGENT_RUNTIME_TENANT: "chiridion",
      ORG: {
        idFromName: (name: string) => name,
        get: () => ({ getInfo: async () => ({ billing_status: "active" }), recordUsage }),
      },
    } as unknown as Env;
    return { env, recordUsage };
  }

  it("records a signed event in the org of its context", async () => {
    const { env, recordUsage } = fakeEnv();
    const response = await handleAgentRuntimeUsageRequest(await webhook(JSON.stringify(event)), env);
    expect(response.status).toBe(204);
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ source: "agent_runtime", source_id: "use_1", user_id: "user2", credit_chargeable: true }));
  });

  it("refuses an unsigned event, and acknowledges (without billing) one for another tenant", async () => {
    const { env, recordUsage } = fakeEnv();
    const body = JSON.stringify(event);
    expect((await handleAgentRuntimeUsageRequest(await webhook(body, { signature: "v1,bad" }), env)).status).toBe(401);
    expect((await handleAgentRuntimeUsageRequest(await webhook(JSON.stringify({ ...event, tenant: "other" })), env)).status).toBe(204);
    expect(recordUsage).not.toHaveBeenCalled();
  });
});
