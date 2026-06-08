import { afterEach, describe, expect, it, vi } from "vitest";
import { createIntegrationOAuthState } from "../src/integration-oauth-state.js";
import { handleSlackOAuthCallback } from "../src/routes/integrations.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function createMockKV(): KVNamespace {
  const store = new Map<string, string>();

  return {
    async get(key: string, type?: "text" | "json"): Promise<unknown> {
      const value = store.get(key) ?? null;
      return type === "json" && value ? JSON.parse(value) : value;
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, value);
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
  } as unknown as KVNamespace;
}

function createEnv() {
  const workspaceStub = {
    getInfo: vi.fn(async () => ({
      id: "ws_1",
      org_id: "org_1",
      archived: false,
    })),
    getMemberAccess: vi.fn(async () => ({ access_level: "full" })),
    getIntegration: vi.fn(async () => null),
    createIntegration: vi.fn(async () => undefined),
    updateIntegration: vi.fn(async () => undefined),
  };
  const orgStub = {
    isMember: vi.fn(async () => true),
    isAdmin: vi.fn(async () => true),
  };
  const slackTeamRegistryStub = {
    upsertInstallation: vi.fn(async () => undefined),
  };

  return {
    env: {
      SESSIONS: createMockKV(),
      SLACK_CLIENT_ID: "slack-client-id",
      SLACK_CLIENT_SECRET: "slack-client-secret",
      INTEGRATION_SECRET_KEY: "integration-secret",
      WORKSPACE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => workspaceStub),
      },
      ORG: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => orgStub),
      },
      SLACK_TEAM_REGISTRY: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => slackTeamRegistryStub),
      },
    },
    workspaceStub,
    orgStub,
    slackTeamRegistryStub,
  };
}

describe("handleSlackOAuthCallback", () => {
  it("treats a null Slack bot user id as absent when registering an installation", async () => {
    const { env, workspaceStub, slackTeamRegistryStub } = createEnv();
    const state = await createIntegrationOAuthState(
      env.SESSIONS,
      "slack",
      "ws_1",
      "user_1",
      "/connections",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ok: true,
          access_token: "xoxb-token",
          token_type: "bot",
          scope: "chat:write,team:read",
          bot_user_id: null,
          app_id: "A123",
          team: { id: "T123", name: "Acme" },
          authed_user: { id: "U123", access_token: null },
        }),
      ),
    );

    const response = await handleSlackOAuthCallback({
      env,
      url: new URL(
        `https://camelai.dev/api/integrations/slack/callback?code=code-1&state=${state}`,
      ),
    } as never);

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "https://camelai.dev/connections?success=slack_connected",
    );
    expect(workspaceStub.createIntegration).toHaveBeenCalledOnce();
    expect(slackTeamRegistryStub.upsertInstallation).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace_id: "ws_1",
        org_id: "org_1",
        team_id: "T123",
        bot_user_id: undefined,
      }),
    );
  });
});
