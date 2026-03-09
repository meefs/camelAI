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

describe("auth verify-email resend route", () => {
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

  it("passes the onboarding prompt key through resend requests", async () => {
    const response = await action({
      request: new Request("https://camelai.dev/api/auth/verify-email/send", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ promptKey: " sales-key-123 " }).toString(),
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
  });
});
