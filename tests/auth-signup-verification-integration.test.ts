import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  backgroundTasks: [] as Promise<unknown>[],
  completePasswordSignup: vi.fn(),
  createSession: vi.fn(),
  getBanForEmail: vi.fn(),
  getUserOrgs: vi.fn(),
  isSignupIpBlocked: vi.fn(),
  listUserWorkspaces: vi.fn(),
  markEmailVerified: vi.fn(),
  requireAuthContext: vi.fn(),
  validateTurnstileToken: vi.fn(),
}));

vi.mock("@/lib/auth-do", () => ({
  completePasswordSignup: mocks.completePasswordSignup,
  createSession: mocks.createSession,
  getUserOrgs: mocks.getUserOrgs,
  isSignupIpBlocked: mocks.isSignupIpBlocked,
  listUserWorkspaces: mocks.listUserWorkspaces,
}));

vi.mock("@/lib/auth.server", () => ({
  requireAuthContext: mocks.requireAuthContext,
}));

vi.mock("@/lib/ban.server", () => ({
  getBanForEmail: mocks.getBanForEmail,
}));

vi.mock("@/lib/turnstile.server", () => ({
  validateTurnstileToken: mocks.validateTurnstileToken,
}));

vi.mock("@/lib/wait-until", () => ({
  waitUntil: (task: Promise<unknown>) => {
    mocks.backgroundTasks.push(task);
  },
}));

import { action as signup } from "@/routes/api/auth.signup";
import { loader as getLatestVerificationEmail } from "@/routes/api/dev.email-verification.latest";
import { loader as verifyEmail } from "@/routes/api/auth.verify-email";

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

  async list(options: { prefix?: string; limit?: number } = {}) {
    const keys = [...this.data.keys()]
      .filter((key) => !options.prefix || key.startsWith(options.prefix))
      .sort()
      .slice(0, options.limit);

    return {
      keys: keys.map((name) => ({ name })),
      list_complete: true,
    };
  }
}

describe("email signup verification integration", () => {
  const email = "integration-signup@example.com";
  const userId = "integration-user";
  const orgId = "integration-org";
  const workspaceId = "integration-workspace";

  let env: Record<string, unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.backgroundTasks.length = 0;

    const appKv = new MemoryKvNamespace();
    const userStub = {
      getProfile: vi.fn().mockResolvedValue({
        id: userId,
        email,
        name: "Integration User",
      }),
      markEmailVerified: mocks.markEmailVerified,
    };

    env = {
      APP_KV: appKv,
      EMAIL_TO_USER: new MemoryKvNamespace(),
      NEXTJS_ENV: "development",
      ORG: {},
      SESSIONS: new MemoryKvNamespace(),
      TOKEN_SIGNING_SECRET: "integration-test-signing-secret",
      USER: {
        idFromName: (id: string) => id,
        get: () => userStub,
      },
      WORKER_BASE_URL: "https://camelai.dev",
      WORKSPACE: {},
    };

    mocks.validateTurnstileToken.mockResolvedValue({ success: true });
    mocks.isSignupIpBlocked.mockResolvedValue(false);
    mocks.getBanForEmail.mockResolvedValue(null);
    mocks.completePasswordSignup.mockResolvedValue({
      status: "ready",
      userId,
      user: { email, name: "Integration User" },
      orgId,
      workspaceId,
    });
    mocks.createSession.mockImplementation(async () => ({
      signedToken: `signed-session-${mocks.createSession.mock.calls.length}`,
    }));
    mocks.getUserOrgs.mockResolvedValue([{ org_id: orgId }]);
    mocks.listUserWorkspaces.mockResolvedValue([{ id: workspaceId }]);
    mocks.requireAuthContext.mockResolvedValue({ user: { email } });
  });

  it("captures the real email and creates a fresh session from its signed link", async () => {
    const context = { cloudflare: { env } };
    const signupResponse = await signup({
      request: new Request("https://camelai.dev/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password: "a-secure-test-password",
          name: "Integration User",
          turnstileToken: "test-turnstile-token",
        }),
      }),
      context,
    } as never);

    expect(signupResponse.status).toBe(200);
    expect(signupResponse.headers.get("Set-Cookie")).toContain(
      "chiridion_session_v3=signed-session-1",
    );
    await Promise.all(mocks.backgroundTasks);

    const emailResponse = await getLatestVerificationEmail({
      request: new Request(
        "https://camelai.dev/api/dev/email-verification/latest",
        { headers: { Cookie: signupResponse.headers.get("Set-Cookie")! } },
      ),
      context,
    } as never);
    expect(emailResponse.status).toBe(200);

    const { verificationUrl } = (await emailResponse.json()) as {
      verificationUrl: string;
    };
    expect(verificationUrl).toMatch(
      /^https:\/\/camelai\.dev\/api\/auth\/verify-email\?token=ev_/,
    );

    const verificationRequest = new Request(verificationUrl);
    expect(verificationRequest.headers.has("Cookie")).toBe(false);
    const verificationResponse = await verifyEmail({
      request: verificationRequest,
      context,
    });

    expect(verificationResponse.status).toBe(302);
    expect(verificationResponse.headers.get("Location")).toBe(
      "https://camelai.dev/onboarding?emailVerified=1",
    );
    expect(verificationResponse.headers.get("Set-Cookie")).toContain(
      "chiridion_session_v3=signed-session-2",
    );
    expect(mocks.markEmailVerified).toHaveBeenCalledOnce();
    expect(mocks.createSession).toHaveBeenLastCalledWith(
      expect.anything(),
      userId,
      orgId,
      workspaceId,
      { name: "Integration User", email },
    );
  });
});
