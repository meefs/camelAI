import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authDoMocks = vi.hoisted(() => ({
  createOrg: vi.fn(),
  createSession: vi.fn(),
  createUserFromOAuth: vi.fn(),
  getUserByEmail: vi.fn(),
  linkOAuthProvider: vi.fn(),
}));

vi.mock("@/lib/auth-do", () => authDoMocks);

import {
  getCloudflareAccessLogoutUrl,
  isCloudflareAccessConfigured,
  tryCloudflareAccessSilentLogin,
  type CloudflareAccessEnv,
} from "@/lib/cloudflare-access-auth.server";
import type { AuthEnv } from "@/lib/auth-helpers";
import { createAccessJwt, jsonResponse } from "./helpers/access-jwt";

function accessEnv(
  values: Partial<CloudflareAccessEnv> = {},
): CloudflareAccessEnv {
  return {
    APP_KV: {} as KVNamespace,
    ...values,
  };
}


function authEnvWithExistingOrg() {
  const kv = new Map<string, string>([
    [
      "cloudflare_access:org:https://team.cloudflareaccess.com:group:austin",
      "org-austin",
    ],
  ]);
  const orgStub = {
    getInfo: vi.fn(async () => ({ id: "org-austin", name: "Austin" })),
    getWorkspaces: vi.fn(async () => [{ id: "workspace-austin", archived: false }]),
    getMember: vi.fn(async () => ({ role: "member" })),
    addMember: vi.fn(async () => undefined),
    updateMemberRole: vi.fn(async () => undefined),
    setWorkspaceAccess: vi.fn(async () => undefined),
  };
  const userStub = {
    hasOrg: vi.fn(async () => true),
    getOrgs: vi.fn(async () => [] as Array<Record<string, unknown>>),
    updateOrgRole: vi.fn(async () => undefined),
    setOrgLastWorkspace: vi.fn(async () => undefined),
  };
  const workspaceStub = {
    setMemberAccess: vi.fn(async () => undefined),
  };

  return {
    env: {
      APP_KV: {
        get: vi.fn(async (key: string) => kv.get(key) ?? null),
        put: vi.fn(async (key: string, value: string) => {
          kv.set(key, value);
        }),
      },
      ORG: {
        idFromName: (name: string) => name,
        get: vi.fn(() => orgStub),
      },
      USER: {
        idFromName: (name: string) => name,
        get: vi.fn(() => userStub),
      },
      WORKSPACE: {
        idFromName: (name: string) => name,
        get: vi.fn(() => workspaceStub),
      },
    } as unknown as AuthEnv,
    orgStub,
    userStub,
  };
}

function authEnvWithMissingOrg() {
  const createdOrgStub = {
    getInfo: vi.fn(async () => ({ id: "org-created", name: "Austin" })),
    getWorkspaces: vi.fn(async () => [{ id: "workspace-created", archived: false }]),
    getMember: vi.fn(async () => ({ role: "member" })),
    addMember: vi.fn(async () => undefined),
    updateMemberRole: vi.fn(async () => undefined),
    setWorkspaceAccess: vi.fn(async () => undefined),
  };
  const lockStub = {
    ensureAccessMappedOrg: vi.fn(async () => ({
      org: { id: "org-created", name: "Austin" },
      defaultWorkspaceId: "workspace-created",
    })),
  };
  const userStub = {
    hasOrg: vi.fn(async () => true),
    getOrgs: vi.fn(async () => [] as Array<Record<string, unknown>>),
    addOrg: vi.fn(async () => undefined),
    updateOrgRole: vi.fn(async () => undefined),
    setOrgLastWorkspace: vi.fn(async () => undefined),
  };
  const workspaceStub = {
    setMemberAccess: vi.fn(async () => undefined),
  };
  const idFromName = vi.fn((name: string) => name);
  const orgGet = vi.fn((id: string) => {
    if (id.startsWith("cloudflare_access:org_lock:")) return lockStub;
    return createdOrgStub;
  });

  return {
    env: {
      APP_KV: {
        get: vi.fn(async () => null),
        put: vi.fn(async () => undefined),
      },
      ORG: {
        idFromName,
        get: orgGet,
      },
      USER: {
        idFromName: (name: string) => name,
        get: vi.fn(() => userStub),
      },
      WORKSPACE: {
        idFromName: (name: string) => name,
        get: vi.fn(() => workspaceStub),
      },
    } as unknown as AuthEnv,
    lockStub,
    idFromName,
  };
}

describe("Cloudflare Access auth", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    authDoMocks.createOrg.mockReset();
    authDoMocks.createSession.mockReset();
    authDoMocks.createUserFromOAuth.mockReset();
    authDoMocks.getUserByEmail.mockReset();
    authDoMocks.linkOAuthProvider.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requires both a team domain and audience to be configured", () => {
    expect(isCloudflareAccessConfigured(accessEnv())).toBe(false);
    expect(
      isCloudflareAccessConfigured(
        accessEnv({
          CLOUDFLARE_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
        }),
      ),
    ).toBe(false);
    expect(
      isCloudflareAccessConfigured(
        accessEnv({
          CLOUDFLARE_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
          CLOUDFLARE_ACCESS_AUD: "aud",
        }),
      ),
    ).toBe(true);
  });

  it("does nothing when the Access assertion header is absent", async () => {
    await expect(
      tryCloudflareAccessSilentLogin(
        new Request("https://app.example.com/login"),
        accessEnv({
          CLOUDFLARE_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
          CLOUDFLARE_ACCESS_AUD: "aud",
        }),
        {} as AuthEnv,
      ),
    ).resolves.toBeNull();
  });

  it("leaves normal login available when Access headers arrive without config", async () => {
    await expect(
      tryCloudflareAccessSilentLogin(
        new Request("https://app.example.com/login", {
          headers: { "Cf-Access-Jwt-Assertion": "not.a.real.jwt" },
        }),
        accessEnv(),
        {} as AuthEnv,
      ),
    ).resolves.toBeNull();
  });

  it("builds the Access logout URL on the application origin", () => {
    expect(
      getCloudflareAccessLogoutUrl(
        new Request("https://app.example.com/settings"),
        accessEnv({
          CLOUDFLARE_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
          CLOUDFLARE_ACCESS_AUD: "aud",
        }),
      ),
    ).toBe("https://app.example.com/cdn-cgi/access/logout");
    expect(
      getCloudflareAccessLogoutUrl(
        new Request("https://app.example.com/settings"),
        accessEnv(),
      ),
    ).toBeNull();
  });

  it("rejects banned Access email before auth mutations", async () => {
    const { token, publicJwk } = await createAccessJwt({
      aud: "aud",
      email: "blocked@example.com",
      exp: Math.floor(Date.now() / 1000) + 60,
      iss: "https://team.cloudflareaccess.com",
      sub: "access-user",
    });
    const { env } = authEnvWithMissingOrg();
    const banRecord = {
      scope: "user",
      target_id: "user-1",
      email: "blocked@example.com",
      org_slug: null,
      reason: "blocked",
      created_at: Date.now(),
      created_by: "admin",
      status: "active",
      purge_status: "pending",
      purge_job_id: null,
      purge_started_at: null,
      purge_completed_at: null,
      purge_error: null,
    };
    env.APP_KV.get = vi.fn(async (key: string) =>
      key === "ban:user:email:blocked@example.com"
        ? JSON.stringify(banRecord)
        : null,
    ) as unknown as KVNamespace["get"];
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const value = url instanceof Request ? url.url : url.toString();
      if (value.endsWith("/cdn-cgi/access/certs")) {
        return jsonResponse({ keys: [publicJwk] });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      tryCloudflareAccessSilentLogin(
        new Request("https://app.example.com/login", {
          headers: { "Cf-Access-Jwt-Assertion": token },
        }),
        accessEnv({
          CLOUDFLARE_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
          CLOUDFLARE_ACCESS_AUD: "aud",
          CLOUDFLARE_ACCESS_ORG_GROUP_PREFIX: "camelai-office-",
        }),
        env,
      ),
    ).rejects.toMatchObject({ status: 403 });

    expect(fetchMock).not.toHaveBeenCalledWith(
      "https://team.cloudflareaccess.com/cdn-cgi/access/get-identity",
      expect.any(Object),
    );
    expect(authDoMocks.getUserByEmail).not.toHaveBeenCalled();
    expect(authDoMocks.linkOAuthProvider).not.toHaveBeenCalled();
    expect(authDoMocks.createUserFromOAuth).not.toHaveBeenCalled();
    expect(authDoMocks.createSession).not.toHaveBeenCalled();
  });

  it("fetches full Access identity from the team domain", async () => {
    const { token, publicJwk } = await createAccessJwt({
      aud: "aud",
      email: "admin@example.com",
      exp: Math.floor(Date.now() / 1000) + 60,
      iss: "https://team.cloudflareaccess.com",
      sub: "access-user",
    });
    const { env } = authEnvWithExistingOrg();
    authDoMocks.getUserByEmail.mockResolvedValue({
      userId: "user-1",
      user: { id: "user-1", email: "admin@example.com", name: "Admin User" },
    });
    authDoMocks.linkOAuthProvider.mockResolvedValue(undefined);
    authDoMocks.createSession.mockResolvedValue({
      signedToken: "signed-token",
      sessionData: {
        user_id: "user-1",
        org_id: "org-austin",
        workspace_id: "workspace-austin",
        created_at: Date.now(),
        last_accessed: Date.now(),
        user_email: "admin@example.com",
        user_name: "Admin User",
      },
    });
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const value = url instanceof Request ? url.url : url.toString();
      if (value === "https://team.cloudflareaccess.com/cdn-cgi/access/certs") {
        return jsonResponse({ keys: [publicJwk] });
      }
      if (value === "https://team.cloudflareaccess.com/cdn-cgi/access/get-identity") {
        return jsonResponse({
          user_uuid: "access-user",
          name: "Admin User",
          idp: { groups: ["camelai-office-admin-austin"] },
        });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      tryCloudflareAccessSilentLogin(
        new Request("https://app.example.com/login", {
          headers: { "Cf-Access-Jwt-Assertion": token },
        }),
        accessEnv({
          CLOUDFLARE_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
          CLOUDFLARE_ACCESS_AUD: "aud",
          CLOUDFLARE_ACCESS_ADMIN_GROUP_PREFIX: "camelai-office-admin-",
        }),
        env,
      ),
    ).resolves.toMatchObject({
      signedToken: "signed-token",
      session: { org_id: "org-austin" },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://team.cloudflareaccess.com/cdn-cgi/access/get-identity",
      expect.any(Object),
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      "https://app.example.com/cdn-cgi/access/get-identity",
      expect.any(Object),
    );
  });

  it("uses the same org key for member and admin groups", async () => {
    const { token, publicJwk } = await createAccessJwt({
      aud: "aud",
      email: "admin@example.com",
      exp: Math.floor(Date.now() / 1000) + 60,
      iss: "https://team.cloudflareaccess.com",
      sub: "access-user",
    });
    const { env, orgStub, userStub } = authEnvWithExistingOrg();
    authDoMocks.getUserByEmail.mockResolvedValue({
      userId: "user-1",
      user: { id: "user-1", email: "admin@example.com", name: "Admin User" },
    });
    authDoMocks.linkOAuthProvider.mockResolvedValue(undefined);
    authDoMocks.createSession.mockResolvedValue({
      signedToken: "signed-token",
      sessionData: {
        user_id: "user-1",
        org_id: "org-austin",
        workspace_id: "workspace-austin",
        created_at: Date.now(),
        last_accessed: Date.now(),
        user_email: "admin@example.com",
        user_name: "Admin User",
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const value = url instanceof Request ? url.url : url.toString();
        if (value.endsWith("/cdn-cgi/access/certs")) {
          return jsonResponse({ keys: [publicJwk] });
        }
        if (value.endsWith("/cdn-cgi/access/get-identity")) {
          return jsonResponse({
            user_uuid: "access-user",
            name: "Admin User",
            idp: {
              groups: [
                "camelai-office-austin",
                "camelai-office-admin-austin",
              ],
            },
          });
        }
        return new Response(null, { status: 404 });
      }),
    );

    await tryCloudflareAccessSilentLogin(
      new Request("https://app.example.com/login", {
        headers: { "Cf-Access-Jwt-Assertion": token },
      }),
      accessEnv({
        CLOUDFLARE_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
        CLOUDFLARE_ACCESS_AUD: "aud",
        CLOUDFLARE_ACCESS_ORG_GROUP_PREFIX: "camelai-office-",
        CLOUDFLARE_ACCESS_ADMIN_GROUP_PREFIX: "camelai-office-admin-",
      }),
      env,
    );

    expect(env.APP_KV.get).toHaveBeenCalledWith(
      "cloudflare_access:org:https://team.cloudflareaccess.com:group:austin",
    );
    expect(authDoMocks.createOrg).not.toHaveBeenCalled();
    expect(orgStub.addMember).not.toHaveBeenCalled();
    expect(orgStub.updateMemberRole).toHaveBeenCalledWith(
      "user-1",
      "admin",
      "cloudflare-access",
    );
    expect(userStub.updateOrgRole).toHaveBeenCalledWith("org-austin", "admin");
  });

  it("serializes first org creation when initialized by an Access admin", async () => {
    const { token, publicJwk } = await createAccessJwt({
      aud: "aud",
      email: "member@example.com",
      exp: Math.floor(Date.now() / 1000) + 60,
      iss: "https://team.cloudflareaccess.com",
      sub: "access-user",
    });
    const { env, idFromName, lockStub } = authEnvWithMissingOrg();
    authDoMocks.getUserByEmail.mockResolvedValue({
      userId: "user-1",
      user: { id: "user-1", email: "member@example.com", name: "Member User" },
    });
    authDoMocks.linkOAuthProvider.mockResolvedValue(undefined);
    authDoMocks.createSession.mockResolvedValue({
      signedToken: "signed-token",
      sessionData: {
        user_id: "user-1",
        org_id: "org-created",
        workspace_id: "workspace-created",
        created_at: Date.now(),
        last_accessed: Date.now(),
        user_email: "member@example.com",
        user_name: "Member User",
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const value = url instanceof Request ? url.url : url.toString();
        if (value.endsWith("/cdn-cgi/access/certs")) {
          return jsonResponse({ keys: [publicJwk] });
        }
        if (value.endsWith("/cdn-cgi/access/get-identity")) {
          return jsonResponse({
            user_uuid: "access-user",
            name: "Member User",
            idp: { groups: ["camelai-office-admin-austin"] },
          });
        }
        return new Response(null, { status: 404 });
      }),
    );

    await expect(
      tryCloudflareAccessSilentLogin(
        new Request("https://app.example.com/login", {
          headers: { "Cf-Access-Jwt-Assertion": token },
        }),
        accessEnv({
          CLOUDFLARE_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
          CLOUDFLARE_ACCESS_AUD: "aud",
          CLOUDFLARE_ACCESS_ORG_GROUP_PREFIX: "camelai-office-",
          CLOUDFLARE_ACCESS_ADMIN_GROUP_PREFIX: "camelai-office-admin-",
        }),
        env,
      ),
    ).resolves.toMatchObject({
      session: { org_id: "org-created" },
    });

    const kvKey =
      "cloudflare_access:org:https://team.cloudflareaccess.com:group:austin";
    expect(idFromName).toHaveBeenCalledWith(`cloudflare_access:org_lock:${kvKey}`);
    expect(lockStub.ensureAccessMappedOrg).toHaveBeenCalledWith(
      kvKey,
      "Austin",
      "user-1",
      "admin",
    );
    expect(authDoMocks.createOrg).not.toHaveBeenCalled();
  });

  it("allows the default Access org to initialize on first login", async () => {
    const { token, publicJwk } = await createAccessJwt({
      aud: "aud",
      email: "member@example.com",
      exp: Math.floor(Date.now() / 1000) + 60,
      iss: "https://team.cloudflareaccess.com",
      sub: "access-user",
    });
    const { env, idFromName, lockStub } = authEnvWithMissingOrg();
    authDoMocks.getUserByEmail.mockResolvedValue({
      userId: "user-1",
      user: { id: "user-1", email: "member@example.com", name: "Member User" },
    });
    authDoMocks.linkOAuthProvider.mockResolvedValue(undefined);
    authDoMocks.createSession.mockResolvedValue({
      signedToken: "signed-token",
      sessionData: {
        user_id: "user-1",
        org_id: "org-created",
        workspace_id: "workspace-created",
        created_at: Date.now(),
        last_accessed: Date.now(),
        user_email: "member@example.com",
        user_name: "Member User",
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const value = url instanceof Request ? url.url : url.toString();
        if (value.endsWith("/cdn-cgi/access/certs")) {
          return jsonResponse({ keys: [publicJwk] });
        }
        if (value.endsWith("/cdn-cgi/access/get-identity")) {
          return jsonResponse({
            user_uuid: "access-user",
            name: "Member User",
            idp: { groups: [] },
          });
        }
        return new Response(null, { status: 404 });
      }),
    );

    await expect(
      tryCloudflareAccessSilentLogin(
        new Request("https://app.example.com/login", {
          headers: { "Cf-Access-Jwt-Assertion": token },
        }),
        accessEnv({
          CLOUDFLARE_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
          CLOUDFLARE_ACCESS_AUD: "aud",
          CLOUDFLARE_ACCESS_DEFAULT_ORG_NAME: "CamelAI",
        }),
        env,
      ),
    ).resolves.toMatchObject({
      session: { org_id: "org-created" },
    });

    const kvKey =
      "cloudflare_access:org:https://team.cloudflareaccess.com:default:CamelAI";
    expect(idFromName).toHaveBeenCalledWith(`cloudflare_access:org_lock:${kvKey}`);
    expect(lockStub.ensureAccessMappedOrg).toHaveBeenCalledWith(
      kvKey,
      "CamelAI",
      "user-1",
      "admin",
    );
    expect(authDoMocks.createOrg).not.toHaveBeenCalled();
  });

  it("rejects member-only first org creation before creating org records", async () => {
    const { token, publicJwk } = await createAccessJwt({
      aud: "aud",
      email: "member@example.com",
      exp: Math.floor(Date.now() / 1000) + 60,
      iss: "https://team.cloudflareaccess.com",
      sub: "access-user",
    });
    const { env, lockStub } = authEnvWithMissingOrg();
    authDoMocks.getUserByEmail.mockResolvedValue({
      userId: "user-1",
      user: { id: "user-1", email: "member@example.com", name: "Member User" },
    });
    authDoMocks.linkOAuthProvider.mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const value = url instanceof Request ? url.url : url.toString();
        if (value.endsWith("/cdn-cgi/access/certs")) {
          return jsonResponse({ keys: [publicJwk] });
        }
        if (value.endsWith("/cdn-cgi/access/get-identity")) {
          return jsonResponse({
            user_uuid: "access-user",
            name: "Member User",
            idp: { groups: ["camelai-office-austin"] },
          });
        }
        return new Response(null, { status: 404 });
      }),
    );

    await expect(
      tryCloudflareAccessSilentLogin(
        new Request("https://app.example.com/login", {
          headers: { "Cf-Access-Jwt-Assertion": token },
        }),
        accessEnv({
          CLOUDFLARE_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
          CLOUDFLARE_ACCESS_AUD: "aud",
          CLOUDFLARE_ACCESS_ORG_GROUP_PREFIX: "camelai-office-",
          CLOUDFLARE_ACCESS_ADMIN_GROUP_PREFIX: "camelai-office-admin-",
        }),
        env,
      ),
    ).rejects.toMatchObject({ status: 403 });

    expect(lockStub.ensureAccessMappedOrg).not.toHaveBeenCalled();
    expect(authDoMocks.linkOAuthProvider).toHaveBeenCalledTimes(1);
    expect(authDoMocks.createSession).not.toHaveBeenCalled();
  });

  it("skips unresolved member candidates so a later admin group can initialize its org", async () => {
    const { token, publicJwk } = await createAccessJwt({
      aud: "aud",
      email: "admin@example.com",
      exp: Math.floor(Date.now() / 1000) + 60,
      iss: "https://team.cloudflareaccess.com",
      sub: "access-user",
    });
    const { env, lockStub } = authEnvWithMissingOrg();
    authDoMocks.getUserByEmail.mockResolvedValue({
      userId: "user-1",
      user: { id: "user-1", email: "admin@example.com", name: "Admin User" },
    });
    authDoMocks.linkOAuthProvider.mockResolvedValue(undefined);
    authDoMocks.createSession.mockResolvedValue({
      signedToken: "signed-token",
      sessionData: {
        user_id: "user-1",
        org_id: "org-created",
        workspace_id: "workspace-created",
        created_at: Date.now(),
        last_accessed: Date.now(),
        user_email: "admin@example.com",
        user_name: "Admin User",
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const value = url instanceof Request ? url.url : url.toString();
        if (value.endsWith("/cdn-cgi/access/certs")) {
          return jsonResponse({ keys: [publicJwk] });
        }
        if (value.endsWith("/cdn-cgi/access/get-identity")) {
          return jsonResponse({
            user_uuid: "access-user",
            name: "Admin User",
            // officeLocation yields an unresolvable member candidate that must
            // not abort processing of the admin group candidate after it.
            officeLocation: "Remote",
            idp: { groups: ["camelai-office-admin-austin"] },
          });
        }
        return new Response(null, { status: 404 });
      }),
    );

    await expect(
      tryCloudflareAccessSilentLogin(
        new Request("https://app.example.com/login", {
          headers: { "Cf-Access-Jwt-Assertion": token },
        }),
        accessEnv({
          CLOUDFLARE_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
          CLOUDFLARE_ACCESS_AUD: "aud",
          CLOUDFLARE_ACCESS_ORG_GROUP_PREFIX: "camelai-office-",
          CLOUDFLARE_ACCESS_ADMIN_GROUP_PREFIX: "camelai-office-admin-",
        }),
        env,
      ),
    ).resolves.toMatchObject({
      session: { org_id: "org-created" },
    });

    expect(lockStub.ensureAccessMappedOrg).toHaveBeenCalledWith(
      "cloudflare_access:org:https://team.cloudflareaccess.com:group:austin",
      "Austin",
      "user-1",
      "admin",
    );
  });

  it("matches explicit org-map entries only at configured claim locations", async () => {
    const { token, publicJwk } = await createAccessJwt({
      aud: "aud",
      email: "member@example.com",
      exp: Math.floor(Date.now() / 1000) + 60,
      iss: "https://team.cloudflareaccess.com",
      sub: "access-user",
    });
    const { env } = authEnvWithExistingOrg();
    (env.APP_KV.get as ReturnType<typeof vi.fn>).mockImplementation(
      async (key: string) =>
        key ===
        "cloudflare_access:org:https://team.cloudflareaccess.com:map:acme-id"
          ? "org-austin"
          : null,
    );
    authDoMocks.getUserByEmail.mockResolvedValue({
      userId: "user-1",
      user: { id: "user-1", email: "member@example.com", name: "Member User" },
    });
    authDoMocks.linkOAuthProvider.mockResolvedValue(undefined);
    authDoMocks.createSession.mockResolvedValue({
      signedToken: "signed-token",
      sessionData: {
        user_id: "user-1",
        org_id: "org-austin",
        workspace_id: "workspace-austin",
        created_at: Date.now(),
        last_accessed: Date.now(),
        user_email: "member@example.com",
        user_name: "Member User",
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const value = url instanceof Request ? url.url : url.toString();
        if (value.endsWith("/cdn-cgi/access/certs")) {
          return jsonResponse({ keys: [publicJwk] });
        }
        if (value.endsWith("/cdn-cgi/access/get-identity")) {
          return jsonResponse({
            user_uuid: "access-user",
            name: "Member User",
            officeLocation: "acme-id",
          });
        }
        return new Response(null, { status: 404 });
      }),
    );

    await expect(
      tryCloudflareAccessSilentLogin(
        new Request("https://app.example.com/login", {
          headers: { "Cf-Access-Jwt-Assertion": token },
        }),
        accessEnv({
          CLOUDFLARE_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
          CLOUDFLARE_ACCESS_AUD: "aud",
          CLOUDFLARE_ACCESS_ORG_MAP: '{"acme-id":"Acme"}',
        }),
        env,
      ),
    ).resolves.toMatchObject({
      session: { org_id: "org-austin" },
    });

    expect(env.APP_KV.get).toHaveBeenCalledWith(
      "cloudflare_access:org:https://team.cloudflareaccess.com:map:acme-id",
    );
  });

  it("does not let org-map members initialize a missing org", async () => {
    const { token, publicJwk } = await createAccessJwt({
      aud: "aud",
      email: "member@example.com",
      exp: Math.floor(Date.now() / 1000) + 60,
      iss: "https://team.cloudflareaccess.com",
      sub: "access-user",
    });
    const { env, lockStub } = authEnvWithMissingOrg();
    authDoMocks.getUserByEmail.mockResolvedValue({
      userId: "user-1",
      user: { id: "user-1", email: "member@example.com", name: "Member User" },
    });
    authDoMocks.linkOAuthProvider.mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const value = url instanceof Request ? url.url : url.toString();
        if (value.endsWith("/cdn-cgi/access/certs")) {
          return jsonResponse({ keys: [publicJwk] });
        }
        if (value.endsWith("/cdn-cgi/access/get-identity")) {
          return jsonResponse({
            user_uuid: "access-user",
            name: "Member User",
            // officeLocation is user-editable in common IdPs; matching an
            // org-map key must not allow creating (and owning) the org.
            officeLocation: "acme-id",
          });
        }
        return new Response(null, { status: 404 });
      }),
    );

    await expect(
      tryCloudflareAccessSilentLogin(
        new Request("https://app.example.com/login", {
          headers: { "Cf-Access-Jwt-Assertion": token },
        }),
        accessEnv({
          CLOUDFLARE_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
          CLOUDFLARE_ACCESS_AUD: "aud",
          CLOUDFLARE_ACCESS_ORG_MAP: '{"acme-id":"Acme"}',
        }),
        env,
      ),
    ).rejects.toMatchObject({ status: 403 });

    expect(lockStub.ensureAccessMappedOrg).not.toHaveBeenCalled();
    expect(authDoMocks.createSession).not.toHaveBeenCalled();
  });

  it("does not match org-map entries against arbitrary identity fields", async () => {
    const { token, publicJwk } = await createAccessJwt({
      aud: "aud",
      email: "member@example.com",
      exp: Math.floor(Date.now() / 1000) + 60,
      iss: "https://team.cloudflareaccess.com",
      sub: "access-user",
    });
    const { env, lockStub } = authEnvWithMissingOrg();
    authDoMocks.getUserByEmail.mockResolvedValue({
      userId: "user-1",
      user: { id: "user-1", email: "member@example.com", name: "Member User" },
    });
    authDoMocks.linkOAuthProvider.mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const value = url instanceof Request ? url.url : url.toString();
        if (value.endsWith("/cdn-cgi/access/certs")) {
          return jsonResponse({ keys: [publicJwk] });
        }
        if (value.endsWith("/cdn-cgi/access/get-identity")) {
          return jsonResponse({
            user_uuid: "access-user",
            name: "Member User",
            // The map key appears in a field that is not a configured claim
            // path; it must not grant membership in the mapped org.
            custom: { team: "acme-id" },
          });
        }
        return new Response(null, { status: 404 });
      }),
    );

    await expect(
      tryCloudflareAccessSilentLogin(
        new Request("https://app.example.com/login", {
          headers: { "Cf-Access-Jwt-Assertion": token },
        }),
        accessEnv({
          CLOUDFLARE_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
          CLOUDFLARE_ACCESS_AUD: "aud",
          CLOUDFLARE_ACCESS_ORG_MAP: '{"acme-id":"Acme"}',
        }),
        env,
      ),
    ).rejects.toMatchObject({ status: 403 });

    expect(lockStub.ensureAccessMappedOrg).not.toHaveBeenCalled();
    expect(authDoMocks.createSession).not.toHaveBeenCalled();
  });

  it("preserves the user's recorded last workspace on silent login", async () => {
    const { token, publicJwk } = await createAccessJwt({
      aud: "aud",
      email: "admin@example.com",
      exp: Math.floor(Date.now() / 1000) + 60,
      iss: "https://team.cloudflareaccess.com",
      sub: "access-user",
    });
    const { env, orgStub, userStub } = authEnvWithExistingOrg();
    orgStub.getWorkspaces.mockResolvedValue([
      { id: "workspace-austin", archived: false },
      { id: "workspace-second", archived: false },
    ]);
    userStub.getOrgs.mockResolvedValue([
      {
        org_id: "org-austin",
        role: "member",
        joined_at: 1,
        last_workspace_id: "workspace-second",
      },
    ]);
    authDoMocks.getUserByEmail.mockResolvedValue({
      userId: "user-1",
      user: { id: "user-1", email: "admin@example.com", name: "Admin User" },
    });
    authDoMocks.linkOAuthProvider.mockResolvedValue(undefined);
    authDoMocks.createSession.mockResolvedValue({
      signedToken: "signed-token",
      sessionData: {
        user_id: "user-1",
        org_id: "org-austin",
        workspace_id: "workspace-second",
        created_at: Date.now(),
        last_accessed: Date.now(),
        user_email: "admin@example.com",
        user_name: "Admin User",
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const value = url instanceof Request ? url.url : url.toString();
        if (value.endsWith("/cdn-cgi/access/certs")) {
          return jsonResponse({ keys: [publicJwk] });
        }
        if (value.endsWith("/cdn-cgi/access/get-identity")) {
          return jsonResponse({
            user_uuid: "access-user",
            name: "Admin User",
            idp: { groups: ["camelai-office-austin"] },
          });
        }
        return new Response(null, { status: 404 });
      }),
    );

    await tryCloudflareAccessSilentLogin(
      new Request("https://app.example.com/login", {
        headers: { "Cf-Access-Jwt-Assertion": token },
      }),
      accessEnv({
        CLOUDFLARE_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
        CLOUDFLARE_ACCESS_AUD: "aud",
        CLOUDFLARE_ACCESS_ORG_GROUP_PREFIX: "camelai-office-",
      }),
      env,
    );

    expect(userStub.setOrgLastWorkspace).toHaveBeenCalledWith(
      "org-austin",
      "workspace-second",
    );
    expect(authDoMocks.createSession).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      "org-austin",
      "workspace-second",
      expect.anything(),
      expect.anything(),
    );
  });

  it("returns 503 when the Access identity endpoint is unavailable", async () => {
    const { token, publicJwk } = await createAccessJwt({
      aud: "aud",
      email: "member@example.com",
      exp: Math.floor(Date.now() / 1000) + 60,
      iss: "https://team.cloudflareaccess.com",
      sub: "access-user",
    });
    const { env, lockStub } = authEnvWithMissingOrg();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const value = url instanceof Request ? url.url : url.toString();
        if (value.endsWith("/cdn-cgi/access/certs")) {
          return jsonResponse({ keys: [publicJwk] });
        }
        if (value.endsWith("/cdn-cgi/access/get-identity")) {
          return new Response(null, { status: 503 });
        }
        return new Response(null, { status: 404 });
      }),
    );

    await expect(
      tryCloudflareAccessSilentLogin(
        new Request("https://app.example.com/login", {
          headers: { "Cf-Access-Jwt-Assertion": token },
        }),
        accessEnv({
          CLOUDFLARE_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
          CLOUDFLARE_ACCESS_AUD: "aud",
          CLOUDFLARE_ACCESS_DEFAULT_ORG_NAME: "CamelAI",
        }),
        env,
      ),
    ).rejects.toMatchObject({ status: 503 });

    // A transient identity outage must not silently provision into the
    // default org or create any records.
    expect(lockStub.ensureAccessMappedOrg).not.toHaveBeenCalled();
    expect(authDoMocks.createUserFromOAuth).not.toHaveBeenCalled();
    expect(authDoMocks.createSession).not.toHaveBeenCalled();
  });

  it("returns 503 when the Access signing keys cannot be loaded", async () => {
    const { token } = await createAccessJwt({
      aud: "aud",
      email: "member@example.com",
      exp: Math.floor(Date.now() / 1000) + 60,
      iss: "https://team.cloudflareaccess.com",
      sub: "access-user",
    });
    const { env } = authEnvWithMissingOrg();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 500 })),
    );

    await expect(
      tryCloudflareAccessSilentLogin(
        new Request("https://app.example.com/login", {
          headers: { "Cf-Access-Jwt-Assertion": token },
        }),
        accessEnv({
          CLOUDFLARE_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
          CLOUDFLARE_ACCESS_AUD: "aud",
          CLOUDFLARE_ACCESS_DEFAULT_ORG_NAME: "CamelAI",
        }),
        env,
      ),
    ).rejects.toMatchObject({ status: 503 });
  });
});
