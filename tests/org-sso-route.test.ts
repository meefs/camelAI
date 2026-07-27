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

describe("organization SSO administrator authorization", () => {
  const orgStub = {
    getInfo: vi.fn(),
    getSsoConfig: vi.fn(),
    disableSsoConfig: vi.fn(),
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

  it("exposes configuration to an administrator", async () => {
    orgStub.getInfo.mockResolvedValueOnce({
      id: "org-1",
      slug: "acme",
      billing_status: "enterprise",
    });
    orgStub.getSsoConfig.mockResolvedValueOnce(null);

    const response = await loader({
      request: new Request("https://camelai.test/api/orgs/org-1/sso"),
      context: {},
      params: { id: "org-1" },
    } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      available: true,
      configured: false,
      config: null,
      callback_url: "https://camelai.test/api/auth/enterprise-oidc/callback",
    });
  });

  it("lets an administrator disable SSO", async () => {
    orgStub.getInfo.mockResolvedValueOnce({
      id: "org-1",
      slug: "acme",
      billing_status: "enterprise",
    });
    orgStub.claimSsoProvisioning.mockResolvedValueOnce("lease-1");
    orgStub.getSsoConfig.mockResolvedValueOnce(null);
    orgStub.disableSsoConfig.mockResolvedValueOnce(null);

    const response = await action({
      request: new Request("https://camelai.test/api/orgs/org-1/sso", {
        method: "DELETE",
        headers: { Origin: "https://camelai.test" },
      }),
      context: {},
      params: { id: "org-1" },
    } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      config: null,
    });
    expect(orgStub.disableSsoConfig).toHaveBeenCalledWith("admin-1");
    expect(orgStub.releaseSsoProvisioning).toHaveBeenCalledWith("lease-1");
  });

  it("does not touch SSO state when administrator authorization fails", async () => {
    requireOrgAdminMock.mockRejectedValueOnce(
      new Response(null, { status: 302 }),
    );

    await expect(
      loader({
        request: new Request("https://camelai.test/api/orgs/org-1/sso"),
        context: {},
        params: { id: "org-1" },
      } as never),
    ).rejects.toBeInstanceOf(Response);

    expect(orgStub.getInfo).not.toHaveBeenCalled();
    expect(orgStub.getSsoConfig).not.toHaveBeenCalled();
  });

  it("requires a new secret before testing a changed OIDC authority", async () => {
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
