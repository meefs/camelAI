import { beforeEach, describe, expect, it, vi } from "vitest";

const getEnvMock = vi.fn();
const getSignedSessionMock = vi.fn();
const deleteCookieMock = vi.fn(() => "session=; Max-Age=0");
const invalidateSessionsMock = vi.fn();

vi.mock("@/lib/cloudflare.server", () => ({
  getEnv: getEnvMock,
}));

vi.mock("@/lib/cookies.server", () => ({
  getSignedSessionFromRequest: getSignedSessionMock,
  createDeleteSessionCookieHeader: deleteCookieMock,
}));

vi.mock(
  "../workers/main/src/helpers/proxy-auth-providers",
  () => ({
    providerForAuthSource: vi.fn(() => null),
  }),
);

const { action: logout } = await import("@/routes/api/auth.logout");

describe("enterprise SSO session boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEnvMock.mockReturnValue({
      TOKEN_SIGNING_SECRET: "test-secret",
      USER: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({
          invalidateSessions: invalidateSessionsMock,
        })),
      },
    });
  });

  it("logs out an enterprise cookie without invalidating unrelated user sessions", async () => {
    getSignedSessionMock.mockResolvedValueOnce({
      user_id: "user-1",
      org_id: "org-1",
      auth_source: "enterprise_oidc",
    });

    const response = await logout({
      request: new Request("https://camelai.test/api/auth/logout", {
        method: "POST",
      }),
      context: {},
      params: {},
    } as never);

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBe("session=; Max-Age=0");
    expect(invalidateSessionsMock).not.toHaveBeenCalled();
  });

  it("continues to invalidate ordinary signed sessions on logout", async () => {
    getSignedSessionMock.mockResolvedValueOnce({
      user_id: "user-1",
      org_id: "org-1",
      auth_source: null,
    });

    const response = await logout({
      request: new Request("https://camelai.test/api/auth/logout", {
        method: "POST",
      }),
      context: {},
      params: {},
    } as never);

    expect(response.status).toBe(200);
    expect(invalidateSessionsMock).toHaveBeenCalledOnce();
  });
});
