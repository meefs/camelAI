import * as oidc from "openid-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverOidcConfiguration,
  exchangeOidcCode,
  getOidcConnectionTestErrorMessage,
  getOidcDiscoveryErrorDiagnostic,
  getOidcDiscoveryErrorMessage,
  validateOidcJwks,
  validateOrgSsoIdentityClaims,
} from "../src/lib/org-sso.server";

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function jwtFixture(claims: Record<string, unknown>) {
  const pair = await crypto.subtle.generateKey(
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
    ...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
    kid: "oidc-test-key",
    alg: "RS256",
    use: "sig",
  };
  const encoder = new TextEncoder();
  const header = base64url(
    encoder.encode(JSON.stringify({ alg: "RS256", kid: "oidc-test-key" })),
  );
  const payload = base64url(encoder.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    pair.privateKey,
    encoder.encode(`${header}.${payload}`),
  );
  return {
    token: `${header}.${payload}.${base64url(new Uint8Array(signature))}`,
    publicJwk,
  };
}

describe("enterprise OIDC protocol", () => {
  afterEach(() => vi.restoreAllMocks());

  async function setup(expectedNonce = "nonce-1") {
    const issuer = "https://idp.example.com";
    const now = Math.floor(Date.now() / 1000);
    const jwt = await jwtFixture({
      iss: issuer,
      aud: "client-1",
      sub: "subject-1",
      email: "person@example.com",
      nonce: expectedNonce,
      iat: now,
      exp: now + 300,
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = String(input);
        if (url === `${issuer}/.well-known/openid-configuration`) {
          expect(init?.redirect).toBe("manual");
          return Response.json({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            jwks_uri: `${issuer}/jwks`,
            response_types_supported: ["code"],
            subject_types_supported: ["public"],
            id_token_signing_alg_values_supported: ["RS256"],
            token_endpoint_auth_methods_supported: ["client_secret_post"],
            code_challenge_methods_supported: ["S256"],
          });
        }
        if (url === `${issuer}/token`) {
          const body = String(init?.body ?? "");
          expect(body).toContain("code_verifier=verifier-1");
          expect(body).toContain("code=code-1");
          return Response.json({
            access_token: "access-token",
            token_type: "Bearer",
            expires_in: 300,
            id_token: jwt.token,
          });
        }
        if (url === `${issuer}/jwks`)
          return Response.json({ keys: [jwt.publicJwk] });
        throw new Error(`Unexpected OIDC request: ${url}`);
      });
    const config = await discoverOidcConfiguration(
      {
        issuer,
        client_id: "client-1",
        client_auth_method: "client_secret_post",
      },
      "client-secret",
    );
    return { config, fetchMock };
  }

  it("validates authorization code, PKCE, state, nonce, issuer, audience, and signature", async () => {
    const { config, fetchMock } = await setup();
    const claims = await exchangeOidcCode({
      request: new Request(
        "https://app.example/api/auth/enterprise-oidc/callback?code=code-1&state=state-1",
      ),
      callbackUrl: "https://app.example/api/auth/enterprise-oidc/callback",
      expectedState: "state-1",
      pkceVerifier: "verifier-1",
      expectedNonce: "nonce-1",
      oidcConfig: config,
    });
    expect(claims).toMatchObject({
      sub: "subject-1",
      email: "person@example.com",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("loads and validates the discovered JWKS before an interactive connection test", async () => {
    const { config } = await setup();
    await expect(validateOidcJwks(config)).resolves.toBeUndefined();
  });

  it("rejects an empty discovered JWKS", async () => {
    const issuer = "https://idp.example.com";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === `${issuer}/.well-known/openid-configuration`) {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: ["client_secret_post"],
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (url === `${issuer}/jwks`) return Response.json({ keys: [] });
      throw new Error(`Unexpected OIDC request: ${url}`);
    });
    const config = await discoverOidcConfiguration(
      {
        issuer,
        client_id: "client-1",
        client_auth_method: "client_secret_post",
      },
      "client-secret",
    );
    await expect(validateOidcJwks(config)).rejects.toThrow(
      "OIDC provider JWKS endpoint returned no signing keys",
    );
  });

  it("accepts a verified Google Workspace identity for its hosted domain", () => {
    expect(
      validateOrgSsoIdentityClaims(
        {
          sub: "google-subject",
          email: "alice@example.com",
          email_verified: true,
          hd: "example.com",
        },
        {
          issuer: "https://accounts.google.com",
          email_claim: "email",
          email_domains: ["example.com"],
        },
      ),
    ).toMatchObject({
      email: "alice@example.com",
      domain: "example.com",
      emailVerified: true,
      hostedDomain: "example.com",
      eligibleForAutoLink: true,
    });
  });

  it("accepts exact signed email identities from an owner-configured provider", () => {
    expect(
      validateOrgSsoIdentityClaims(
        {
          sub: "generic-subject",
          email: "alice@example.com",
          email_verified: true,
        },
        {
          issuer: "https://idp.example.com",
          email_claim: "email",
          email_domains: ["example.com"],
        },
      ),
    ).toMatchObject({
      email: "alice@example.com",
      emailVerified: true,
      eligibleForAutoLink: true,
    });
  });

  it("allows an empty domain policy while preserving Google's hosted-domain checks", () => {
    expect(
      validateOrgSsoIdentityClaims(
        {
          sub: "google-subject",
          email: "alice@example.com",
          email_verified: true,
          hd: "example.com",
        },
        {
          issuer: "https://accounts.google.com",
          email_claim: "email",
          email_domains: [],
        },
      ),
    ).toMatchObject({
      domain: "example.com",
      hostedDomain: "example.com",
    });
  });

  it("rejects Google identities without a matching verified hosted domain", () => {
    expect(() =>
      validateOrgSsoIdentityClaims(
        {
          sub: "google-subject",
          email: "alice@example.com",
          email_verified: true,
          hd: "other.example.com",
        },
        {
          issuer: "https://accounts.google.com",
          email_claim: "email",
          email_domains: ["example.com"],
        },
      ),
    ).toThrow();
    expect(() =>
      validateOrgSsoIdentityClaims(
        {
          sub: "google-subject",
          email: "alice@example.com",
          email_verified: false,
          hd: "example.com",
        },
        {
          issuer: "https://accounts.google.com",
          email_claim: "email",
          email_domains: ["example.com"],
        },
      ),
    ).toThrow();
  });

  it("rejects a nonce mismatch", async () => {
    const { config } = await setup("different-nonce");
    await expect(
      exchangeOidcCode({
        request: new Request(
          "https://app.example/api/auth/enterprise-oidc/callback?code=code-1&state=state-1",
        ),
        callbackUrl: "https://app.example/api/auth/enterprise-oidc/callback",
        expectedState: "state-1",
        pkceVerifier: "verifier-1",
        expectedNonce: "nonce-1",
        oidcConfig: config,
      }),
    ).rejects.toThrow();
  });

  it("rejects a state mismatch before accepting identity claims", async () => {
    const { config } = await setup();
    await expect(
      exchangeOidcCode({
        request: new Request(
          "https://app.example/api/auth/enterprise-oidc/callback?code=code-1&state=attacker-state",
        ),
        callbackUrl: "https://app.example/api/auth/enterprise-oidc/callback",
        expectedState: "state-1",
        pkceVerifier: "verifier-1",
        expectedNonce: "nonce-1",
        oidcConfig: config,
      }),
    ).rejects.toThrow();
  });

  it("rejects provider redirects using Worker-compatible manual redirect handling", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input, init) => {
        expect(init?.redirect).toBe("manual");
        return Response.redirect(
          "https://redirected.example.com/.well-known/openid-configuration",
          302,
        );
      });

    const discovery = discoverOidcConfiguration(
      {
        issuer: "https://idp.example.com",
        client_id: "client-1",
        client_auth_method: "client_secret_post",
      },
      "client-secret",
    );
    await expect(discovery).rejects.toSatisfy(
      (error: unknown) =>
        getOidcDiscoveryErrorMessage(error) ===
        "OIDC provider redirects are not allowed",
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("returns actionable discovery errors without exposing arbitrary provider details", () => {
    expect(
      getOidcDiscoveryErrorMessage(
        new DOMException("Timed out", "TimeoutError"),
      ),
    ).toBe("The OIDC discovery request timed out");
    expect(
      getOidcDiscoveryErrorMessage(new TypeError("Invalid redirect value")),
    ).toBe(
      "Could not reach the OIDC issuer; verify that its discovery endpoint is publicly reachable",
    );
    expect(
      getOidcDiscoveryErrorMessage(
        new Error("provider response containing unsafe details"),
      ),
    ).toBe(
      "The issuer did not return a valid OpenID Connect discovery document",
    );

    const wrapped = new Error("something went wrong", {
      cause: new TypeError("fetch failed"),
    });
    expect(getOidcDiscoveryErrorDiagnostic(wrapped)).toEqual({
      errorName: "Error",
      errorMessage: "something went wrong",
      causeName: "TypeError",
      causeMessage: "fetch failed",
    });
  });

  it("returns actionable connection-test errors without exposing provider details", () => {
    const invalidClient = new oidc.ResponseBodyError("provider details", {
      cause: {
        error: "invalid_client",
        error_description: "sensitive details",
      },
      response: Response.json({}, { status: 401 }),
    });
    expect(getOidcConnectionTestErrorMessage(invalidClient)).toBe(
      "The token endpoint rejected the client credentials; verify the client ID, client secret, and authentication method",
    );
    expect(
      getOidcConnectionTestErrorMessage(
        new Error("unsafe arbitrary provider response"),
      ),
    ).toBe("The provider login or token exchange could not be verified");
  });
});
