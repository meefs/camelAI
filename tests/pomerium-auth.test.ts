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
  getPomeriumLogoutUrl,
  isPomeriumConfigured,
  tryPomeriumSilentLogin,
  type PomeriumEnv,
} from "@/lib/pomerium-auth.server";
import type { AuthEnv } from "@/lib/auth-helpers";
import { createPomeriumJwt, jsonResponse } from "./helpers/access-jwt";

const ISSUER = "app.example.com";
const JWKS_URL = "https://authenticate.example.com/.well-known/pomerium/jwks.json";

function pomeriumEnv(values: Partial<PomeriumEnv> = {}): PomeriumEnv {
  return {
    APP_KV: {} as KVNamespace,
    ...values,
  };
}

function configuredEnv(extra: Partial<PomeriumEnv> = {}): PomeriumEnv {
  return pomeriumEnv({
    POMERIUM_JWKS_URL: JWKS_URL,
    POMERIUM_ISSUER: ISSUER,
    POMERIUM_AUDIENCE: ISSUER,
    ...extra,
  });
}

function jwtClaims(overrides: Record<string, unknown> = {}) {
  return {
    aud: ISSUER,
    email: "admin@example.com",
    exp: Math.floor(Date.now() / 1000) + 60,
    iss: ISSUER,
    sub: "pomerium-user",
    ...overrides,
  };
}

function jwksOnlyFetch(publicJwk: JsonWebKey) {
  return vi.fn(async (url: string | URL | Request) => {
    const value = url instanceof Request ? url.url : url.toString();
    if (value === JWKS_URL) return jsonResponse({ keys: [publicJwk] });
    return new Response(null, { status: 404 });
  });
}

function authEnvWithExistingOrg() {
  const kv = new Map<string, string>([
    [`pomerium:org:${ISSUER}:group:austin`, "org-austin"],
  ]);
  const orgStub = {
    getInfo: vi.fn(async () => ({ id: "org-austin", name: "Austin" })),
    getWorkspaces: vi.fn(async () => [
      { id: "workspace-austin", archived: false },
    ]),
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
  const workspaceStub = { setMemberAccess: vi.fn(async () => undefined) };

  return {
    env: {
      APP_KV: {
        get: vi.fn(async (key: string) => kv.get(key) ?? null),
        put: vi.fn(async (key: string, value: string) => {
          kv.set(key, value);
        }),
      },
      ORG: { idFromName: (name: string) => name, get: vi.fn(() => orgStub) },
      USER: { idFromName: (name: string) => name, get: vi.fn(() => userStub) },
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
    getWorkspaces: vi.fn(async () => [
      { id: "workspace-created", archived: false },
    ]),
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
  const workspaceStub = { setMemberAccess: vi.fn(async () => undefined) };
  const idFromName = vi.fn((name: string) => name);
  const orgGet = vi.fn((id: string) => {
    if (id.startsWith("pomerium:org_lock:")) return lockStub;
    return createdOrgStub;
  });

  return {
    env: {
      APP_KV: {
        get: vi.fn(async () => null),
        put: vi.fn(async () => undefined),
      },
      ORG: { idFromName, get: orgGet },
      USER: { idFromName: (name: string) => name, get: vi.fn(() => userStub) },
      WORKSPACE: {
        idFromName: (name: string) => name,
        get: vi.fn(() => workspaceStub),
      },
    } as unknown as AuthEnv,
    lockStub,
    idFromName,
  };
}

describe("Pomerium auth", () => {
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

  it("requires a JWKS source, issuer, and audience to be configured", () => {
    expect(isPomeriumConfigured(pomeriumEnv())).toBe(false);
    expect(
      isPomeriumConfigured(pomeriumEnv({ POMERIUM_JWKS_URL: JWKS_URL })),
    ).toBe(false);
    expect(
      isPomeriumConfigured(
        pomeriumEnv({ POMERIUM_JWKS_URL: JWKS_URL, POMERIUM_ISSUER: ISSUER }),
      ),
    ).toBe(false);
    expect(isPomeriumConfigured(configuredEnv())).toBe(true);
  });

  it("derives the JWKS URL from the authenticate URL when no explicit JWKS is set", () => {
    expect(
      isPomeriumConfigured(
        pomeriumEnv({
          POMERIUM_AUTHENTICATE_URL: "authenticate.example.com",
          POMERIUM_ISSUER: ISSUER,
          POMERIUM_AUDIENCE: ISSUER,
        }),
      ),
    ).toBe(true);
  });

  it("does nothing when the Pomerium assertion header is absent", async () => {
    await expect(
      tryPomeriumSilentLogin(
        new Request("https://app.example.com/login"),
        configuredEnv(),
        {} as AuthEnv,
      ),
    ).resolves.toBeNull();
  });

  it("leaves normal login available when the header arrives without config", async () => {
    await expect(
      tryPomeriumSilentLogin(
        new Request("https://app.example.com/login", {
          headers: { "X-Pomerium-Jwt-Assertion": "not.a.real.jwt" },
        }),
        pomeriumEnv(),
        {} as AuthEnv,
      ),
    ).resolves.toBeNull();
  });

  it("builds the Pomerium logout URL on the application origin", () => {
    expect(
      getPomeriumLogoutUrl(
        new Request("https://app.example.com/settings"),
        configuredEnv(),
      ),
    ).toBe("https://app.example.com/.pomerium/sign_out");
    expect(
      getPomeriumLogoutUrl(
        new Request("https://app.example.com/settings"),
        pomeriumEnv(),
      ),
    ).toBeNull();
  });

  it("maps an inline admin group to an org without any identity round-trip", async () => {
    const { token, publicJwk } = await createPomeriumJwt(
      jwtClaims({
        name: "Admin User",
        groups: ["camelai-office-austin", "camelai-office-admin-austin"],
      }),
    );
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
    const fetchMock = jwksOnlyFetch(publicJwk);
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      tryPomeriumSilentLogin(
        new Request("https://app.example.com/login", {
          headers: { "X-Pomerium-Jwt-Assertion": token },
        }),
        configuredEnv({
          POMERIUM_ORG_GROUP_PREFIX: "camelai-office-",
          POMERIUM_ADMIN_GROUP_PREFIX: "camelai-office-admin-",
        }),
        env,
      ),
    ).resolves.toMatchObject({
      signedToken: "signed-token",
      session: { org_id: "org-austin" },
    });

    // Groups are inline in the signed JWT: no get-identity-style endpoint is
    // ever fetched, only the JWKS.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(JWKS_URL);
    expect(env.APP_KV.get).toHaveBeenCalledWith(
      `pomerium:org:${ISSUER}:group:austin`,
    );
    expect(authDoMocks.linkOAuthProvider).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      "pomerium",
      "pomerium-user",
    );
    expect(orgStub.updateMemberRole).toHaveBeenCalledWith(
      "user-1",
      "admin",
      "pomerium",
    );
    expect(userStub.updateOrgRole).toHaveBeenCalledWith("org-austin", "admin");
  });

  it("allows the default Pomerium org to initialize on first login", async () => {
    const { token, publicJwk } = await createPomeriumJwt(
      jwtClaims({ email: "member@example.com", name: "Member User", groups: [] }),
    );
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
    vi.stubGlobal("fetch", jwksOnlyFetch(publicJwk));

    await expect(
      tryPomeriumSilentLogin(
        new Request("https://app.example.com/login", {
          headers: { "X-Pomerium-Jwt-Assertion": token },
        }),
        configuredEnv({ POMERIUM_DEFAULT_ORG_NAME: "CamelAI" }),
        env,
      ),
    ).resolves.toMatchObject({ session: { org_id: "org-created" } });

    const kvKey = `pomerium:org:${ISSUER}:default:CamelAI`;
    expect(idFromName).toHaveBeenCalledWith(`pomerium:org_lock:${kvKey}`);
    expect(lockStub.ensureAccessMappedOrg).toHaveBeenCalledWith(
      kvKey,
      "CamelAI",
      "user-1",
      "admin",
    );
  });

  it("rejects member-only first org creation before creating org records", async () => {
    const { token, publicJwk } = await createPomeriumJwt(
      jwtClaims({
        email: "member@example.com",
        name: "Member User",
        groups: ["camelai-office-austin"],
      }),
    );
    const { env, lockStub } = authEnvWithMissingOrg();
    authDoMocks.getUserByEmail.mockResolvedValue({
      userId: "user-1",
      user: { id: "user-1", email: "member@example.com", name: "Member User" },
    });
    authDoMocks.linkOAuthProvider.mockResolvedValue(undefined);
    vi.stubGlobal("fetch", jwksOnlyFetch(publicJwk));

    await expect(
      tryPomeriumSilentLogin(
        new Request("https://app.example.com/login", {
          headers: { "X-Pomerium-Jwt-Assertion": token },
        }),
        configuredEnv({
          POMERIUM_ORG_GROUP_PREFIX: "camelai-office-",
          POMERIUM_ADMIN_GROUP_PREFIX: "camelai-office-admin-",
        }),
        env,
      ),
    ).rejects.toMatchObject({ status: 403 });

    expect(lockStub.ensureAccessMappedOrg).not.toHaveBeenCalled();
    expect(authDoMocks.createSession).not.toHaveBeenCalled();
  });

  it("rejects a banned Pomerium email before auth mutations", async () => {
    const { token, publicJwk } = await createPomeriumJwt(
      jwtClaims({ email: "blocked@example.com" }),
    );
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
    vi.stubGlobal("fetch", jwksOnlyFetch(publicJwk));

    await expect(
      tryPomeriumSilentLogin(
        new Request("https://app.example.com/login", {
          headers: { "X-Pomerium-Jwt-Assertion": token },
        }),
        configuredEnv({ POMERIUM_ORG_GROUP_PREFIX: "camelai-office-" }),
        env,
      ),
    ).rejects.toMatchObject({ status: 403 });

    expect(authDoMocks.getUserByEmail).not.toHaveBeenCalled();
    expect(authDoMocks.createSession).not.toHaveBeenCalled();
  });

  it("rejects a forged audience", async () => {
    const { token, publicJwk } = await createPomeriumJwt(
      jwtClaims({ aud: "other.example.com" }),
    );
    const { env } = authEnvWithMissingOrg();
    vi.stubGlobal("fetch", jwksOnlyFetch(publicJwk));

    await expect(
      tryPomeriumSilentLogin(
        new Request("https://app.example.com/login", {
          headers: { "X-Pomerium-Jwt-Assertion": token },
        }),
        configuredEnv({ POMERIUM_DEFAULT_ORG_NAME: "CamelAI" }),
        env,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(authDoMocks.createSession).not.toHaveBeenCalled();
  });
});
