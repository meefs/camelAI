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

class MemoryKvNamespace {
  private readonly data = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

describe("auth signup sales prompt flow", () => {
  let setPendingSalesPromptMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    setPendingSalesPromptMock = vi.fn();

    // waitUntil runs callbacks synchronously in tests so we can assert side effects
    waitUntilMock.mockImplementation((p: Promise<unknown>) => {
      p.catch(() => {});
    });

    getEnvMock.mockReturnValue({
      USER: {
        idFromName: (id: string) => id,
        get: () => ({
          setPendingSalesPrompt: setPendingSalesPromptMock,
        }),
      },
      ORG: {},
      WORKSPACE: {},
      SESSIONS: {},
      EMAIL_TO_USER: {},
      APP_KV: new MemoryKvNamespace(),
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

  it("consumes KV prompt during signup and stores it on the UserDO", async () => {
    const kv = new MemoryKvNamespace();
    await kv.put(
      "sales_prompt:sales-key-123",
      JSON.stringify({
        prompt: "Build me a CRM",
        createdAt: Date.now(),
      }),
    );
    getEnvMock.mockReturnValue({
      ...getEnvMock(),
      APP_KV: kv,
    });

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

    // Wait for background tasks to complete
    await new Promise((resolve) => setTimeout(resolve, 10));

    // KV entry should be consumed (deleted)
    await expect(kv.get("sales_prompt:sales-key-123")).resolves.toBeNull();

    // Prompt should be stored on UserDO
    expect(setPendingSalesPromptMock).toHaveBeenCalledWith("Build me a CRM");
  });

  it("sends verification email without prompt_key", async () => {
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
      expect.not.objectContaining({ promptKey: expect.anything() }),
    );
  });
});
