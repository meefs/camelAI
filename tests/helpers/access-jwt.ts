/** Shared fixtures for Cloudflare Access JWT tests. */

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

export async function createAccessJwt(
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

/**
 * Mint an ES256 (ECDSA P-256) JWT, mirroring how Pomerium signs its attestation
 * assertion. Returns the token and the public JWK to serve from a JWKS stub.
 */
export async function createPomeriumJwt(
  payload: Record<string, unknown>,
): Promise<{ token: string; publicJwk: JsonWebKey }> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicJwk = {
    ...(await crypto.subtle.exportKey("jwk", keyPair.publicKey)),
    kid: "test-key",
    alg: "ES256",
    use: "sig",
  };

  const encoder = new TextEncoder();
  const encodedHeader = base64urlEncode(
    encoder.encode(JSON.stringify({ alg: "ES256", kid: "test-key" })),
  );
  const encodedPayload = base64urlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keyPair.privateKey,
    encoder.encode(`${encodedHeader}.${encodedPayload}`),
  );

  return {
    token: `${encodedHeader}.${encodedPayload}.${base64urlEncode(new Uint8Array(signature))}`,
    publicJwk,
  };
}

export function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}
