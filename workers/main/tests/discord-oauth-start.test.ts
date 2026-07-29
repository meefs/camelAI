import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDiscordAuthorizationUrl,
  handleDiscordOAuthStart,
} from "../src/routes/discord-integrations.js";
import {
  discordApplicationIdConfigured,
  discordChannelEnabled,
} from "../src/discord-types.js";

vi.mock("../src/helpers/auth.js", () => ({
  requireSession: vi.fn(async () => ({
    session: { user_id: "user-1", workspace_id: "workspace-1" },
  })),
}));

vi.mock("../src/routes/integrations.js", () => ({
  verifyWorkspaceManageConnectionsAccess: vi.fn(async () => ({
    ok: true,
    orgId: "org-1",
  })),
}));

function memoryKv(): KVNamespace {
  const values = new Map<string, string>();
  return {
    get: vi.fn(async (key: string, type?: string) => {
      const value = values.get(key) ?? null;
      return type === "json" && value ? JSON.parse(value) : value;
    }),
    put: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      values.delete(key);
    }),
  } as unknown as KVNamespace;
}

function healthyBridge(applicationId = "123456789012345678") {
  return {
    fetch: vi.fn(async () => Response.json({
      ok: true,
      applicationId,
      botUserId: applicationId,
      readiness: { ready: false, reason: "ingress_disabled" },
      gateway: {
        state: "ready",
        heartbeatIntervalMs: 45_000,
        lastHeartbeatAckAt: Date.now(),
      },
    })),
  };
}

describe("Discord OAuth start", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects placeholder IDs and incomplete static availability", () => {
    expect(discordApplicationIdConfigured("000000000000000000")).toBe(false);
    expect(discordApplicationIdConfigured("SET_IN_DISCORD_DEVELOPER_PORTAL")).toBe(false);
    expect(discordApplicationIdConfigured("123456789012345678")).toBe(true);
    expect(discordChannelEnabled({
      DISCORD_CHANNEL_ENABLED: "true",
      DISCORD_CLIENT_ID: "123456789012345678",
      DISCORD_CLIENT_SECRET: "short",
      DISCORD_BRIDGE: healthyBridge(),
    })).toBe(false);
  });

  it("builds the exact minimal guild-install authorization request", () => {
    const url = buildDiscordAuthorizationUrl({
      clientId: "application-1",
      redirectUri: "https://staging.camelai.dev/api/integrations/discord/callback",
      state: "state-1",
    });

    expect(url.origin + url.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "application-1",
      response_type: "code",
      redirect_uri: "https://staging.camelai.dev/api/integrations/discord/callback",
      scope: "bot",
      integration_type: "0",
      permissions: "309237763072",
      state: "state-1",
      prompt: "consent",
    });
    expect(url.searchParams.has("identify")).toBe(false);
    expect(url.searchParams.has("guilds")).toBe(false);
  });

  it("requires enabled bridge configuration and persists state before redirecting", async () => {
    const sessions = memoryKv();
    const env = {
      DISCORD_CHANNEL_ENABLED: "true",
      DISCORD_CLIENT_ID: "123456789012345678",
      DISCORD_CLIENT_SECRET: "test-discord-client-secret-value",
      DISCORD_BRIDGE: healthyBridge(),
      SESSIONS: sessions,
    };
    const url = new URL(
      "https://staging.camelai.dev/api/integrations/discord/oauth?redirect=/connections",
    );
    const response = await handleDiscordOAuthStart({
      req: new Request(url),
      env,
      url,
    } as never);

    expect(response.status).toBe(302);
    const destination = new URL(response.headers.get("location")!);
    expect(destination.searchParams.get("scope")).toBe("bot");
    expect(destination.searchParams.get("permissions")).toBe("309237763072");
    expect(sessions.put).toHaveBeenCalledOnce();
  });

  it("fails closed while the feature is dark", async () => {
    const url = new URL("https://staging.camelai.dev/api/integrations/discord/oauth");
    const response = await handleDiscordOAuthStart({
      req: new Request(url),
      env: {
        DISCORD_CHANNEL_ENABLED: "false",
        DISCORD_CLIENT_ID: "123456789012345678",
        DISCORD_CLIENT_SECRET: "test-discord-client-secret-value",
        DISCORD_BRIDGE: { fetch: vi.fn() },
      },
      url,
    } as never);

    expect(response.status).toBe(503);
  });

  it("fails closed when the configured bridge is not live-ready", async () => {
    const url = new URL("https://staging.camelai.dev/api/integrations/discord/oauth");
    const response = await handleDiscordOAuthStart({
      req: new Request(url),
      env: {
        DISCORD_CHANNEL_ENABLED: "true",
        DISCORD_CLIENT_ID: "123456789012345678",
        DISCORD_CLIENT_SECRET: "test-discord-client-secret-value",
        DISCORD_BRIDGE: {
          fetch: vi.fn(async () => Response.json({
            ok: true,
            applicationId: "123456789012345678",
            botUserId: "123456789012345678",
            readiness: { ready: false, reason: "gateway_disconnected" },
            gateway: {
              state: "reconnecting",
              heartbeatIntervalMs: 45_000,
              lastHeartbeatAckAt: Date.now(),
            },
          })),
        },
      },
      url,
    } as never);

    expect(response.status).toBe(503);
  });

  it("requires acknowledgement and signs chat prompt context into OAuth state", async () => {
    const sessions = memoryKv();
    const env = {
      DISCORD_CHANNEL_ENABLED: "true",
      DISCORD_CLIENT_ID: "123456789012345678",
      DISCORD_CLIENT_SECRET: "test-discord-client-secret-value",
      DISCORD_BRIDGE: healthyBridge(),
      SESSIONS: sessions,
    };
    const deniedUrl = new URL(
      "https://staging.camelai.dev/api/integrations/discord/oauth?redirect=/chat/thread-1&chat_request_id=request-1&chat_thread_id=thread-1",
    );
    const denied = await handleDiscordOAuthStart({
      req: new Request(deniedUrl),
      env,
      url: deniedUrl,
    } as never);
    expect(new URL(denied.headers.get("location")!).searchParams.get("error"))
      .toBe("security_acknowledgement_required");
    expect(sessions.put).not.toHaveBeenCalled();

    const acceptedUrl = new URL(`${deniedUrl}&security_acknowledged=true`);
    const accepted = await handleDiscordOAuthStart({
      req: new Request(acceptedUrl),
      env,
      url: acceptedUrl,
    } as never);
    expect(accepted.status).toBe(302);
    const persisted = JSON.parse(String(vi.mocked(sessions.put).mock.calls[0]?.[1]));
    expect(persisted).toMatchObject({
      integration_type: "discord_channel",
      redirect_url: "/chat/thread-1",
      extra_config: {
        chat_request_id: "request-1",
        chat_thread_id: "thread-1",
        org_id: "org-1",
      },
    });
    expect(persisted.extra_config.security_acknowledged_at).toEqual(expect.any(Number));
  });
});
