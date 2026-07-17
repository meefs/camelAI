import { beforeEach, describe, expect, it, vi } from "vitest";

const getEnvMock = vi.fn();
const createSessionCookieHeaderMock = vi.fn();
const createSessionMock = vi.fn();
const getUserOrgsMock = vi.fn();
const listUserWorkspacesMock = vi.fn();
const getBanForEmailMock = vi.fn();
const validateEmailVerificationTokenMock = vi.fn();

vi.mock("@/lib/cloudflare.server", () => ({
  getEnv: getEnvMock,
}));

vi.mock("@/lib/cookies.server", () => ({
  createSessionCookieHeader: createSessionCookieHeaderMock,
}));

vi.mock("@/lib/auth-do", () => ({
  createSession: createSessionMock,
  getUserOrgs: getUserOrgsMock,
  listUserWorkspaces: listUserWorkspacesMock,
}));

vi.mock("@/lib/ban.server", () => ({
  getBanForEmail: getBanForEmailMock,
}));

vi.mock("@/lib/email-verification-token", () => ({
  validateEmailVerificationToken: validateEmailVerificationTokenMock,
}));

const { loader } = await import("@/routes/api/auth.verify-email");

describe("auth verify-email route", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    const userStub = {
      getProfile: vi.fn().mockResolvedValue({
        id: "user-123",
        email: "test@example.com",
        name: "Test User",
      }),
      markEmailVerified: vi.fn().mockResolvedValue(undefined),
    };

    getEnvMock.mockReturnValue({
      TOKEN_SIGNING_SECRET: "secret",
      EMAIL_TO_USER: {},
      APP_KV: {},
      ORG: {},
      WORKSPACE: {},
      SESSIONS: {},
      USER: {
        idFromName: (id: string) => id,
        get: () => userStub,
      },
    });
    getBanForEmailMock.mockResolvedValue(null);
    getUserOrgsMock.mockResolvedValue([{ org_id: "org-123" }]);
    listUserWorkspacesMock.mockResolvedValue([{ id: "workspace-123" }]);
    createSessionMock.mockResolvedValue({ signedToken: "signed-session" });
    createSessionCookieHeaderMock.mockReturnValue(
      "chiridion_session_v3=signed-session; Path=/; HttpOnly",
    );
  });

  it("redirects to onboarding with emailVerified after verification", async () => {
    validateEmailVerificationTokenMock.mockResolvedValue({
      purpose: "email_verification",
      user_id: "user-123",
      email: "test@example.com",
      iat: Date.now(),
      exp: Date.now() + 60_000,
    });

    const response = await loader({
      request: new Request(
        "https://camelai.dev/api/auth/verify-email?token=test-token",
      ),
      context: {},
    } as never);

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "https://camelai.dev/onboarding?emailVerified=1",
    );
    expect(response.headers.get("Set-Cookie")).toBe(
      "chiridion_session_v3=signed-session; Path=/; HttpOnly",
    );
    expect(createSessionMock).toHaveBeenCalledWith(
      expect.anything(),
      "user-123",
      "org-123",
      "workspace-123",
      { name: "Test User", email: "test@example.com" },
    );
  });

  it("does not sign in a banned user", async () => {
    validateEmailVerificationTokenMock.mockResolvedValue({
      purpose: "email_verification",
      user_id: "user-123",
      email: "test@example.com",
      iat: Date.now(),
      exp: Date.now() + 60_000,
    });
    getBanForEmailMock.mockResolvedValue({ reason: "blocked" });

    const response = await loader({
      request: new Request(
        "https://camelai.dev/api/auth/verify-email?token=test-token",
      ),
      context: {},
    } as never);

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "https://camelai.dev/banned",
    );
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(createSessionMock).not.toHaveBeenCalled();
  });
});
