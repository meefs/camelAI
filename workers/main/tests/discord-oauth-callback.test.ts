import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptCredentials } from "../../../src/lib/integration-crypto.js";
import { createIntegrationOAuthState } from "../src/integration-oauth-state.js";
import {
  discordBridgeIdentityMatches,
  discordOAuthTokenFailureStatus,
  handleDiscordOAuthCallback,
} from "../src/routes/discord-integrations.js";

const integrationRouteMocks = vi.hoisted(() => ({
  completeConnectionSetupPrompt: vi.fn(async () => undefined),
  hasConnectionSetupPromptContext: vi.fn((stateData: {
    extra_config?: Record<string, unknown>;
  }) => Boolean(
    stateData.extra_config?.chat_request_id && stateData.extra_config?.chat_thread_id,
  )),
}));

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
  hasConnectionSetupPromptContext: integrationRouteMocks.hasConnectionSetupPromptContext,
  completeConnectionSetupPrompt: integrationRouteMocks.completeConnectionSetupPrompt,
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Discord OAuth callback", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects any main, bridge application, or observed bot identity drift", () => {
    expect(discordBridgeIdentityMatches(
      "123456789012345678",
      { applicationId: "123456789012345678", botUserId: "123456789012345678" },
      "123456789012345678",
    )).toBe(true);
    expect(discordBridgeIdentityMatches(
      "123456789012345678",
      { applicationId: "223456789012345678", botUserId: "223456789012345678" },
      "223456789012345678",
    )).toBe(false);
    expect(discordBridgeIdentityMatches(
      "123456789012345678",
      { applicationId: "123456789012345678", botUserId: "223456789012345678" },
      "223456789012345678",
    )).toBe(false);
  });

  it("classifies token exchange failures without exposing provider descriptions or tokens", () => {
    expect(discordOAuthTokenFailureStatus(
      401,
      false,
      {
        error: "invalid_client",
        error_description: "Secret details must not be surfaced",
      },
    )).toBe("provider_invalid_client");
    expect(discordOAuthTokenFailureStatus(
      400,
      false,
      { error: "unsafe error with spaces" },
    )).toBe("provider_http_400");
    expect(discordOAuthTokenFailureStatus(
      200,
      true,
      { access_token: "sensitive-token", scope: "identify bot" },
    )).toBe("missing_guild");
    expect(discordOAuthTokenFailureStatus(
      200,
      true,
      {
        access_token: "sensitive-token",
        guild: { id: "guild-1" },
      },
    )).toBeNull();
    expect(discordOAuthTokenFailureStatus(
      200,
      true,
      {
        access_token: "sensitive-token",
        scope: "",
        guild: { id: "guild-1" },
      },
    )).toBeNull();
  });

  it("stores a pending native channel and routes chat setup to channel selection without completing it", async () => {
    const sessions = memoryKv();
    const createWorkspaceIntegration = vi.fn(async () => undefined);
    const orgStub = {
      getWorkspaceIntegration: vi.fn(async () => null),
      createWorkspaceIntegration,
      updateWorkspaceIntegration: vi.fn(async () => undefined),
    };
    const applicationId = "123456789012345678";
    const bridgeFetch = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/internal/v1/status") {
        return Response.json({
          ok: true,
          applicationId,
          botUserId: applicationId,
          gateway: { state: "ready" },
        });
      }
      return Response.json({
        ok: true,
        guild: { id: "guild-from-token", name: "Prompt Haiku" },
        botUserId: applicationId,
        contentMode: "mention_only",
        channels: [],
      });
    });
    const env = {
      DISCORD_CHANNEL_ENABLED: "true",
      DISCORD_CLIENT_ID: applicationId,
      DISCORD_CLIENT_SECRET: "test-discord-client-secret-value",
      DISCORD_BRIDGE: { fetch: bridgeFetch },
      INTEGRATION_SECRET_KEY: "integration-secret",
      SESSIONS: sessions,
      ORG: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => orgStub),
      },
    };
    const state = await createIntegrationOAuthState(
      sessions,
      "discord_channel",
      "workspace-1",
      "user-1",
      "/chat/thread-1",
      {
        org_id: "org-1",
        chat_request_id: "request-1",
        chat_thread_id: "thread-1",
        security_acknowledged_at: 123,
      },
    );
    const providerFetch = vi.fn(async () => Response.json({
      access_token: "short-lived-access-token",
      refresh_token: "short-lived-refresh-token",
      token_type: "Bearer",
      scope: "bot",
      guild: { id: "guild-from-token", name: "Prompt Haiku" },
    }));
    vi.stubGlobal("fetch", providerFetch);
    const url = new URL(
      `https://staging.camelai.dev/api/integrations/discord/callback?code=code-1&state=${state}&guild_id=untrusted-hint`,
    );

    const response = await handleDiscordOAuthCallback({
      req: new Request(url),
      env,
      url,
    } as never);

    expect(response.status).toBe(302);
    const destination = new URL(response.headers.get("location")!);
    expect(destination.pathname).toBe("/connections");
    expect(destination.searchParams.get("success")).toBe("discord_installed");
    expect(destination.searchParams.get("selected")).toBeTruthy();
    expect(destination.searchParams.get("return_to")).toBe("/chat/thread-1");
    expect(bridgeFetch).toHaveBeenCalledTimes(2);
    expect(bridgeFetch.mock.calls.map(([request]) => new URL(request.url).pathname))
      .toEqual(expect.arrayContaining([
        "/internal/v1/status",
        "/internal/v1/guilds/guild-from-token/channels",
      ]));
    expect(createWorkspaceIntegration).toHaveBeenCalledOnce();
    const args = createWorkspaceIntegration.mock.calls[0];
    expect(args[2]).toBe("discord_channel");
    expect(JSON.parse(args[6])).toMatchObject({
      schema_version: 1,
      status: "pending_channel",
      guild_id: "guild-from-token",
      guild_name: "Prompt Haiku",
      bot_user_id: applicationId,
      message_content_mode: "mention_only",
      security_acknowledged_at: 123,
      pending_setup: {
        request_id: "request-1",
        thread_id: "thread-1",
        return_path: "/chat/thread-1",
      },
    });
    expect(JSON.stringify(args)).not.toContain("short-lived-access-token");
    expect(JSON.stringify(args)).not.toContain("short-lived-refresh-token");
    await expect(decryptCredentials(args[7], "integration-secret")).resolves.toEqual({});
    expect(integrationRouteMocks.completeConnectionSetupPrompt).not.toHaveBeenCalled();
    expect(sessions.delete).toHaveBeenCalledOnce();
  });

  it("returns a denied OAuth attempt to chat without consuming the retryable state", async () => {
    const sessions = memoryKv();
    const state = await createIntegrationOAuthState(
      sessions,
      "discord_channel",
      "workspace-1",
      "user-1",
      "/chat/thread-1",
      { chat_request_id: "request-1", chat_thread_id: "thread-1" },
    );
    vi.mocked(sessions.delete).mockClear();
    const url = new URL(
      `https://staging.camelai.dev/api/integrations/discord/callback?error=access_denied&state=${state}`,
    );

    const response = await handleDiscordOAuthCallback({
      req: new Request(url),
      env: { SESSIONS: sessions },
      url,
    } as never);

    const destination = new URL(response.headers.get("location")!);
    expect(destination.pathname).toBe("/chat/thread-1");
    expect(destination.searchParams.get("error")).toBe("oauth_denied");
    expect(sessions.delete).not.toHaveBeenCalled();
    await expect(sessions.get(`integration_oauth_state:${state}`, "json"))
      .resolves.toMatchObject({ integration_type: "discord_channel" });
  });

  it("has no chat-completion side effect for a normal connections-page install", async () => {
    const sessions = memoryKv();
    const createWorkspaceIntegration = vi.fn(async () => undefined);
    const orgStub = {
      getWorkspaceIntegration: vi.fn(async () => null),
      createWorkspaceIntegration,
      updateWorkspaceIntegration: vi.fn(async () => undefined),
    };
    const applicationId = "123456789012345678";
    const env = {
      DISCORD_CHANNEL_ENABLED: "true",
      DISCORD_CLIENT_ID: applicationId,
      DISCORD_CLIENT_SECRET: "test-discord-client-secret-value",
      DISCORD_BRIDGE: {
        fetch: vi.fn(async (request: Request) => {
          const path = new URL(request.url).pathname;
          return path === "/internal/v1/status"
            ? Response.json({
                ok: true,
                applicationId,
                botUserId: applicationId,
                gateway: { state: "ready" },
              })
            : Response.json({
                ok: true,
                guild: { id: "guild-1", name: "Normal install" },
                botUserId: applicationId,
                contentMode: "full",
                channels: [],
              });
        }),
      },
      INTEGRATION_SECRET_KEY: "integration-secret",
      SESSIONS: sessions,
      ORG: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => orgStub),
      },
    };
    const state = await createIntegrationOAuthState(
      sessions,
      "discord_channel",
      "workspace-1",
      "user-1",
      "/connections",
      { org_id: "org-1" },
    );
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      access_token: "short-lived-token",
      scope: "bot",
      guild: { id: "guild-1", name: "Normal install" },
    })));
    const url = new URL(
      `https://staging.camelai.dev/api/integrations/discord/callback?code=code-1&state=${state}`,
    );

    const response = await handleDiscordOAuthCallback({
      req: new Request(url),
      env,
      url,
    } as never);

    const destination = new URL(response.headers.get("location")!);
    expect(destination.pathname).toBe("/connections");
    expect(destination.searchParams.has("return_to")).toBe(false);
    expect(integrationRouteMocks.completeConnectionSetupPrompt).not.toHaveBeenCalled();
    const config = JSON.parse(createWorkspaceIntegration.mock.calls[0]![6]);
    expect(config).not.toHaveProperty("pending_setup");
  });
});
