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
  isCloudflareAccessConfigured,
  tryCloudflareAccessSilentLogin,
  type CloudflareAccessEnv,
} from "@/lib/cloudflare-access-auth.server";
import type { AuthEnv } from "@/lib/auth-helpers";

function accessEnv(
  values: Partial<CloudflareAccessEnv> = {},
): CloudflareAccessEnv {
  return {
    APP_KV: {} as KVNamespace,
    ...values,
  };
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function createAccessJwt(
  payload: Record<string, unknown>,
): Promise<{ token: string; publicJwk: JsonWebKey }> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const publicJwk = {
    ...(await crypto.subtle.exportKey("jwk", keyPair.publicKey)),
    kid: "test-key",
    alg: "RS256",
    use: "sig",
  };

  const encoder = new TextEncoder();
  const encodedHeader = base64urlEncode(
    encoder.encode(JSON.stringify({ alg: "RS256", kid: "test-key" })),
  );
  const encodedPayload = base64urlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keyPair.privateKey,
    encoder.encode(`${encodedHeader}.${encodedPayload}`),
  );

  return {
    token: `${encodedHeader}.${encodedPayload}.${base64urlEncode(new Uint8Array(signature))}`,
    publicJwk,
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
  };
  const userStub = {
    hasOrg: vi.fn(async () => true),
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
    expect(orgStub.addMember).toHaveBeenCalledTimes(1);
    expect(orgStub.addMember).toHaveBeenCalledWith(
      "user-1",
      "admin",
      "cloudflare-access",
    );
    expect(userStub.updateOrgRole).toHaveBeenCalledWith("org-austin", "admin");
  });
});
