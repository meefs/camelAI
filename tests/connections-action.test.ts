import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptCredentials } from "@/lib/integration-crypto";

const requireAuthContextMock = vi.fn();
const requireWorkspaceAccessMock = vi.fn();
const getAuthEnvMock = vi.fn();
const getEnvMock = vi.fn();
const isOrgAdminMock = vi.fn();
const authUserGetMock = vi.fn();
const authUserGetProfileMock = vi.fn();
const createIntegrationMock = vi.fn();
const createDefinitionMock = vi.fn();
const getDefinitionMock = vi.fn();
const discoverSurfacesMock = vi.fn();
const updateIntegrationMock = vi.fn();
const deleteIntegrationMock = vi.fn();
const getIntegrationMock = vi.fn();
const getIntegrationsMock = vi.fn();
const sourceIntegrationNameExistsMock = vi.fn();
const targetCreateIntegrationMock = vi.fn();
const targetIntegrationNameExistsMock = vi.fn();
const targetGetInfoMock = vi.fn();
const putSetupTokenMock = vi.fn();
const listProjectsMock = vi.fn();
const verifyConnectionMock = vi.fn();

vi.mock("@/lib/auth.server", () => ({
  requireAuthContext: requireAuthContextMock,
  requireWorkspaceAccess: requireWorkspaceAccessMock,
  getAuthEnv: getAuthEnvMock,
}));

vi.mock("@/lib/cloudflare.server", () => ({
  getEnv: getEnvMock,
}));

vi.mock("@/lib/openapi-integration.server", () => ({
  discoverIntegrationSurfaces: discoverSurfacesMock,
}));

vi.mock("@/lib/auth-do", () => ({
  isOrgAdmin: isOrgAdminMock,
  createWorkspaceIntegrationDefinitionRecord: vi.fn(
    (_authEnv, _workspaceId: string, ...args: unknown[]) => createDefinitionMock(...args),
  ),
  getWorkspaceIntegrationDefinitionRecord: vi.fn(
    (_authEnv, _workspaceId: string, definitionId: string) => getDefinitionMock(definitionId),
  ),
  createWorkspaceIntegrationRecord: vi.fn(
    (
      _authEnv,
      workspaceId: string,
      ...args: [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        number | null | undefined,
      ]
    ) => {
      const spy =
        workspaceId === "ws_2" ? targetCreateIntegrationMock : createIntegrationMock;
      return spy(...args);
    },
  ),
  updateWorkspaceIntegrationRecord: vi.fn(
    (_authEnv, _workspaceId: string, integrationId: string, updates, actorId: string) =>
      updateIntegrationMock(integrationId, updates, actorId),
  ),
  deleteWorkspaceIntegrationRecord: vi.fn(
    (_authEnv, _workspaceId: string, integrationId: string, actorId: string) =>
      deleteIntegrationMock(integrationId, actorId),
  ),
  getWorkspaceIntegrationRecord: vi.fn(
    (_authEnv, _workspaceId: string, integrationId: string) =>
      getIntegrationMock(integrationId),
  ),
  listWorkspaceIntegrationRecords: vi.fn((_authEnv, _workspaceId: string) =>
    getIntegrationsMock(),
  ),
  workspaceIntegrationNameExists: vi.fn(
    (
      _authEnv,
      workspaceId: string,
      integrationType: string,
      name: string,
      excludeId?: string,
    ) => {
      const spy =
        workspaceId === "ws_2"
          ? targetIntegrationNameExistsMock
          : sourceIntegrationNameExistsMock;
      return spy(integrationType, name, excludeId);
    },
  ),
}));

vi.mock("../workers/main/src/workspace-filesystem-do", () => ({
  WorkspaceFilesystemClient: class WorkspaceFilesystemClient {
    listProjects = listProjectsMock;
  },
}));

vi.mock("../workers/main/src/connections-runtime", () => ({
  verifyConnection: verifyConnectionMock,
}));

const { action, loader } = await import("@/routes/_app.connections");

function postForm(fields: Record<string, string>) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.set(key, value);
  }
  return new Request("https://camelai.test/connections", {
    method: "POST",
    body: formData,
  });
}

function makeRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "int_1",
    integration_type: "postgres",
    name: "Primary DB",
    category: "databases",
    auth_method: "api_key",
    config: JSON.stringify({ host: "db.example.com" }),
    credentials_encrypted: "",
    created_by: "creator_1",
    created_at: 100,
    updated_at: 200,
    deleted_at: null,
    token_expires_at: null,
    auth_status: "connected",
    auth_error_code: null,
    auth_error_message: null,
    auth_checked_at: null,
    reauth_required_at: null,
    ...overrides,
  };
}

function setEnv(overrides: Record<string, unknown> = {}) {
  const sourceWorkspaceStub = {
    createIntegration: createIntegrationMock,
    updateIntegration: updateIntegrationMock,
    deleteIntegration: deleteIntegrationMock,
    getIntegration: getIntegrationMock,
    getIntegrations: getIntegrationsMock,
    integrationNameExists: sourceIntegrationNameExistsMock,
  };
  const targetWorkspaceStub = {
    createIntegration: targetCreateIntegrationMock,
    getInfo: targetGetInfoMock,
    integrationNameExists: targetIntegrationNameExistsMock,
  };
  const telegramRegistryStub = {
    putSetupToken: putSetupTokenMock,
  };

  getEnvMock.mockReturnValue({
    INTEGRATION_SECRET_KEY: "test-secret",
    WORKSPACE_EMAIL_DOMAIN: "mail.camelai.test",
    TELEGRAM_BOT_USERNAME: "@camelai_test_bot",
    TELEGRAM_BOT_TOKEN: "telegram-token",
    TELEGRAM_REGISTRY: {
      idFromName: vi.fn((id: string) => id),
      get: vi.fn(() => telegramRegistryStub),
    },
    WORKSPACE: {
      idFromName: vi.fn((id: string) => id),
      get: vi.fn((id: string) =>
        id === "ws_2" ? targetWorkspaceStub : sourceWorkspaceStub,
      ),
    },
    ...overrides,
  });

  return { sourceWorkspaceStub, targetWorkspaceStub, telegramRegistryStub };
}

describe("connections action admin guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    discoverSurfacesMock.mockReset();
    requireAuthContextMock.mockResolvedValue({
      currentOrg: { id: "org_1" },
      currentWorkspace: { id: "ws_1" },
      user: { id: "user_1" },
      workspaces: [
        { id: "ws_1", name: "Source" },
        { id: "ws_2", name: "Target" },
      ],
    });
    requireWorkspaceAccessMock.mockResolvedValue(undefined);
    getAuthEnvMock.mockReturnValue({ auth: true });
    setEnv();
    isOrgAdminMock.mockResolvedValue(false);
    createIntegrationMock.mockResolvedValue(undefined);
    updateIntegrationMock.mockResolvedValue(undefined);
    deleteIntegrationMock.mockResolvedValue(undefined);
    targetCreateIntegrationMock.mockResolvedValue(undefined);
    targetGetInfoMock.mockResolvedValue({ id: "ws_2", org_id: "org_1" });
    targetIntegrationNameExistsMock.mockResolvedValue(false);
    getIntegrationMock.mockResolvedValue(makeRecord());
    getIntegrationsMock.mockResolvedValue([]);
    putSetupTokenMock.mockResolvedValue(undefined);
    verifyConnectionMock.mockResolvedValue({
      ok: true,
      status: "ready",
      message: "Connection verified successfully.",
    });
  });

  it.each([
    ["createIntegration", { integration_type: "postgres", name: "DB" }],
    ["updateIntegration", { integrationId: "int_1", name: "Renamed" }],
    ["deleteIntegration", { integrationId: "int_1" }],
    ["duplicateIntegration", { integrationId: "int_1", targetWorkspaceId: "ws_2" }],
  ])("blocks %s for full-access non-admins", async (intent, fields) => {
    await expect(
      action({
        request: postForm({ intent, ...fields }),
        context: {},
        params: {},
      } as never),
    ).resolves.toEqual({
      error: "Only organization admins can manage connections",
    });

    expect(requireWorkspaceAccessMock).toHaveBeenCalledWith(
      expect.any(Request),
      {},
      "ws_1",
      "full",
    );
    expect(isOrgAdminMock).toHaveBeenCalledWith({ auth: true }, "user_1", "org_1");
    expect(createIntegrationMock).not.toHaveBeenCalled();
    expect(updateIntegrationMock).not.toHaveBeenCalled();
    expect(deleteIntegrationMock).not.toHaveBeenCalled();
  });

  it("does not invoke the admin guard for unknown intents", async () => {
    await expect(
      action({
        request: postForm({ intent: "wat" }),
        context: {},
        params: {},
      } as never),
    ).resolves.toEqual({ error: "Unknown action" });

    expect(isOrgAdminMock).not.toHaveBeenCalled();
  });

  it("allows a full-access member to verify without granting management access", async () => {
    const response = await action({
      request: postForm({ intent: "verifyIntegration", integrationId: "int_1" }),
      context: {},
      params: {},
    } as never);

    expect(response).toMatchObject({
      success: true,
      verification: { ok: true, status: "ready" },
    });
    expect(isOrgAdminMock).not.toHaveBeenCalled();
    expect(verifyConnectionMock).toHaveBeenCalledWith(
      expect.any(Object),
      { orgId: "org_1", workspaceId: "ws_1", userId: "user_1" },
      { id: "int_1" },
    );
  });

  it("allows admins to create, update, delete, and duplicate integrations", async () => {
    isOrgAdminMock.mockResolvedValue(true);

    await expect(
      action({
        request: postForm({
          intent: "createIntegration",
          integration_type: "postgres",
          name: "Primary DB",
          config: JSON.stringify({
            host: "db.example.com",
            port: 5432,
            database: "app_db",
          }),
          credentials: JSON.stringify({ username: "app", password: "secret" }),
        }),
        context: {},
        params: {},
      } as never),
    ).resolves.toEqual({ success: true });
    expect(createIntegrationMock).toHaveBeenCalledWith(
      expect.any(String),
      "postgres",
      "Primary DB",
      "databases",
      "api_key",
      JSON.stringify({ host: "db.example.com", port: 5432, database: "app_db" }),
      expect.any(String),
      "user_1",
    );

    await expect(
      action({
        request: postForm({
          intent: "updateIntegration",
          integrationId: "int_1",
          name: "Renamed DB",
        }),
        context: {},
        params: {},
      } as never),
    ).resolves.toEqual({ success: true });
    expect(updateIntegrationMock).toHaveBeenCalledWith(
      "int_1",
      { name: "Renamed DB" },
      "user_1",
    );

    await expect(
      action({
        request: postForm({
          intent: "deleteIntegration",
          integrationId: "int_1",
        }),
        context: {},
        params: {},
      } as never),
    ).resolves.toEqual({ success: true });
    expect(deleteIntegrationMock).toHaveBeenCalledWith("int_1", "user_1");

    await expect(
      action({
        request: postForm({
          intent: "duplicateIntegration",
          integrationId: "int_1",
          targetWorkspaceId: "ws_2",
        }),
        context: {},
        params: {},
      } as never),
    ).resolves.toEqual({ success: true });
    expect(targetCreateIntegrationMock).toHaveBeenCalledWith(
      expect.any(String),
      "postgres",
      "Primary DB",
      "databases",
      "api_key",
      JSON.stringify({ host: "db.example.com" }),
      "",
      "user_1",
      null,
    );
  });

  it("rejects duplicate targets outside the current org", async () => {
    isOrgAdminMock.mockResolvedValue(true);
    requireAuthContextMock.mockResolvedValue({
      currentOrg: { id: "org_1" },
      currentWorkspace: { id: "ws_1" },
      user: { id: "user_1" },
      workspaces: [{ id: "ws_1", name: "Source" }],
    });

    await expect(
      action({
        request: postForm({
          intent: "duplicateIntegration",
          integrationId: "int_1",
          targetWorkspaceId: "ws_2",
        }),
        context: {},
        params: {},
      } as never),
    ).resolves.toEqual({
      error: "Target workspace must belong to the same organization",
    });

    expect(getIntegrationMock).not.toHaveBeenCalled();
    expect(targetCreateIntegrationMock).not.toHaveBeenCalled();
  });

  it("creates Telegram setup records and returns the setup deep link", async () => {
    isOrgAdminMock.mockResolvedValue(true);

    const response = await action({
      request: postForm({
        intent: "createIntegration",
        integration_type: "telegram",
        name: "Team Telegram",
        config: JSON.stringify({}),
        credentials: JSON.stringify({}),
      }),
      context: {},
      params: {},
    } as never);

    expect(response).toMatchObject({ success: true });
    expect(response.oauthUrl).toContain("https://t.me/camelai_test_bot?start=");
    const [integrationId, , , , , configJson, credentialsEncrypted] =
      createIntegrationMock.mock.calls[0];
    expect(JSON.parse(configJson)).toMatchObject({
      status: "pending",
      bot_username: "camelai_test_bot",
    });
    expect(credentialsEncrypted).toEqual(expect.any(String));
    expect(putSetupTokenMock).toHaveBeenCalledWith(
      JSON.parse(configJson).setup_token,
      {
        workspaceId: "ws_1",
        orgId: "org_1",
        integrationId,
        userId: "user_1",
      },
      30 * 60,
    );
  });

  it("normalizes remote MCP OAuth URLs and returns the follow-up OAuth URL", async () => {
    isOrgAdminMock.mockResolvedValue(true);

    const response = await action({
      request: postForm({
        intent: "createIntegration",
        integration_type: "remote_mcp",
        name: "Docs MCP",
        config: JSON.stringify({
          server_url: "https://mcp.example.com/mcp#token",
          auth_type: "oauth",
        }),
        credentials: JSON.stringify({}),
      }),
      context: {},
      params: {},
    } as never);

    expect(response).toMatchObject({ success: true });
    expect(response.oauthUrl).toContain("/api/integrations/remote_mcp/oauth?");
    expect(response.oauthUrl).toContain("redirect=%2Fconnections");
    const [integrationId, , , , , configJson, credentialsEncrypted] =
      createIntegrationMock.mock.calls[0];
    expect(JSON.parse(configJson)).toEqual({
      server_url: "https://mcp.example.com/mcp",
      auth_type: "oauth",
    });
    expect(credentialsEncrypted).toBe("");
    expect(response.oauthUrl).toContain(`integration_id=${integrationId}`);
  });

  it("creates a discovered MCP surface as a remote MCP OAuth connection", async () => {
    isOrgAdminMock.mockResolvedValue(true);
    discoverSurfacesMock.mockResolvedValue([{
      schemaVersion: 1,
      slug: "example-mcp",
      displayName: "Example MCP",
      surface: "mcp",
      source: "discovered",
      sourceUrl: "https://integrations.sh/api/example.com/surface",
      baseUrl: "https://mcp.example.com/mcp",
      auth: [{ kind: "oauth2" }],
      operations: [],
      provenance: { kind: "discovered" },
    }]);

    const response = await action({
      request: postForm({
        intent: "createDiscoveredIntegration",
        source_url: "https://example.com",
        surface_slug: "example-mcp",
        name: "Example MCP",
        auth_type: "oauth2",
        operation_policy: "read_only",
        credentials: "{}",
      }),
      context: {},
      params: {},
    } as never);

    expect(response).toMatchObject({ success: true });
    expect(response.oauthUrl).toContain("/api/integrations/remote_mcp/oauth?");
    const [, integrationType, name, , , configJson, credentialsEncrypted] = createIntegrationMock.mock.calls[0];
    expect(integrationType).toBe("remote_mcp");
    expect(name).toBe("Example MCP");
    expect(JSON.parse(configJson)).toEqual({
      server_url: "https://mcp.example.com/mcp",
      auth_type: "oauth",
      discovery_source: "https://integrations.sh/api/example.com/surface",
    });
    expect(credentialsEncrypted).toBe("");
    expect(createDefinitionMock).not.toHaveBeenCalled();
  });

  it("persists a discovered GraphQL surface with generic fetch and a guarded operation", async () => {
    isOrgAdminMock.mockResolvedValue(true);
    discoverSurfacesMock.mockResolvedValue([{
      schemaVersion: 1,
      slug: "example-graphql",
      displayName: "Example GraphQL",
      surface: "graphql",
      source: "discovered",
      sourceUrl: "https://integrations.sh/api/example.com/surface",
      baseUrl: "https://api.example.com/graphql",
      auth: [{ kind: "none" }],
      operations: [{
        id: "graphql.execute",
        name: "executeGraphql",
        method: "POST",
        path: "",
        access: "write",
      }],
      provenance: { kind: "discovered" },
    }]);

    const response = await action({
      request: postForm({
        intent: "createDiscoveredIntegration",
        source_url: "https://example.com",
        surface_slug: "example-graphql",
        name: "Example GraphQL",
        auth_type: "none",
        operation_policy: "read_only",
        credentials: "{}",
      }),
      context: {},
      params: {},
    } as never);

    expect(response).toMatchObject({ success: true });
    expect(createDefinitionMock).toHaveBeenCalledWith(
      expect.any(String),
      "example-graphql",
      expect.stringContaining('"surface":"graphql"'),
      "discovered",
      "https://integrations.sh/api/example.com/surface",
      "user_1",
    );
    const [, integrationType, , , , configJson, credentialsEncrypted] = createIntegrationMock.mock.calls[0];
    expect(integrationType).toBe("other");
    expect(JSON.parse(configJson)).toMatchObject({
      base_url: "https://api.example.com/graphql",
      operation_policy: "read_only",
      restrict_to_base_origin: true,
      generic_fetch_enabled: true,
    });
    expect(credentialsEncrypted).toBe("");
  });

  it("resolves tenant URL variables before persisting a discovered connection", async () => {
    isOrgAdminMock.mockResolvedValue(true);
    discoverSurfacesMock.mockResolvedValue([{
      schemaVersion: 1,
      slug: "shopify-graphql",
      displayName: "Shopify GraphQL",
      surface: "graphql",
      source: "discovered",
      sourceUrl: "https://integrations.sh/api/shopify.com/surface",
      baseUrl: "https://{shop}.myshopify.com/admin/api/%7Bapi_version%7D/graphql.json",
      auth: [{ kind: "unknown" }],
      variables: [
        { name: "shop", in: "url" },
        { name: "api_version", in: "url" },
      ],
      warnings: ["The discovered endpoint is hosted outside shopify.com."],
      operations: [{
        id: "graphql.execute",
        name: "executeGraphql",
        method: "POST",
        path: "",
        access: "write",
      }],
      provenance: { kind: "discovered" },
    }]);

    const unconfirmedResponse = await action({
      request: postForm({
        intent: "createDiscoveredIntegration",
        source_url: "https://shopify.com",
        surface_slug: "shopify-graphql",
        name: "Storefront",
        auth_type: "bearer",
        operation_policy: "read_only",
        credentials: JSON.stringify({ api_key: "shop-token" }),
        surface_variables: JSON.stringify({ shop: "acme-store", api_version: "2026-07" }),
      }),
      context: {},
      params: {},
    } as never);

    expect(unconfirmedResponse).toEqual({
      error: "Confirm the integrations.sh endpoint before creating this connection",
    });
    expect(createIntegrationMock).not.toHaveBeenCalled();

    const response = await action({
      request: postForm({
        intent: "createDiscoveredIntegration",
        source_url: "https://shopify.com",
        surface_slug: "shopify-graphql",
        name: "Storefront",
        auth_type: "bearer",
        operation_policy: "read_only",
        credentials: JSON.stringify({ api_key: "shop-token" }),
        surface_variables: JSON.stringify({ shop: "acme-store", api_version: "2026-07" }),
        endpoint_confirmed: "true",
      }),
      context: {},
      params: {},
    } as never);

    expect(response).toMatchObject({ success: true });
    expect(createDefinitionMock).toHaveBeenCalledWith(
      expect.any(String),
      "shopify-graphql",
      expect.stringContaining("https://acme-store.myshopify.com/admin/api/2026-07/graphql.json"),
      "discovered",
      "https://integrations.sh/api/shopify.com/surface",
      "user_1",
    );
    const configJson = createIntegrationMock.mock.calls[0][5];
    expect(JSON.parse(configJson)).toMatchObject({
      base_url: "https://acme-store.myshopify.com/admin/api/2026-07/graphql.json",
      auth_type: "bearer",
    });
  });
});

describe("connections loader", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    requireAuthContextMock.mockResolvedValue({
      currentOrg: {
        id: "org_1",
        billing_plan: "starter",
        billing_status: "active",
      },
      currentWorkspace: {
        id: "ws_1",
        name: "Workspace",
        email_handle: "quiet-river-field",
        created_by: "creator_1",
        created_at: 50,
      },
      user: { id: "user_1" },
      workspaces: [
        { id: "ws_1", name: "Source" },
        { id: "ws_2", name: "Target" },
      ],
    });
    authUserGetMock.mockImplementation((id: string) => ({
      getProfile: () => authUserGetProfileMock(id),
    }));
    authUserGetProfileMock.mockImplementation(async (id: string) =>
      id === "creator_1"
        ? {
            id: "creator_1",
            name: "Creator One",
            email: "creator@example.com",
            avatar: null,
          }
        : null,
    );
    getAuthEnvMock.mockReturnValue({
      auth: true,
      USER: {
        idFromName: vi.fn((id: string) => id),
        get: authUserGetMock,
      },
    });
    setEnv();
    getIntegrationsMock.mockResolvedValue([]);
    listProjectsMock.mockResolvedValue([]);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("keeps connection records when optional creator profile lookup fails", async () => {
    getIntegrationsMock.mockResolvedValue([
      makeRecord({ id: "pg_1", created_by: "missing_user" }),
    ]);
    authUserGetProfileMock.mockRejectedValue(new Error("profile lookup failed"));

    const result = await loader({
      request: new Request("https://camelai.test/connections"),
      context: {},
      params: {},
    } as never);

    await expect(result.pageData).resolves.toMatchObject({
      connections: [
        {
          id: "pg_1",
          name: "Primary DB",
          created_by_name: null,
          created_by_avatar: null,
        },
      ],
      projects: [],
    });
    expect(result).not.toHaveProperty("connections");
    expect(result).not.toHaveProperty("projects");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Failed to load workspace email creator profiles:",
      expect.any(Error),
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Failed to load workspace connection creator profiles:",
      expect.any(Error),
    );
  });

  it("keeps pageData resolved with empty connections when integration loading fails", async () => {
    getIntegrationsMock.mockRejectedValue(new Error("integration list failed"));

    const result = await loader({
      request: new Request("https://camelai.test/connections"),
      context: {},
      params: {},
    } as never);

    await expect(result.pageData).resolves.toEqual({
      connections: [],
      projects: [],
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Failed to load workspace connections:",
      expect.any(Error),
    );
  });

  it("returns connection and project data through one stable pageData promise", async () => {
    getIntegrationsMock.mockResolvedValue([
      makeRecord({ id: "pg_1", created_by: "creator_1" }),
    ]);
    listProjectsMock.mockResolvedValue([
      {
        id: "ca-ws_1-query-tool",
        name: "Query Tool",
        description: "Project exposed to mentions",
        kind: "project",
        createdAt: "2026-06-10T12:00:00.000Z",
        updatedAt: "2026-06-11T12:00:00.000Z",
      },
    ]);

    const result = await loader({
      request: new Request("https://camelai.test/connections"),
      context: {},
      params: {},
    } as never);

    expect(result.pageData).toBeInstanceOf(Promise);
    await expect(result.pageData).resolves.toMatchObject({
      connections: [
        {
          id: "pg_1",
          name: "Primary DB",
          created_by_name: "Creator One",
        },
      ],
      projects: [
        {
          id: "ca-ws_1-query-tool",
          name: "Query Tool",
        },
      ],
    });
    expect(result).not.toHaveProperty("connections");
    expect(result).not.toHaveProperty("projects");
  });

  it("loads Slack metadata from config without exposing encrypted credentials", async () => {
    getIntegrationsMock.mockResolvedValue([
      {
        ...makeRecord({
          id: "slack_1",
          integration_type: "slack",
          name: "Slack Team",
          category: "communication",
          auth_method: "oauth2",
          config: JSON.stringify({
            team_id: "T123",
            team_name: "Camel Team",
            bot_user_id: "B123",
          }),
          credentials_encrypted: "not-used",
        }),
      },
    ]);

    const result = await loader({
      request: new Request("https://camelai.test/connections"),
      context: {},
      params: {},
    } as never);
    const { connections } = await result.pageData;
    const [connection] = connections;

    expect(connection.channelMetadata).toEqual({
      team_id: "T123",
      team_name: "Camel Team",
      bot_user_id: "B123",
    });
    expect(connection).not.toHaveProperty("credentials_encrypted");
  });

  it("falls back to decrypted Slack metadata server-side", async () => {
    getIntegrationsMock.mockResolvedValue([
      makeRecord({
        id: "slack_1",
        integration_type: "slack",
        name: "Slack Team",
        category: "communication",
        auth_method: "oauth2",
        config: JSON.stringify({}),
        credentials_encrypted: await encryptCredentials(
          {
            team_id: "T456",
            team_name: "Fallback Team",
            bot_user_id: "B456",
          },
          "test-secret",
        ),
      }),
    ]);

    const result = await loader({
      request: new Request("https://camelai.test/connections"),
      context: {},
      params: {},
    } as never);
    const { connections } = await result.pageData;
    const [connection] = connections;

    expect(connection.channelMetadata).toEqual({
      team_id: "T456",
      team_name: "Fallback Team",
      bot_user_id: "B456",
    });
    expect(connection).not.toHaveProperty("credentials_encrypted");
  });

  it("returns configured native email data and Starter plan enabled state", async () => {
    const result = await loader({
      request: new Request("https://camelai.test/connections"),
      context: {},
      params: {},
    } as never);

    expect(result.workspaceEmailAddress).toBe(
      "quiet-river-field@mail.camelai.test",
    );
    expect(result.emailInboxEnabled).toBe(true);
    expect(result.emailHandle).toBe("quiet-river-field");
    expect(result.workspaceCreatedByName).toBe("Creator One");
  });

  it("loads project mentionables for connection mention slug collisions", async () => {
    listProjectsMock.mockResolvedValue([
      {
        id: "ca-ws_1-primary-db",
        name: "Primary DB",
        description: "Project with colliding slug",
        kind: "project",
        createdAt: "2026-06-10T12:00:00.000Z",
        updatedAt: "2026-06-11T12:00:00.000Z",
        clones: [
          {
            id: "ca-ws_1-primary-db-v2",
            name: "Primary DB v2",
            description: "Clone excluded from mentions",
          },
        ],
      },
    ]);

    const result = await loader({
      request: new Request("https://camelai.test/connections"),
      context: {},
      params: {},
    } as never);

    await expect(result.pageData).resolves.toMatchObject({
      connections: [],
      projects: [
        {
          kind: "project",
          id: "ca-ws_1-primary-db",
          name: "Primary DB",
          description: "Project with colliding slug",
          created_at: Date.parse("2026-06-10T12:00:00.000Z"),
          updated_at: Date.parse("2026-06-11T12:00:00.000Z"),
        },
      ],
    });
  });

  it("keeps pageData resolved with empty projects when project loading fails", async () => {
    listProjectsMock.mockRejectedValue(new Error("project list failed"));

    const result = await loader({
      request: new Request("https://camelai.test/connections"),
      context: {},
      params: {},
    } as never);

    await expect(result.pageData).resolves.toEqual({
      connections: [],
      projects: [],
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Failed to load workspace projects:",
      expect.any(Error),
    );
  });

  it("handles missing email domain and plan-disabled states", async () => {
    requireAuthContextMock.mockResolvedValue({
      currentOrg: {
        id: "org_1",
        billing_plan: "free",
        billing_status: "active",
      },
      currentWorkspace: {
        id: "ws_1",
        name: "Workspace",
        email_handle: "quiet-river-field",
        created_by: "creator_1",
        created_at: 50,
      },
      user: { id: "user_1" },
      workspaces: [{ id: "ws_1", name: "Source" }],
    });
    setEnv({ WORKSPACE_EMAIL_DOMAIN: "" });

    const result = await loader({
      request: new Request("https://camelai.test/connections"),
      context: {},
      params: {},
    } as never);

    expect(result.workspaceEmailAddress).toBeNull();
    expect(result.emailInboxEnabled).toBe(false);
    expect(result.emailHandle).toBe("quiet-river-field");
  });
});
