import { beforeEach, describe, expect, it, vi } from "vitest";

const requireOrgAdminMock = vi.fn();
const getEnvMock = vi.fn();

vi.mock("@/lib/auth.server", () => ({
  requireOrgAdmin: requireOrgAdminMock,
  getAuthEnv: (env: unknown) => env,
}));

vi.mock("@/lib/cloudflare.server", () => ({
  getEnv: getEnvMock,
}));

const { action, loader } = await import("@/routes/api/orgs.$id.sso");

describe("organization SSO owner authorization", () => {
  const orgStub = {
    isOwner: vi.fn(async () => false),
    getInfo: vi.fn(),
    getSsoConfig: vi.fn(),
    claimSsoProvisioning: vi.fn(),
    releaseSsoProvisioning: vi.fn(),
  };
  const env = {
    WORKER_BASE_URL: "https://camelai.test",
    ORG: {
      idFromName: vi.fn((id: string) => id),
      get: vi.fn(() => orgStub),
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    requireOrgAdminMock.mockResolvedValue({
      user: { id: "admin-1" },
    });
    getEnvMock.mockReturnValue(env);
  });

  it("does not expose configuration to a non-owner administrator", async () => {
    const response = await loader({
      request: new Request("https://camelai.test/api/orgs/org-1/sso"),
      context: {},
      params: { id: "org-1" },
    } as never);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Only organization owners can configure SSO",
    });
    expect(orgStub.getSsoConfig).not.toHaveBeenCalled();
  });

  it("does not let a non-owner administrator mutate configuration", async () => {
    const response = await action({
      request: new Request("https://camelai.test/api/orgs/org-1/sso", {
        method: "DELETE",
        headers: { Origin: "https://camelai.test" },
      }),
      context: {},
      params: { id: "org-1" },
    } as never);

    expect(response.status).toBe(403);
    expect(orgStub.claimSsoProvisioning).not.toHaveBeenCalled();
  });

  it("requires a new secret before testing a changed OIDC authority", async () => {
    orgStub.isOwner.mockResolvedValueOnce(true);
    orgStub.getInfo.mockResolvedValueOnce({
      id: "org-1",
      slug: "acme",
      billing_status: "enterprise",
    });
    orgStub.claimSsoProvisioning.mockResolvedValueOnce("lease-1");
    orgStub.getSsoConfig.mockResolvedValueOnce({
      enabled: true,
      connection_id: "connection-1",
      protocol: "oidc",
      issuer: "https://accounts.google.com",
      client_id: "old-client",
      client_secret_encrypted: "encrypted-old-secret",
      client_auth_method: "client_secret_post",
      email_claim: "email",
      email_domains: [],
      jit_provisioning_enabled: true,
      config_version: 1,
      session_ttl_seconds: 8 * 60 * 60,
      updated_at: 1,
      updated_by: "owner-1",
    });

    const response = await action({
      request: new Request("https://camelai.test/api/orgs/org-1/sso", {
        method: "POST",
        headers: {
          Origin: "https://camelai.test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          intent: "test",
          issuer: "https://attacker.example",
          client_id: "old-client",
          client_secret: "",
          client_auth_method: "client_secret_post",
          email_claim: "email",
          email_domains: [],
          jit_provisioning_enabled: true,
          session_ttl_hours: 8,
        }),
      }),
      context: {},
      params: { id: "org-1" },
    } as never);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error:
        "Enter the OIDC client secret when changing the issuer, client ID, or authentication method",
    });
    expect(orgStub.releaseSsoProvisioning).toHaveBeenCalledWith("lease-1");
  });
});
