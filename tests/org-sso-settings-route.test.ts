import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAuthContextMock = vi.fn();
const requireOrgAdminMock = vi.fn();
const getEnvMock = vi.fn();

vi.mock("@/lib/auth.server", () => ({
  requireAuthContext: requireAuthContextMock,
  requireOrgAdmin: requireOrgAdminMock,
}));

vi.mock("@/lib/cloudflare.server", () => ({
  getEnv: getEnvMock,
}));

const { loader } = await import("@/routes/_app.settings.organization.sso");

describe("organization SSO settings authorization", () => {
  const authContext = {
    user: { id: "admin-1" },
    currentOrg: {
      id: "org-1",
      slug: "acme",
      name: "Acme",
      billing_status: "enterprise",
    },
  };
  const orgStub = {
    getSsoConfig: vi.fn(),
    getSsoConnectionTest: vi.fn(),
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
    requireAuthContextMock.mockResolvedValue(authContext);
    requireOrgAdminMock.mockResolvedValue(authContext);
    getEnvMock.mockReturnValue(env);
    orgStub.getSsoConfig.mockResolvedValue(null);
    orgStub.getSsoConnectionTest.mockResolvedValue(null);
  });

  it("loads SSO settings for an organization administrator", async () => {
    const result = await loader({
      request: new Request("https://camelai.test/settings/organization/sso"),
      context: {},
      params: {},
    } as never);

    expect(requireOrgAdminMock).toHaveBeenCalledWith(
      expect.any(Request),
      {},
      "org-1",
    );
    expect(result).toMatchObject({
      org: authContext.currentOrg,
      config: null,
      connectionTest: null,
      callbackUrl: "https://camelai.test/api/auth/enterprise-oidc/callback",
    });
  });

  it("does not read SSO state when administrator authorization fails", async () => {
    requireOrgAdminMock.mockRejectedValueOnce(
      new Response(null, { status: 302 }),
    );

    await expect(
      loader({
        request: new Request("https://camelai.test/settings/organization/sso"),
        context: {},
        params: {},
      } as never),
    ).rejects.toBeInstanceOf(Response);

    expect(orgStub.getSsoConfig).not.toHaveBeenCalled();
    expect(orgStub.getSsoConnectionTest).not.toHaveBeenCalled();
  });
});
