import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAuthContextMock = vi.fn();
const getEnvMock = vi.fn();
const isDevEmailOutboxEnabledMock = vi.fn();
const listDevEmailOutboxEntriesMock = vi.fn();

vi.mock("@/lib/auth.server", () => ({
  requireAuthContext: requireAuthContextMock,
}));

vi.mock("@/lib/cloudflare.server", () => ({
  getEnv: getEnvMock,
}));

vi.mock("@/lib/dev-email-outbox", () => ({
  isDevEmailOutboxEnabled: isDevEmailOutboxEnabledMock,
  listDevEmailOutboxEntries: listDevEmailOutboxEntriesMock,
}));

const { loader } = await import("@/routes/api/dev.email-verification.latest");

function verificationEmail(to: string, textBody: string) {
  return {
    id: "email_123",
    createdAt: "2026-07-17T21:00:00.000Z",
    to,
    subject: "Verify your email for camelAI",
    textBody,
    htmlBody: "<p>Verify</p>",
    status: "skipped",
    transport: "none",
  };
}

describe("dev email verification api", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEnvMock.mockReturnValue({});
    isDevEmailOutboxEnabledMock.mockReturnValue(true);
    requireAuthContextMock.mockResolvedValue({
      user: { email: "signup@example.com" },
    });
    listDevEmailOutboxEntriesMock.mockResolvedValue({
      entries: [],
      cursor: undefined,
      listComplete: true,
    });
  });

  it("returns only the current user's latest verification URL", async () => {
    listDevEmailOutboxEntriesMock.mockResolvedValue({
      entries: [
        verificationEmail(
          "someone-else@example.com",
          "https://camelai.dev/api/auth/verify-email?token=other-token",
        ),
        verificationEmail(
          "SIGNUP@example.com",
          "Open https://camelai.dev/api/auth/verify-email?token=test-token to verify.",
        ),
      ],
      cursor: undefined,
      listComplete: true,
    });

    const response = await loader({
      request: new Request(
        "https://camelai.dev/api/dev/email-verification/latest",
      ),
      context: {},
    } as never);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      verificationUrl:
        "https://camelai.dev/api/auth/verify-email?token=test-token",
      createdAt: "2026-07-17T21:00:00.000Z",
    });
  });

  it("returns 404 when the development outbox is disabled", async () => {
    isDevEmailOutboxEnabledMock.mockReturnValue(false);

    const response = await loader({
      request: new Request(
        "https://camelai.dev/api/dev/email-verification/latest",
      ),
      context: {},
    } as never);

    expect(response.status).toBe(404);
    expect(requireAuthContextMock).not.toHaveBeenCalled();
  });

  it("does not expose another user's verification email", async () => {
    listDevEmailOutboxEntriesMock.mockResolvedValue({
      entries: [
        verificationEmail(
          "someone-else@example.com",
          "https://camelai.dev/api/auth/verify-email?token=other-token",
        ),
      ],
      cursor: undefined,
      listComplete: true,
    });

    const response = await loader({
      request: new Request(
        "https://camelai.dev/api/dev/email-verification/latest",
      ),
      context: {},
    } as never);

    expect(response.status).toBe(404);
  });
});
