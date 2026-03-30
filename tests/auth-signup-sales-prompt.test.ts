import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const waitUntilMock = vi.fn();
const getEnvMock = vi.fn();
const createSessionCookieHeaderMock = vi.fn();
const getUserByEmailMock = vi.fn();
const createUserMock = vi.fn();
const createOrgMock = vi.fn();
const createSessionMock = vi.fn();
const isSignupIpBlockedMock = vi.fn();
const sendUserVerificationEmailMock = vi.fn();
const fetchMock = vi.fn();
const originalFetch = globalThis.fetch;

let action: typeof import("@/routes/api/auth.signup").action;

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

function buildSignupBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    email: "test@example.com",
    password: "supersecret",
    name: "Test User",
    redirectTo: "/chat?prompt_key=sales-key-123",
    turnstileToken: "turnstile-token",
    turnstileResponse: "turnstile-token",
    "cf-turnstile-response": "turnstile-token",
    ...overrides,
  });
}

describe("auth signup sales prompt flow", () => {
  let setPendingSalesPromptMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    setPendingSalesPromptMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;

    vi.doMock("@/lib/wait-until", () => ({
      waitUntil: waitUntilMock,
    }));
    vi.doMock("@/lib/cloudflare.server", () => ({
      getEnv: getEnvMock,
    }));
    vi.doMock("@/lib/cookies.server", () => ({
      createSessionCookieHeader: createSessionCookieHeaderMock,
    }));
    vi.doMock("@/lib/auth-do", () => ({
      getUserByEmail: getUserByEmailMock,
      createUser: createUserMock,
      createOrg: createOrgMock,
      createSession: createSessionMock,
      isSignupIpBlocked: isSignupIpBlockedMock,
    }));
    vi.doMock("@/lib/email-verification.server", () => ({
      sendUserVerificationEmail: sendUserVerificationEmailMock,
    }));
    vi.doUnmock("@/lib/turnstile.server");

    // waitUntil runs callbacks synchronously in tests so we can assert side effects
    waitUntilMock.mockImplementation((p: Promise<unknown>) => {
      p.catch(() => {});
    });

    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          action: "email_signup",
          hostname: "camelai.dev",
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        },
      ),
    );

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
      NEXTJS_ENV: "production",
      TOKEN_SIGNING_SECRET: "secret",
      TURNSTILE_SECRET_KEY: "turnstile-secret",
      TURNSTILE_SITE_KEY: "turnstile-site-key",
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
    isSignupIpBlockedMock.mockResolvedValue(false);
    sendUserVerificationEmailMock.mockResolvedValue({ status: "sent" });

    ({ action } = await import("@/routes/api/auth.signup"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
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
        body: buildSignupBody(),
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

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("challenges.cloudflare.com/turnstile/v0/siteverify"),
      expect.objectContaining({
        method: "POST",
      }),
    );

    const turnstileBody = (
      fetchMock.mock.calls[0]?.[1] as { body?: FormData } | undefined
    )?.body;
    expect(turnstileBody).toBeInstanceOf(FormData);
    expect(turnstileBody?.get("secret")).toBe("turnstile-secret");
    expect(turnstileBody?.get("response")).toBe("turnstile-token");
  });

  it("sends verification email without prompt_key", async () => {
    const response = await action({
      request: new Request("https://camelai.dev/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: buildSignupBody(),
      }),
      context: {},
    } as never);

    expect(response.status).toBe(200);
    expect(sendUserVerificationEmailMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ promptKey: expect.anything() }),
    );
  });

  it("rejects signup when turnstile verification fails before creating a user", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: false,
          "error-codes": ["invalid-input-response"],
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        },
      ),
    );

    const response = await action({
      request: new Request("https://camelai.dev/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: buildSignupBody(),
      }),
      context: {},
    } as never);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        error: expect.stringMatching(/security check failed/i),
      }),
    );
    expect(getUserByEmailMock).not.toHaveBeenCalled();
    expect(createUserMock).not.toHaveBeenCalled();
    expect(createOrgMock).not.toHaveBeenCalled();
    expect(createSessionMock).not.toHaveBeenCalled();
  });

  it("rejects signup when turnstile hostname does not match the request host", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          action: "email_signup",
          hostname: "staging.camelai.dev",
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        },
      ),
    );

    const response = await action({
      request: new Request("https://camelai.dev/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: buildSignupBody(),
      }),
      context: {},
    } as never);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        error: expect.stringMatching(/security check failed/i),
      }),
    );
    expect(getUserByEmailMock).not.toHaveBeenCalled();
    expect(createUserMock).not.toHaveBeenCalled();
    expect(createOrgMock).not.toHaveBeenCalled();
    expect(createSessionMock).not.toHaveBeenCalled();
  });

  it("rejects signup before any account work when no turnstile token is provided", async () => {
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

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getUserByEmailMock).not.toHaveBeenCalled();
    expect(createUserMock).not.toHaveBeenCalled();
    expect(createOrgMock).not.toHaveBeenCalled();
    expect(createSessionMock).not.toHaveBeenCalled();
  });
});
