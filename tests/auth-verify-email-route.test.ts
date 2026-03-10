import { beforeEach, describe, expect, it, vi } from "vitest";

const getEnvMock = vi.fn();
const getSignedSessionFromRequestMock = vi.fn();
const validateEmailVerificationTokenMock = vi.fn();

vi.mock("@/lib/cloudflare.server", () => ({
  getEnv: getEnvMock,
}));

vi.mock("@/lib/cookies.server", () => ({
  getSignedSessionFromRequest: getSignedSessionFromRequestMock,
}));

vi.mock("@/lib/email-verification-token", () => ({
  validateEmailVerificationToken: validateEmailVerificationTokenMock,
}));

const { loader } = await import("@/routes/api/auth.verify-email");

describe("auth verify-email route", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    const userStub = {
      getProfile: vi.fn().mockResolvedValue({ email: "test@example.com" }),
      markEmailVerified: vi.fn().mockResolvedValue(undefined),
    };

    getEnvMock.mockReturnValue({
      TOKEN_SIGNING_SECRET: "secret",
      USER: {
        idFromName: (id: string) => id,
        get: () => userStub,
      },
    });
    getSignedSessionFromRequestMock.mockResolvedValue({ user_id: "user-123" });
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
  });
});
