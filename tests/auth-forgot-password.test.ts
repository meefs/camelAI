import { beforeEach, describe, expect, it, vi } from "vitest";

const getEnvMock = vi.fn();
const getAuthEnvMock = vi.fn();
const getUserByEmailMock = vi.fn();
const getBanForEmailMock = vi.fn();
const sendUserPasswordResetEmailMock = vi.fn();
const waitUntilMock = vi.fn((promise: Promise<unknown>) => {
  void promise;
});

vi.mock("@/lib/cloudflare.server", () => ({
  getEnv: getEnvMock,
}));

vi.mock("@/lib/auth-helpers", () => ({
  getAuthEnv: getAuthEnvMock,
}));

vi.mock("@/lib/auth-do", () => ({
  getUserByEmail: getUserByEmailMock,
}));

vi.mock("@/lib/ban.server", () => ({
  getBanForEmail: getBanForEmailMock,
}));

vi.mock("@/lib/password-reset.server", () => ({
  sendUserPasswordResetEmail: sendUserPasswordResetEmailMock,
}));

vi.mock("@/lib/wait-until", () => ({
  waitUntil: waitUntilMock,
}));

const { action } = await import("@/routes/api/auth.forgot-password");

describe("auth forgot-password route", () => {
  const setPasswordResetNonce = vi.fn().mockResolvedValue(undefined);
  const getPasswordHash = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    const userStub = {
      getPasswordHash,
      setPasswordResetNonce,
    };

    const env = {
      TOKEN_SIGNING_SECRET: "secret",
      WORKER_BASE_URL: "https://camelai.dev",
      USER: {
        idFromName: (id: string) => id,
        get: () => userStub,
      },
    };

    getEnvMock.mockReturnValue(env);
    getAuthEnvMock.mockReturnValue(env);
    getBanForEmailMock.mockResolvedValue(null);
    getPasswordHash.mockResolvedValue("hash");
    sendUserPasswordResetEmailMock.mockResolvedValue({ status: "sent" });
  });

  it("returns a generic success and queues email for password accounts", async () => {
    getUserByEmailMock.mockResolvedValue({
      userId: "user-123",
      user: { email: "test@example.com", name: "Test" },
    });

    const response = await action({
      request: new Request("https://camelai.dev/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "test@example.com" }),
      }),
      context: {},
      params: {},
    } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
    });
    expect(setPasswordResetNonce).toHaveBeenCalledTimes(1);
    expect(waitUntilMock).toHaveBeenCalledTimes(1);
    expect(sendUserPasswordResetEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-123",
        email: "test@example.com",
      }),
    );
  });

  it("returns the same success without emailing unknown accounts", async () => {
    getUserByEmailMock.mockResolvedValue(null);

    const response = await action({
      request: new Request("https://camelai.dev/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "missing@example.com" }),
      }),
      context: {},
      params: {},
    } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true });
    expect(setPasswordResetNonce).not.toHaveBeenCalled();
    expect(sendUserPasswordResetEmailMock).not.toHaveBeenCalled();
  });

  it("skips email for oauth-only accounts", async () => {
    getUserByEmailMock.mockResolvedValue({
      userId: "user-123",
      user: { email: "oauth@example.com", name: "OAuth" },
    });
    getPasswordHash.mockResolvedValue(null);

    const response = await action({
      request: new Request("https://camelai.dev/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "oauth@example.com" }),
      }),
      context: {},
      params: {},
    } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true });
    expect(setPasswordResetNonce).not.toHaveBeenCalled();
    expect(sendUserPasswordResetEmailMock).not.toHaveBeenCalled();
  });

  it("requires an email", async () => {
    const response = await action({
      request: new Request("https://camelai.dev/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
      context: {},
      params: {},
    } as never);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Email is required",
    });
  });
});
