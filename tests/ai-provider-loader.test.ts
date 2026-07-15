import { beforeEach, describe, expect, it, vi } from "vitest";
import { encryptCredentials } from "@/lib/integration-crypto";

const requireAuthContextMock = vi.fn();
const requireOrgAdminMock = vi.fn();
const getAuthEnvMock = vi.fn((env) => env);
const getEnvMock = vi.fn();

vi.mock("@/lib/auth.server", () => ({
  requireAuthContext: requireAuthContextMock,
  requireOrgAdmin: requireOrgAdminMock,
  getAuthEnv: getAuthEnvMock,
}));

vi.mock("@/lib/cloudflare.server", () => ({
  getEnv: getEnvMock,
}));

const { loader } = await import("@/routes/_app.settings.organization.ai-provider");

describe("AI provider settings loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireOrgAdminMock.mockResolvedValue(undefined);
  });

  it("uses bootstrapped provider config without rereading OrgDO", async () => {
    const integrationSecret = "test-secret";
    const getLlmProviderConfig = vi.fn(async () => {
      throw new Error("unexpected provider config read");
    });
    const getOpenAiSubscription = vi.fn(async () => null);
    getEnvMock.mockReturnValue({
      INTEGRATION_SECRET_KEY: integrationSecret,
      ORG: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({ getLlmProviderConfig, getOpenAiSubscription })),
      },
    });
    requireAuthContextMock.mockResolvedValue({
      currentOrg: { id: "org_123" },
      currentOrgLlmProviderConfig: {
        provider: "openai",
        credentials_encrypted: await encryptCredentials(
          { api_key: "sk-test-provider-key" },
          integrationSecret,
        ),
        config: "{}",
        created_by: "user_123",
        created_at: 1,
        updated_at: 1,
      },
    });

    const result = await loader({
      request: new Request(
        "https://camelai.test/settings/organization/ai-provider",
      ),
      context: {},
      params: {},
    } as never);

    expect(getLlmProviderConfig).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      orgId: "org_123",
      selfhostAiProvider: null,
      config: {
        provider: "openai",
        key_hint: "sk-test-...",
      },
    });
  });
});
