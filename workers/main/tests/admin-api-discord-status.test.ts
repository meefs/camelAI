import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { handleAdminApi } from "../src/routes/admin/index";
import type { Env as WorkerEnv } from "../src/types";
import type { TestEnv } from "./test-helpers";

const testEnv = env as unknown as TestEnv;
const applicationId = "123456789012345678";

async function discordStatus(bridgePayload: Record<string, unknown>): Promise<Response> {
  const request = new Request("https://camel.test/api/admin/discord/status", {
    headers: { Authorization: "Bearer test-admin-api-key" },
  });
  const response = await handleAdminApi({
    req: request,
    env: {
      ...testEnv,
      ADMIN_API_KEY: "test-admin-api-key",
      DISCORD_CHANNEL_ENABLED: "false",
      DISCORD_CLIENT_ID: applicationId,
      DISCORD_CLIENT_SECRET: "test-discord-client-secret-value",
      DISCORD_BRIDGE: {
        fetch: vi.fn(async () => Response.json({ ok: true, ...bridgePayload })),
      },
    } as unknown as WorkerEnv,
    ctx: {} as ExecutionContext,
    url: new URL(request.url),
    match: request.url.match(/^.*$/)!,
  });
  if (!response) throw new Error("Admin API did not handle Discord status");
  return response;
}

describe("admin Discord canary status", () => {
  it("accepts a healthy dark-launch Gateway without exposing secrets", async () => {
    const response = await discordStatus({
      applicationId,
      botUserId: applicationId,
      readiness: { ready: false, reason: "ingress_disabled" },
      gateway: {
        state: "ready",
        heartbeatIntervalMs: 45_000,
        lastHeartbeatAckAt: Date.now(),
      },
    });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("test-discord-client-secret-value");
    expect(JSON.parse(text)).toMatchObject({
      ok: true,
      main: {
        applicationId,
        featureEnabled: false,
        clientIdConfigured: true,
        clientSecretConfigured: true,
        bridgeBound: true,
      },
      bridge: { applicationId, botUserId: applicationId },
      issues: [],
    });
  });

  it("fails the canary on identity drift or disconnected Gateway health", async () => {
    const response = await discordStatus({
      applicationId: "223456789012345678",
      botUserId: "323456789012345678",
      readiness: { ready: false, reason: "gateway_disconnected" },
      gateway: {
        state: "reconnecting",
        heartbeatIntervalMs: 45_000,
        lastHeartbeatAckAt: 1,
      },
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        "application_id_mismatch",
        "bridge_bot_identity_mismatch",
        "gateway_not_ready",
        "gateway_heartbeat_stale",
      ]),
    });
  });
});
