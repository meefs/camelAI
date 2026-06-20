import { afterEach, describe, expect, it, vi } from "vitest";
import {
  validateSessionMapsToOrg,
  validateSessionIdentityMapsToOrg,
} from "../workers/main/src/helpers/proxy-auth-providers";
import {
  normalizeHttpsUrl,
  resolveOrgCandidates,
  type ProxyJwtPayload,
  type ProxyIdentity,
} from "../workers/main/src/helpers/proxy-auth-core";
import { getPomeriumConfig } from "../workers/main/src/helpers/pomerium-session";
import type { SignedSessionData } from "../workers/main/src/signed-session";
import type { Env } from "../workers/main/src/types";
import { createPomeriumJwt, jsonResponse } from "./helpers/access-jwt";

const ISSUER = "app.example.com";
const JWKS_URL = "https://authenticate.example.com/.well-known/pomerium/jwks.json";

function pomeriumEnv(
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
    POMERIUM_JWKS_URL: JWKS_URL,
    POMERIUM_ISSUER: ISSUER,
    POMERIUM_AUDIENCE: ISSUER,
    POMERIUM_ORG_GROUP_PREFIX: "camelai-office-",
    POMERIUM_ADMIN_GROUP_PREFIX: "camelai-office-admin-",
    ...values,
  } as unknown as Env;
}

const pomeriumSession: SignedSessionData = {
  user_id: "user-1",
  org_id: "org-austin",
  workspace_id: "workspace-austin",
  created_at: 123,
  user_name: "Pomerium User",
  user_email: "user@example.com",
  auth_source: "pomerium",
};

function jwtClaims(overrides: Record<string, unknown> = {}) {
  return {
    aud: ISSUER,
    email: "user@example.com",
    exp: Math.floor(Date.now() / 1000) + 60,
    iss: ISSUER,
    sub: "pomerium-user",
    ...overrides,
  };
}

function stubJwksFetch(publicJwk: JsonWebKey, certsResponse?: Response): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request) => {
      const value = url instanceof Request ? url.url : url.toString();
      if (value === JWKS_URL) {
        return certsResponse ?? jsonResponse({ keys: [publicJwk] });
      }
      return new Response(null, { status: 404 });
    }),
  );
}

describe("Worker Pomerium session validation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("treats sessions from other auth sources as valid", async () => {
    await expect(
      validateSessionMapsToOrg(
        new Request("https://app.example.com/api"),
        pomeriumEnv({}),
        { ...pomeriumSession, auth_source: null },
      ),
    ).resolves.toBe("valid");
  });

  it("accepts a Pomerium cookie only when the inline groups still map to the session org", async () => {
    const { token, publicJwk } = await createPomeriumJwt(
      jwtClaims({ groups: ["camelai-office-austin"] }),
    );
    stubJwksFetch(publicJwk);

    await expect(
      validateSessionMapsToOrg(
        new Request("https://app.example.com/api", {
          headers: { "X-Pomerium-Jwt-Assertion": token },
        }),
        pomeriumEnv({ [`pomerium:org:${ISSUER}:group:austin`]: "org-austin" }),
        pomeriumSession,
      ),
    ).resolves.toBe("valid");
  });

  it("rejects a Pomerium cookie when the inline groups no longer map to the session org", async () => {
    const { token, publicJwk } = await createPomeriumJwt(
      jwtClaims({ groups: ["camelai-office-boston"] }),
    );
    stubJwksFetch(publicJwk);

    await expect(
      validateSessionMapsToOrg(
        new Request("https://app.example.com/api", {
          headers: { "X-Pomerium-Jwt-Assertion": token },
        }),
        pomeriumEnv({ [`pomerium:org:${ISSUER}:group:boston`]: "org-boston" }),
        pomeriumSession,
      ),
    ).resolves.toBe("invalid");
  });

  it("rejects a Pomerium cookie when the email is outside the required domain", async () => {
    const { token, publicJwk } = await createPomeriumJwt(
      jwtClaims({ groups: ["camelai-office-austin"] }),
    );
    stubJwksFetch(publicJwk);

    await expect(
      validateSessionMapsToOrg(
        new Request("https://app.example.com/api", {
          headers: { "X-Pomerium-Jwt-Assertion": token },
        }),
        pomeriumEnv(
          { [`pomerium:org:${ISSUER}:group:austin`]: "org-austin" },
          { POMERIUM_REQUIRED_EMAIL_DOMAIN: "camelai.com" },
        ),
        pomeriumSession,
      ),
    ).resolves.toBe("invalid");
  });

  it("falls back to the lock DO mapping when APP_KV has not propagated yet", async () => {
    const { token, publicJwk } = await createPomeriumJwt(
      jwtClaims({ groups: ["camelai-office-austin"] }),
    );
    stubJwksFetch(publicJwk);

    await expect(
      validateSessionMapsToOrg(
        new Request("https://app.example.com/api", {
          headers: { "X-Pomerium-Jwt-Assertion": token },
        }),
        pomeriumEnv(
          {},
          {},
          {
            [`pomerium:org_lock:pomerium:org:${ISSUER}:group:austin`]:
              "org-austin",
          },
        ),
        pomeriumSession,
      ),
    ).resolves.toBe("valid");
  });

  it("reports unavailable when the signing keys cannot be loaded", async () => {
    const { token, publicJwk } = await createPomeriumJwt(
      jwtClaims({ groups: ["camelai-office-austin"] }),
    );
    stubJwksFetch(publicJwk, new Response(null, { status: 503 }));

    await expect(
      validateSessionMapsToOrg(
        new Request("https://app.example.com/api", {
          headers: { "X-Pomerium-Jwt-Assertion": token },
        }),
        pomeriumEnv({}),
        pomeriumSession,
      ),
    ).resolves.toBe("unavailable");
  });

  it("rejects when the assertion header is missing", async () => {
    await expect(
      validateSessionMapsToOrg(
        new Request("https://app.example.com/api"),
        pomeriumEnv({ [`pomerium:org:${ISSUER}:group:austin`]: "org-austin" }),
        pomeriumSession,
      ),
    ).resolves.toBe("invalid");
  });

  it("rejects an assertion with no exp claim (must not validate forever)", async () => {
    const { exp: _omitExp, ...claimsWithoutExp } = jwtClaims({
      groups: ["camelai-office-austin"],
    });
    const { token, publicJwk } = await createPomeriumJwt(claimsWithoutExp);
    stubJwksFetch(publicJwk);

    await expect(
      validateSessionMapsToOrg(
        new Request("https://app.example.com/api", {
          headers: { "X-Pomerium-Jwt-Assertion": token },
        }),
        pomeriumEnv({ [`pomerium:org:${ISSUER}:group:austin`]: "org-austin" }),
        pomeriumSession,
      ),
    ).resolves.toBe("invalid");
  });

  it("maps via a POMERIUM_ORG_MAP group-id key with no prefix and unset org claims (self-host default)", async () => {
    // groups carry an opaque IdP group id, org claims point at the missing
    // self-host placeholder, and no group prefix is set — the org-map group-id
    // key is the only thing that can produce a candidate.
    const { token, publicJwk } = await createPomeriumJwt(
      jwtClaims({ groups: ["8f1e-group-id"] }),
    );
    stubJwksFetch(publicJwk);

    await expect(
      validateSessionMapsToOrg(
        new Request("https://app.example.com/api", {
          headers: { "X-Pomerium-Jwt-Assertion": token },
        }),
        pomeriumEnv(
          { [`pomerium:org:${ISSUER}:map:8f1e-group-id`]: "org-austin" },
          {
            POMERIUM_ORG_MAP: JSON.stringify({ "8f1e-group-id": "Austin Office" }),
            POMERIUM_ORG_CLAIMS: "__selfhost_org__",
            POMERIUM_ORG_GROUP_PREFIX: undefined,
            POMERIUM_ADMIN_GROUP_PREFIX: undefined,
          },
        ),
        pomeriumSession,
      ),
    ).resolves.toBe("valid");
  });
});

describe("Worker Pomerium identity validation against a target org", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("treats sessions from other auth sources as valid for any target org", async () => {
    await expect(
      validateSessionIdentityMapsToOrg(
        new Request("https://app.example.com/api"),
        pomeriumEnv({}),
        { ...pomeriumSession, auth_source: null },
        "org-boston",
      ),
    ).resolves.toBe("valid");
  });

  it("accepts when the live groups still map to the requested target org", async () => {
    const { token, publicJwk } = await createPomeriumJwt(
      jwtClaims({ groups: ["camelai-office-austin"] }),
    );
    stubJwksFetch(publicJwk);

    await expect(
      validateSessionIdentityMapsToOrg(
        new Request("https://app.example.com/api", {
          headers: { "X-Pomerium-Jwt-Assertion": token },
        }),
        pomeriumEnv({ [`pomerium:org:${ISSUER}:group:austin`]: "org-austin" }),
        pomeriumSession,
        "org-austin",
      ),
    ).resolves.toBe("valid");
  });

  it("rejects access to a target org the live identity does not map to, even when the cookie still maps to another org", async () => {
    // Live assertion only proves membership in org-austin (the cookie's org),
    // but the private worker belongs to org-boston. Stale persisted membership
    // must not be enough — the live identity check must target org-boston.
    const { token, publicJwk } = await createPomeriumJwt(
      jwtClaims({ groups: ["camelai-office-austin"] }),
    );
    stubJwksFetch(publicJwk);

    await expect(
      validateSessionIdentityMapsToOrg(
        new Request("https://app.example.com/api", {
          headers: { "X-Pomerium-Jwt-Assertion": token },
        }),
        pomeriumEnv({ [`pomerium:org:${ISSUER}:group:austin`]: "org-austin" }),
        pomeriumSession,
        "org-boston",
      ),
    ).resolves.toBe("invalid");
  });
});

describe("normalizeHttpsUrl rejects plaintext trust roots", () => {
  it("upgrades http:// origins to https:// (JWKS is a trust root)", () => {
    expect(normalizeHttpsUrl("http://authenticate.example.com")).toBe(
      "https://authenticate.example.com",
    );
    expect(normalizeHttpsUrl("http://authenticate.example.com/")).toBe(
      "https://authenticate.example.com",
    );
  });

  it("preserves https:// and prefixes bare hosts, trims trailing slashes", () => {
    expect(normalizeHttpsUrl("https://authenticate.example.com/")).toBe(
      "https://authenticate.example.com",
    );
    expect(normalizeHttpsUrl("authenticate.example.com")).toBe(
      "https://authenticate.example.com",
    );
    expect(normalizeHttpsUrl("  ")).toBeNull();
    expect(normalizeHttpsUrl(undefined)).toBeNull();
  });

  it("derives an https JWKS URL even when POMERIUM_AUTHENTICATE_URL is http://", () => {
    const config = getPomeriumConfig({
      POMERIUM_AUTHENTICATE_URL: "http://authenticate.example.com",
      POMERIUM_ISSUER: ISSUER,
      POMERIUM_AUDIENCE: ISSUER,
    } as unknown as Env);
    expect(config?.jwksUrl).toBe(
      "https://authenticate.example.com/.well-known/pomerium/jwks.json",
    );
  });

  it("upgrades an explicit http:// POMERIUM_JWKS_URL override to https://", () => {
    const config = getPomeriumConfig({
      POMERIUM_JWKS_URL:
        "http://authenticate.example.com/.well-known/pomerium/jwks.json",
      POMERIUM_ISSUER: ISSUER,
      POMERIUM_AUDIENCE: ISSUER,
    } as unknown as Env);
    expect(config?.jwksUrl).toBe(
      "https://authenticate.example.com/.well-known/pomerium/jwks.json",
    );
  });
});

describe("resolveOrgCandidates org-map bootstrapping", () => {
  function pomeriumConfig(values: Partial<Env>) {
    const config = getPomeriumConfig({
      POMERIUM_JWKS_URL: JWKS_URL,
      POMERIUM_ISSUER: ISSUER,
      POMERIUM_AUDIENCE: ISSUER,
      ...values,
    } as unknown as Env);
    if (!config) throw new Error("expected a Pomerium config");
    return config;
  }

  it("lets a group-id org-map candidate initialize its org on first login", () => {
    const config = pomeriumConfig({
      POMERIUM_ORG_MAP: JSON.stringify({ "8f1e-group-id": "Austin Office" }),
      POMERIUM_ORG_CLAIMS: "__selfhost_org__",
    });
    const payload = {
      email: "user@example.com",
      groups: ["8f1e-group-id"],
    } as unknown as ProxyJwtPayload;

    const candidate = resolveOrgCandidates(
      config,
      payload,
      payload as unknown as ProxyIdentity,
    ).find((c) => c.key === "map:8f1e-group-id");

    expect(candidate?.name).toBe("Austin Office");
    // A group key is IdP-assigned, so it may bootstrap the org (otherwise the
    // first user 403s — member candidate can't create it and it suppresses the
    // default-org fallback).
    expect(candidate?.initializesOrg).toBe(true);
  });

  it("does not emit a duplicate map candidate for a prefixed group (prefix path owns it)", () => {
    const config = pomeriumConfig({
      POMERIUM_ORG_GROUP_PREFIX: "camelai-office-",
      POMERIUM_ORG_MAP: JSON.stringify({
        "camelai-office-austin": "Austin Office",
      }),
      POMERIUM_ORG_CLAIMS: "__selfhost_org__",
    });
    const payload = {
      email: "user@example.com",
      groups: ["camelai-office-austin"],
    } as unknown as ProxyJwtPayload;

    const candidates = resolveOrgCandidates(
      config,
      payload,
      payload as unknown as ProxyIdentity,
    );

    // No second org under a map:<group> key for a group the prefix already owns.
    expect(
      candidates.some((c) => c.key === "map:camelai-office-austin"),
    ).toBe(false);
    // The prefix path owns it, using orgMap only for the display name.
    const groupCandidate = candidates.find((c) => c.key.startsWith("group:"));
    expect(groupCandidate?.name).toBe("Austin Office");
  });

  it("keeps a claim-value org-map candidate non-initializing (claims can be user-editable)", () => {
    const config = pomeriumConfig({
      POMERIUM_ORG_MAP: JSON.stringify({ Austin: "Austin Office" }),
      POMERIUM_ORG_CLAIMS: "officeLocation",
    });
    const payload = {
      email: "user@example.com",
      officeLocation: "Austin",
    } as unknown as ProxyJwtPayload;

    const candidate = resolveOrgCandidates(
      config,
      payload,
      payload as unknown as ProxyIdentity,
    ).find((c) => c.key === "map:Austin");

    expect(candidate?.name).toBe("Austin Office");
    expect(candidate?.initializesOrg).toBeUndefined();
  });
});
