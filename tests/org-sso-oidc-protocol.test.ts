import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverOidcConfiguration,
  exchangeOidcCode,
} from "../src/lib/org-sso.server";

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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
  const header = base64url(encoder.encode(JSON.stringify({ alg: "RS256", kid: "oidc-test-key" })));
  const payload = base64url(encoder.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    pair.privateKey,
    encoder.encode(`${header}.${payload}`),
  );
  return { token: `${header}.${payload}.${base64url(new Uint8Array(signature))}`, publicJwk };
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
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
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
      if (url === `${issuer}/jwks`) return Response.json({ keys: [jwt.publicJwk] });
      throw new Error(`Unexpected OIDC request: ${url}`);
    });
    const config = await discoverOidcConfiguration({
      issuer,
      client_id: "client-1",
      client_auth_method: "client_secret_post",
    }, "client-secret");
    return { config, fetchMock };
  }

  it("validates authorization code, PKCE, state, nonce, issuer, audience, and signature", async () => {
    const { config, fetchMock } = await setup();
    const claims = await exchangeOidcCode({
      request: new Request("https://app.example/api/auth/enterprise-oidc/callback?code=code-1&state=state-1"),
      callbackUrl: "https://app.example/api/auth/enterprise-oidc/callback",
      expectedState: "state-1",
      pkceVerifier: "verifier-1",
      expectedNonce: "nonce-1",
      oidcConfig: config,
    });
    expect(claims).toMatchObject({ sub: "subject-1", email: "person@example.com" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rejects a nonce mismatch", async () => {
    const { config } = await setup("different-nonce");
    await expect(exchangeOidcCode({
      request: new Request("https://app.example/api/auth/enterprise-oidc/callback?code=code-1&state=state-1"),
      callbackUrl: "https://app.example/api/auth/enterprise-oidc/callback",
      expectedState: "state-1",
      pkceVerifier: "verifier-1",
      expectedNonce: "nonce-1",
      oidcConfig: config,
    })).rejects.toThrow();
  });

  it("rejects a state mismatch before accepting identity claims", async () => {
    const { config } = await setup();
    await expect(exchangeOidcCode({
      request: new Request("https://app.example/api/auth/enterprise-oidc/callback?code=code-1&state=attacker-state"),
      callbackUrl: "https://app.example/api/auth/enterprise-oidc/callback",
      expectedState: "state-1",
      pkceVerifier: "verifier-1",
      expectedNonce: "nonce-1",
      oidcConfig: config,
    })).rejects.toThrow();
  });
});
