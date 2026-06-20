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
  CLOUDFLARE_ACCESS_AUTH_SOURCE: "cloudflare_access",
  tryCloudflareAccessSilentLogin: vi.fn(),
}));
const pomeriumAuthMocks = vi.hoisted(() => ({
  tryPomeriumSilentLogin: vi.fn(),
}));
// auth.server now validates and dispatches through the generic provider
// registry; mock it instead of the Cloudflare-specific validator.
const proxyProviderMocks = vi.hoisted(() => ({
  isProxyAuthSource: vi.fn(),
  validateSessionMapsToOrg: vi.fn(),
}));
const banMocks = vi.hoisted(() => ({
  redirectIfBannedSession: vi.fn(),
}));

vi.mock("@/lib/cookies.server", () => cookiesMocks);
vi.mock("@/lib/cloudflare.server", () => cloudflareMocks);
vi.mock("@/lib/auth-helpers", () => authHelpersMocks);
vi.mock("@/lib/cloudflare-access-auth.server", () => accessAuthMocks);
vi.mock("@/lib/pomerium-auth.server", () => pomeriumAuthMocks);
vi.mock(
  "../workers/main/src/helpers/proxy-auth-providers",
  () => proxyProviderMocks,
);
vi.mock("@/lib/ban.server", () => banMocks);

describe("Cloudflare Access session ban checks", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    cloudflareMocks.getEnv.mockReturnValue({ TOKEN_SIGNING_SECRET: "secret" });
    authHelpersMocks.getAuthEnv.mockReturnValue({});
    cookiesMocks.getSignedSessionFromRequest.mockResolvedValue(null);
    pomeriumAuthMocks.tryPomeriumSilentLogin.mockResolvedValue(null);
    proxyProviderMocks.isProxyAuthSource.mockImplementation(
      (source: string | null | undefined) =>
        source === "cloudflare_access" || source === "pomerium",
    );
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

  it("refreshes Access-created signed sessions that fail revalidation", async () => {
    const refreshedSession: SessionData = {
      user_id: "user-2",
      org_id: "org-2",
      workspace_id: "workspace-2",
      created_at: 456,
      last_accessed: 456,
      user_name: "Current Access User",
      user_email: "current@example.com",
      auth_source: "cloudflare_access",
    };
    cookiesMocks.getSignedSessionFromRequest.mockResolvedValue({
      user_id: "user-1",
      org_id: "org-1",
      workspace_id: "workspace-1",
      created_at: 123,
      user_name: "Access User",
      user_email: "access@example.com",
      auth_source: "cloudflare_access",
    });
    proxyProviderMocks.validateSessionMapsToOrg.mockResolvedValue(
      "invalid",
    );
    accessAuthMocks.tryCloudflareAccessSilentLogin.mockResolvedValue({
      session: refreshedSession,
      signedToken: "refreshed-token",
      user: {
        id: "user-2",
        email: "current@example.com",
        name: "Current Access User",
      },
      orgs: [{ id: "org-2", name: "Current Access Org" }],
    });
    const request = new Request("https://app.example.com/private", {
      headers: { "Cf-Access-Jwt-Assertion": "token" },
    });
    const { getSession } = await import("@/lib/auth.server");

    await expect(getSession(request, {} as never)).resolves.toMatchObject({
      session: refreshedSession,
      createdSessionCookie: "refreshed-token",
    });
    expect(banMocks.redirectIfBannedSession).toHaveBeenCalledWith(
      request,
      {},
      {
        userId: "user-2",
        userEmail: "current@example.com",
        orgId: "org-2",
      },
    );
    expect(accessAuthMocks.tryCloudflareAccessSilentLogin).toHaveBeenCalled();
  });

  it("returns null for invalid Access-created signed sessions when silent login is unavailable", async () => {
    cookiesMocks.getSignedSessionFromRequest.mockResolvedValue({
      user_id: "user-1",
      org_id: "org-1",
      workspace_id: "workspace-1",
      created_at: 123,
      user_name: "Access User",
      user_email: "access@example.com",
      auth_source: "cloudflare_access",
    });
    proxyProviderMocks.validateSessionMapsToOrg.mockResolvedValue(
      "invalid",
    );
    accessAuthMocks.tryCloudflareAccessSilentLogin.mockResolvedValue(null);
    const request = new Request("https://app.example.com/private");
    const { getSession } = await import("@/lib/auth.server");

    await expect(getSession(request, {} as never)).resolves.toBeNull();
    expect(banMocks.redirectIfBannedSession).not.toHaveBeenCalled();
  });

  it("surfaces a 503 when Access revalidation is temporarily unavailable", async () => {
    cookiesMocks.getSignedSessionFromRequest.mockResolvedValue({
      user_id: "user-1",
      org_id: "org-1",
      workspace_id: "workspace-1",
      created_at: 123,
      user_name: "Access User",
      user_email: "access@example.com",
      auth_source: "cloudflare_access",
    });
    proxyProviderMocks.validateSessionMapsToOrg.mockResolvedValue(
      "unavailable",
    );
    const request = new Request("https://app.example.com/private", {
      headers: { "Cf-Access-Jwt-Assertion": "token" },
    });
    const { getSession } = await import("@/lib/auth.server");

    await expect(getSession(request, {} as never)).rejects.toMatchObject({
      status: 503,
    });
    expect(banMocks.redirectIfBannedSession).not.toHaveBeenCalled();
  });

  it("accepts Access-created signed sessions that pass read-only revalidation", async () => {
    cookiesMocks.getSignedSessionFromRequest.mockResolvedValue({
      user_id: "user-1",
      org_id: "org-1",
      workspace_id: "workspace-1",
      created_at: 123,
      user_name: "Access User",
      user_email: "access@example.com",
      auth_source: "cloudflare_access",
    });
    proxyProviderMocks.validateSessionMapsToOrg.mockResolvedValue(
      "valid",
    );
    const userStub = {
      getSessionInvalidatedAt: vi.fn(async () => null),
    };
    authHelpersMocks.getAuthEnv.mockReturnValue({
      USER: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => userStub),
      },
    });
    const request = new Request("https://app.example.com/private", {
      headers: { "Cf-Access-Jwt-Assertion": "token" },
    });
    const { getSession } = await import("@/lib/auth.server");

    await expect(getSession(request, {} as never)).resolves.toMatchObject({
      session: {
        user_id: "user-1",
        org_id: "org-1",
        auth_source: "cloudflare_access",
      },
    });
    // The revalidation path must stay read-only: the mutating silent-login
    // provisioning flow runs only when no signed cookie exists.
    expect(accessAuthMocks.tryCloudflareAccessSilentLogin).not.toHaveBeenCalled();
    expect(banMocks.redirectIfBannedSession).toHaveBeenCalledWith(
      request,
      {},
      {
        userId: "user-1",
        userEmail: "access@example.com",
        orgId: "org-1",
      },
    );
  });
});
