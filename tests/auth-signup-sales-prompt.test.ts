import { beforeEach, describe, expect, it, vi } from "vitest";

const waitUntilMock = vi.fn();
const getEnvMock = vi.fn();
const createSessionCookieHeaderMock = vi.fn();
const getUserByEmailMock = vi.fn();
const createUserMock = vi.fn();
const createOrgMock = vi.fn();
const createSessionMock = vi.fn();
const sendUserVerificationEmailMock = vi.fn();

vi.mock("@/lib/wait-until", () => ({
  waitUntil: waitUntilMock,
}));

vi.mock("@/lib/cloudflare.server", () => ({
  getEnv: getEnvMock,
}));

vi.mock("@/lib/cookies.server", () => ({
  createSessionCookieHeader: createSessionCookieHeaderMock,
}));

vi.mock("@/lib/auth-do", () => ({
  getUserByEmail: getUserByEmailMock,
  createUser: createUserMock,
  createOrg: createOrgMock,
  createSession: createSessionMock,
}));

vi.mock("@/lib/email-verification.server", () => ({
  sendUserVerificationEmail: sendUserVerificationEmailMock,
}));

const { action } = await import("@/routes/api/auth.signup");

describe("auth signup sales prompt flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    waitUntilMock.mockImplementation(() => undefined);
    getEnvMock.mockReturnValue({
      USER: {},
      ORG: {},
      WORKSPACE: {},
      SESSIONS: {},
      EMAIL_TO_USER: {},
      APP_KV: {},
      TOKEN_SIGNING_SECRET: "secret",
    });
    createSessionCookieHeaderMock.mockReturnValue("session-cookie");
    getUserByEmailMock.mockResolvedValue(null);
    createUserMock.mockResolvedValue({
      userId: "user_123",
      user: { email: "test@example.com", name: "Test User" },
    });
    createOrgMock.mockResolvedValue({
      org: { id: "org_123" },
      defaultWorkspaceId: "ws_123",
    });
    createSessionMock.mockResolvedValue({ signedToken: "signed-token" });
    sendUserVerificationEmailMock.mockResolvedValue({ status: "sent" });
  });

  it("includes the sales prompt key from the signup redirect in the verification email token", async () => {
    const response = await action({
      request: new Request("https://camelai.dev/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "test@example.com",
          password: "supersecret",
          name: "Test User",
          redirectTo: "/chat?prompt_key=sales-key-123",
        }),
      }),
      context: {},
    } as never);

    expect(response.status).toBe(200);
    expect(sendUserVerificationEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_123",
        email: "test@example.com",
        promptKey: "sales-key-123",
      }),
    );
    expect(waitUntilMock).toHaveBeenCalledTimes(1);
  });
});
