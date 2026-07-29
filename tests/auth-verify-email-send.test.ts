import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAuthContextMock = vi.fn();
const getEnvMock = vi.fn();
const sendUserVerificationEmailMock = vi.fn();

vi.mock("@/lib/auth.server", () => ({
  requireAuthContext: requireAuthContextMock,
}));

vi.mock("@/lib/cloudflare.server", () => ({
  getEnv: getEnvMock,
}));

vi.mock("@/lib/email-verification.server", () => ({
  sendUserVerificationEmail: sendUserVerificationEmailMock,
}));

const { action } = await import("@/routes/api/auth.verify-email.send");

describe("auth verify-email send route", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    const userStub = {
      getEmailVerificationStatus: vi.fn().mockResolvedValue({
        required: true,
        verified: false,
      }),
    };

    requireAuthContextMock.mockResolvedValue({
      user: { id: "user_123", email: "test@example.com" },
    });
    getEnvMock.mockReturnValue({
      USER: {
        idFromName: (id: string) => id,
        get: () => userStub,
      },
    });
    sendUserVerificationEmailMock.mockResolvedValue({ status: "sent" });
  });

  it("sends verification email without prompt_key", async () => {
    const response = await action({
      request: new Request("https://camelai.dev/api/auth/verify-email/send", {
        method: "POST",
      }),
      context: {},
    } as never);

    expect(response.status).toBe(200);
    expect(sendUserVerificationEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_123",
        email: "test@example.com",
      }),
    );
    expect(sendUserVerificationEmailMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ promptKey: expect.anything() }),
    );
  });

  it("returns an explicit disabled-state error in self-host mode", async () => {
    getEnvMock.mockReturnValue({
      CF_ACCOUNT_ID: "selfhost",
      USER: {
        idFromName: (id: string) => id,
        get: vi.fn(),
      },
    });

    const response = await action({
      request: new Request("https://selfhost.example/api/auth/verify-email/send", {
        method: "POST",
      }),
      context: {},
    } as never);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error:
        "Email verification delivery is disabled in self-host mode. Use the configured enterprise identity provider.",
    });
    expect(sendUserVerificationEmailMock).not.toHaveBeenCalled();
  });
});
