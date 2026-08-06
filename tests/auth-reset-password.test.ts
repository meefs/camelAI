import { beforeEach, describe, expect, it, vi } from "vitest";

const getEnvMock = vi.fn();
const getBanForEmailMock = vi.fn();
const validatePasswordResetTokenMock = vi.fn();

vi.mock("@/lib/cloudflare.server", () => ({
  getEnv: getEnvMock,
}));

vi.mock("@/lib/ban.server", () => ({
  getBanForEmail: getBanForEmailMock,
}));

vi.mock("@/lib/password-reset-token", () => ({
  validatePasswordResetToken: validatePasswordResetTokenMock,
}));

const { action } = await import("@/routes/api/auth.reset-password");

describe("auth reset-password route", () => {
  const getProfile = vi.fn();
  const resetPassword = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    getEnvMock.mockReturnValue({
      TOKEN_SIGNING_SECRET: "secret",
      USER: {
        idFromName: (id: string) => id,
        get: () => ({ getProfile, resetPassword }),
      },
    });
    getBanForEmailMock.mockResolvedValue(null);
    getProfile.mockResolvedValue({
      id: "user-123",
      email: "test@example.com",
    });
    resetPassword.mockResolvedValue(true);
  });

  it("resets the password for a valid token", async () => {
    validatePasswordResetTokenMock.mockResolvedValue({
      purpose: "password_reset",
      user_id: "user-123",
      email: "test@example.com",
      nonce: "nonce-1",
      iat: Date.now(),
      exp: Date.now() + 60_000,
    });

    const response = await action({
      request: new Request("https://camelai.dev/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: "pr_valid",
          password: "newpassword1",
        }),
      }),
      context: {},
      params: {},
    } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      redirect: "/login?passwordReset=1",
    });
    expect(resetPassword).toHaveBeenCalledWith("newpassword1", "nonce-1");
  });

  it("rejects short passwords", async () => {
    const response = await action({
      request: new Request("https://camelai.dev/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: "pr_valid",
          password: "short",
        }),
      }),
      context: {},
      params: {},
    } as never);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Password must be at least 8 characters",
    });
    expect(resetPassword).not.toHaveBeenCalled();
  });

  it("rejects invalid or consumed tokens", async () => {
    validatePasswordResetTokenMock.mockResolvedValue({
      purpose: "password_reset",
      user_id: "user-123",
      email: "test@example.com",
      nonce: "nonce-1",
      iat: Date.now(),
      exp: Date.now() + 60_000,
    });
    resetPassword.mockResolvedValue(false);

    const response = await action({
      request: new Request("https://camelai.dev/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: "pr_valid",
          password: "newpassword1",
        }),
      }),
      context: {},
      params: {},
    } as never);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Reset link is invalid or has expired.",
    });
  });
});
