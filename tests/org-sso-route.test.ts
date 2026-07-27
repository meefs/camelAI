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
});
