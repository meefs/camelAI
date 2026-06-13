import { afterEach, describe, expect, it, vi } from "vitest";
import { validateAccessBackedSignedSession } from "../workers/main/src/helpers/access-session";
import type { SignedSessionData } from "../workers/main/src/signed-session";
import type { Env } from "../workers/main/src/types";
import { createAccessJwt, jsonResponse } from "./helpers/access-jwt";


function accessEnv(
  orgMappings: Record<string, string>,
  values: Partial<Env> = {},
  lockMappings: Record<string, string> = {},
): Env {
  return {
    APP_KV: {
      get: vi.fn(async (key: string) => orgMappings[key] ?? null),
    },
    ORG: {
      idFromName: (name: string) => name,
      get: vi.fn((id: string) => ({
        getAccessMappedOrgId: vi.fn(async () => lockMappings[id] ?? null),
      })),
    },
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
    CLOUDFLARE_ACCESS_AUD: "aud",
    CLOUDFLARE_ACCESS_ORG_GROUP_PREFIX: "camelai-office-",
    CLOUDFLARE_ACCESS_ADMIN_GROUP_PREFIX: "camelai-office-admin-",
    ...values,
  } as unknown as Env;
}

const accessSession: SignedSessionData = {
  user_id: "user-1",
  org_id: "org-austin",
  workspace_id: "workspace-austin",
  created_at: 123,
  user_name: "Access User",
  user_email: "access@example.com",
  auth_source: "cloudflare_access",
};

function stubAccessFetch(
  publicJwk: JsonWebKey,
  identity: Record<string, unknown> | Response,
  certsResponse?: Response,
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request) => {
      const value = url instanceof Request ? url.url : url.toString();
      if (value.endsWith("/cdn-cgi/access/certs")) {
        return certsResponse ?? jsonResponse({ keys: [publicJwk] });
      }
      if (value.endsWith("/cdn-cgi/access/get-identity")) {
        return identity instanceof Response ? identity : jsonResponse(identity);
      }
      return new Response(null, { status: 404 });
    }),
  );
}

describe("Worker Cloudflare Access session validation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("treats sessions from other auth sources as valid", async () => {
    await expect(
      validateAccessBackedSignedSession(
        new Request("https://app.example.com/api"),
        accessEnv({}),
        { ...accessSession, auth_source: null },
      ),
    ).resolves.toBe("valid");
  });

  it("accepts an Access-backed cookie only when current Access identity maps to the session org", async () => {
    const { token, publicJwk } = await createAccessJwt({
      aud: "aud",
      email: "access@example.com",
      exp: Math.floor(Date.now() / 1000) + 60,
      iss: "https://team.cloudflareaccess.com",
      sub: "access-user",
    });
    stubAccessFetch(publicJwk, {
      user_uuid: "access-user",
      idp: { groups: ["camelai-office-austin"] },
    });

    await expect(
      validateAccessBackedSignedSession(
        new Request("https://app.example.com/api", {
          headers: { "Cf-Access-Jwt-Assertion": token },
        }),
        accessEnv({
          "cloudflare_access:org:https://team.cloudflareaccess.com:group:austin":
            "org-austin",
        }),
        accessSession,
      ),
    ).resolves.toBe("valid");
  });

  it("rejects an Access-backed cookie when current Access identity no longer maps to the session org", async () => {
    const { token, publicJwk } = await createAccessJwt({
      aud: "aud",
      email: "access@example.com",
      exp: Math.floor(Date.now() / 1000) + 60,
      iss: "https://team.cloudflareaccess.com",
      sub: "access-user",
    });
    stubAccessFetch(publicJwk, {
      user_uuid: "access-user",
      idp: { groups: ["camelai-office-boston"] },
    });

    await expect(
      validateAccessBackedSignedSession(
        new Request("https://app.example.com/api", {
          headers: { "Cf-Access-Jwt-Assertion": token },
        }),
        accessEnv({
          "cloudflare_access:org:https://team.cloudflareaccess.com:group:boston":
            "org-boston",
        }),
        accessSession,
      ),
    ).resolves.toBe("invalid");
  });

  it("rejects an Access-backed cookie when the email is outside the required domain", async () => {
    const { token, publicJwk } = await createAccessJwt({
      aud: "aud",
      email: "access@example.com",
      exp: Math.floor(Date.now() / 1000) + 60,
      iss: "https://team.cloudflareaccess.com",
      sub: "access-user",
    });
    stubAccessFetch(publicJwk, {
      user_uuid: "access-user",
      idp: { groups: ["camelai-office-austin"] },
    });

    await expect(
      validateAccessBackedSignedSession(
        new Request("https://app.example.com/api", {
          headers: { "Cf-Access-Jwt-Assertion": token },
        }),
        accessEnv(
          {
            "cloudflare_access:org:https://team.cloudflareaccess.com:group:austin":
              "org-austin",
          },
          { CLOUDFLARE_ACCESS_REQUIRED_EMAIL_DOMAIN: "camelai.com" },
        ),
        accessSession,
      ),
    ).resolves.toBe("invalid");
  });

  it("falls back to the lock DO mapping when APP_KV has not propagated yet", async () => {
    const { token, publicJwk } = await createAccessJwt({
      aud: "aud",
      email: "access@example.com",
      exp: Math.floor(Date.now() / 1000) + 60,
      iss: "https://team.cloudflareaccess.com",
      sub: "access-user",
    });
    stubAccessFetch(publicJwk, {
      user_uuid: "access-user",
      idp: { groups: ["camelai-office-austin"] },
    });

    await expect(
      validateAccessBackedSignedSession(
        new Request("https://app.example.com/api", {
          headers: { "Cf-Access-Jwt-Assertion": token },
        }),
        accessEnv(
          {},
          {},
          {
            "cloudflare_access:org_lock:cloudflare_access:org:https://team.cloudflareaccess.com:group:austin":
              "org-austin",
          },
        ),
        accessSession,
      ),
    ).resolves.toBe("valid");
  });

  it("skips the identity fetch when a JWT claim path already proves the mapping", async () => {
    const { token, publicJwk } = await createAccessJwt({
      aud: "aud",
      email: "access@example.com",
      exp: Math.floor(Date.now() / 1000) + 60,
      iss: "https://team.cloudflareaccess.com",
      sub: "access-user",
      org: "acme",
    });
    stubAccessFetch(publicJwk, { user_uuid: "access-user" });

    await expect(
      validateAccessBackedSignedSession(
        new Request("https://app.example.com/api", {
          headers: { "Cf-Access-Jwt-Assertion": token },
        }),
        accessEnv(
          {
            "cloudflare_access:org:https://team.cloudflareaccess.com:jwt.org:acme":
              "org-austin",
          },
          { CLOUDFLARE_ACCESS_ORG_CLAIMS: "jwt.org" },
        ),
        accessSession,
      ),
    ).resolves.toBe("valid");

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const identityCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url instanceof Request ? url.url : url).includes("get-identity"),
    );
    expect(identityCalls).toHaveLength(0);
  });

  it("does not validate a default-org session through the JWT-only fast path when identity yields candidates", async () => {
    const { token, publicJwk } = await createAccessJwt({
      aud: "aud",
      email: "access@example.com",
      exp: Math.floor(Date.now() / 1000) + 60,
      iss: "https://team.cloudflareaccess.com",
      sub: "access-user",
    });
    stubAccessFetch(publicJwk, {
      user_uuid: "access-user",
      idp: { groups: ["camelai-office-austin"] },
    });

    await expect(
      validateAccessBackedSignedSession(
        new Request("https://app.example.com/api", {
          headers: { "Cf-Access-Jwt-Assertion": token },
        }),
        accessEnv(
          {
            "cloudflare_access:org:https://team.cloudflareaccess.com:default:CamelAI":
              "org-default",
          },
          { CLOUDFLARE_ACCESS_DEFAULT_ORG_NAME: "CamelAI" },
        ),
        { ...accessSession, org_id: "org-default" },
      ),
    ).resolves.toBe("invalid");
  });

  it("caches the JWKS across validations", async () => {
    const { token, publicJwk } = await createAccessJwt({
      aud: "aud",
      email: "access@example.com",
      exp: Math.floor(Date.now() / 1000) + 60,
      iss: "https://team.cloudflareaccess.com",
      sub: "access-user",
    });
    stubAccessFetch(publicJwk, {
      user_uuid: "access-user",
      idp: { groups: ["camelai-office-austin"] },
    });
    const cacheStore = new Map<string, string>();
    vi.stubGlobal("caches", {
      default: {
        match: vi.fn(async (key: string) => {
          const body = cacheStore.get(key);
          return body === undefined ? undefined : new Response(body);
        }),
        put: vi.fn(async (key: string, response: Response) => {
          cacheStore.set(key, await response.text());
        }),
      },
    });
    const env = accessEnv({
      "cloudflare_access:org:https://team.cloudflareaccess.com:group:austin":
        "org-austin",
    });

    for (let run = 0; run < 2; run += 1) {
      await expect(
        validateAccessBackedSignedSession(
          new Request("https://app.example.com/api", {
            headers: { "Cf-Access-Jwt-Assertion": token },
          }),
          env,
          accessSession,
        ),
      ).resolves.toBe("valid");
    }

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const certsCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url instanceof Request ? url.url : url).includes("certs"),
    );
    expect(certsCalls).toHaveLength(1);
  });

  it("memoizes the identity fetch per request", async () => {
    const { token, publicJwk } = await createAccessJwt({
      aud: "aud",
      email: "access@example.com",
      exp: Math.floor(Date.now() / 1000) + 60,
      iss: "https://team.cloudflareaccess.com",
      sub: "access-user",
    });
    stubAccessFetch(publicJwk, {
      user_uuid: "access-user",
      idp: { groups: ["camelai-office-austin"] },
    });
    const env = accessEnv({
      "cloudflare_access:org:https://team.cloudflareaccess.com:group:austin":
        "org-austin",
    });
    const request = new Request("https://app.example.com/api", {
      headers: { "Cf-Access-Jwt-Assertion": token },
    });

    await expect(
      validateAccessBackedSignedSession(request, env, accessSession),
    ).resolves.toBe("valid");
    await expect(
      validateAccessBackedSignedSession(request, env, accessSession),
    ).resolves.toBe("valid");

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const identityCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url instanceof Request ? url.url : url).includes("get-identity"),
    );
    expect(identityCalls).toHaveLength(1);
  });

  it("reports unavailable for a default-org session when the identity endpoint is down", async () => {
    const { token, publicJwk } = await createAccessJwt({
      aud: "aud",
      email: "access@example.com",
      exp: Math.floor(Date.now() / 1000) + 60,
      iss: "https://team.cloudflareaccess.com",
      sub: "access-user",
    });
    // Identity endpoint 5xx: the default-org fallback must not validate the
    // stale cookie, since the unseen identity might now map elsewhere.
    stubAccessFetch(publicJwk, new Response(null, { status: 503 }));

    await expect(
      validateAccessBackedSignedSession(
        new Request("https://app.example.com/api", {
          headers: { "Cf-Access-Jwt-Assertion": token },
        }),
        accessEnv(
          {
            "cloudflare_access:org:https://team.cloudflareaccess.com:default:CamelAI":
              "org-default",
          },
          { CLOUDFLARE_ACCESS_DEFAULT_ORG_NAME: "CamelAI" },
        ),
        { ...accessSession, org_id: "org-default" },
      ),
    ).resolves.toBe("unavailable");
  });

  it("validates a default-org session when identity is reachable but empty", async () => {
    const { token, publicJwk } = await createAccessJwt({
      aud: "aud",
      email: "access@example.com",
      exp: Math.floor(Date.now() / 1000) + 60,
      iss: "https://team.cloudflareaccess.com",
      sub: "access-user",
    });
    // Identity reachable and yields no group/claim candidates: the default-org
    // fallback applies and the session is valid.
    stubAccessFetch(publicJwk, { user_uuid: "access-user" });

    await expect(
      validateAccessBackedSignedSession(
        new Request("https://app.example.com/api", {
          headers: { "Cf-Access-Jwt-Assertion": token },
        }),
        accessEnv(
          {
            "cloudflare_access:org:https://team.cloudflareaccess.com:default:CamelAI":
              "org-default",
          },
          { CLOUDFLARE_ACCESS_DEFAULT_ORG_NAME: "CamelAI" },
        ),
        { ...accessSession, org_id: "org-default" },
      ),
    ).resolves.toBe("valid");
  });

  it("sends the assertion as the CF_Authorization cookie when the request has none", async () => {
    const { token, publicJwk } = await createAccessJwt({
      aud: "aud",
      email: "access@example.com",
      exp: Math.floor(Date.now() / 1000) + 60,
      iss: "https://team.cloudflareaccess.com",
      sub: "access-user",
    });
    stubAccessFetch(publicJwk, {
      user_uuid: "access-user",
      idp: { groups: ["camelai-office-austin"] },
    });

    await expect(
      validateAccessBackedSignedSession(
        new Request("https://app.example.com/api", {
          headers: { "Cf-Access-Jwt-Assertion": token },
        }),
        accessEnv({
          "cloudflare_access:org:https://team.cloudflareaccess.com:group:austin":
            "org-austin",
        }),
        accessSession,
      ),
    ).resolves.toBe("valid");

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const identityCall = fetchMock.mock.calls.find(([url]) =>
      String(url instanceof Request ? url.url : url).includes("get-identity"),
    );
    expect(identityCall).toBeDefined();
    const init = identityCall?.[1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("Cookie")).toBe(`CF_Authorization=${token}`);
  });

  it("preserves an existing CF_Authorization cookie from the request", async () => {
    const { token, publicJwk } = await createAccessJwt({
      aud: "aud",
      email: "access@example.com",
      exp: Math.floor(Date.now() / 1000) + 60,
      iss: "https://team.cloudflareaccess.com",
      sub: "access-user",
    });
    stubAccessFetch(publicJwk, {
      user_uuid: "access-user",
      idp: { groups: ["camelai-office-austin"] },
    });

    await validateAccessBackedSignedSession(
      new Request("https://app.example.com/api", {
        headers: {
          "Cf-Access-Jwt-Assertion": token,
          Cookie: "CF_Authorization=browser-cookie; other=1",
        },
      }),
      accessEnv({
        "cloudflare_access:org:https://team.cloudflareaccess.com:group:austin":
          "org-austin",
      }),
      accessSession,
    );

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const identityCall = fetchMock.mock.calls.find(([url]) =>
      String(url instanceof Request ? url.url : url).includes("get-identity"),
    );
    const headers = new Headers((identityCall?.[1] as RequestInit).headers);
    expect(headers.get("Cookie")).toBe("CF_Authorization=browser-cookie");
  });

  it("reports unavailable when the signing keys cannot be loaded", async () => {
    const { token, publicJwk } = await createAccessJwt({
      aud: "aud",
      email: "access@example.com",
      exp: Math.floor(Date.now() / 1000) + 60,
      iss: "https://team.cloudflareaccess.com",
      sub: "access-user",
    });
    stubAccessFetch(
      publicJwk,
      { user_uuid: "access-user" },
      new Response(null, { status: 503 }),
    );

    await expect(
      validateAccessBackedSignedSession(
        new Request("https://app.example.com/api", {
          headers: { "Cf-Access-Jwt-Assertion": token },
        }),
        accessEnv({}),
        accessSession,
      ),
    ).resolves.toBe("unavailable");
  });

  it("reports unavailable when the identity endpoint fails and the JWT alone cannot prove the mapping", async () => {
    const { token, publicJwk } = await createAccessJwt({
      aud: "aud",
      email: "access@example.com",
      exp: Math.floor(Date.now() / 1000) + 60,
      iss: "https://team.cloudflareaccess.com",
      sub: "access-user",
    });
    stubAccessFetch(publicJwk, new Response(null, { status: 503 }));

    await expect(
      validateAccessBackedSignedSession(
        new Request("https://app.example.com/api", {
          headers: { "Cf-Access-Jwt-Assertion": token },
        }),
        accessEnv({
          "cloudflare_access:org:https://team.cloudflareaccess.com:group:austin":
            "org-austin",
        }),
        accessSession,
      ),
    ).resolves.toBe("unavailable");
  });
});
