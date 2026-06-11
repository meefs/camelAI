import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionData } from "@/lib/auth-helpers";

const cookiesMocks = vi.hoisted(() => ({
  getSignedSessionFromRequest: vi.fn(),
}));
const cloudflareMocks = vi.hoisted(() => ({
  getEnv: vi.fn(),
}));
const authHelpersMocks = vi.hoisted(() => ({
  getAuthEnv: vi.fn(),
}));
const accessAuthMocks = vi.hoisted(() => ({
  tryCloudflareAccessSilentLogin: vi.fn(),
}));
const banMocks = vi.hoisted(() => ({
  redirectIfBannedSession: vi.fn(),
}));

vi.mock("@/lib/cookies.server", () => cookiesMocks);
vi.mock("@/lib/cloudflare.server", () => cloudflareMocks);
vi.mock("@/lib/auth-helpers", () => authHelpersMocks);
vi.mock("@/lib/cloudflare-access-auth.server", () => accessAuthMocks);
vi.mock("@/lib/ban.server", () => banMocks);

describe("Cloudflare Access session ban checks", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    cloudflareMocks.getEnv.mockReturnValue({ TOKEN_SIGNING_SECRET: "secret" });
    authHelpersMocks.getAuthEnv.mockReturnValue({});
    cookiesMocks.getSignedSessionFromRequest.mockResolvedValue(null);
    banMocks.redirectIfBannedSession.mockResolvedValue(undefined);
  });

  it("checks bans before returning an Access-created session", async () => {
    const session: SessionData = {
      user_id: "user-1",
      org_id: "org-1",
      workspace_id: "workspace-1",
      created_at: 123,
      last_accessed: 123,
      user_name: "Access User",
      user_email: "access@example.com",
    };
    accessAuthMocks.tryCloudflareAccessSilentLogin.mockResolvedValue({
      session,
      signedToken: "signed-token",
      user: { id: "user-1", email: "access@example.com", name: "Access User" },
      orgs: [{ id: "org-1", name: "Access Org" }],
    });
    const request = new Request("https://app.example.com/private", {
      headers: { "Cf-Access-Jwt-Assertion": "token" },
    });
    const context = {} as never;
    const { getSession } = await import("@/lib/auth.server");

    await expect(getSession(request, context)).resolves.toMatchObject({
      session,
      createdSessionCookie: "signed-token",
    });

    expect(banMocks.redirectIfBannedSession).toHaveBeenCalledWith(
      request,
      context,
      {
        userId: "user-1",
        userEmail: "access@example.com",
        orgId: "org-1",
      },
    );
  });
});
