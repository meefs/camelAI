const TOKEN_PREFIX = "ev_";
const DEFAULT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface EmailVerificationTokenPayload {
  purpose: "email_verification";
  user_id: string;
  email: string;
  iat: number;
  exp: number;
}

function base64urlEncode(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function base64urlDecode(str: string): Uint8Array {
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function importKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function createEmailVerificationToken(
  secret: string,
  data: {
    user_id: string;
    email: string;
    issuedAt?: number;
    ttlMs?: number;
  },
): Promise<string> {
  const issuedAt = data.issuedAt ?? Date.now();
  const ttlMs = data.ttlMs ?? DEFAULT_TOKEN_TTL_MS;
  const payload: EmailVerificationTokenPayload = {
    purpose: "email_verification",
    user_id: data.user_id,
    email: data.email.toLowerCase(),
    iat: issuedAt,
    exp: issuedAt + ttlMs,
  };

  const encoder = new TextEncoder();
  const payloadBytes = encoder.encode(JSON.stringify(payload));
  const payloadB64 = base64urlEncode(payloadBytes);

  const key = await importKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, payloadBytes);
  const signatureB64 = base64urlEncode(new Uint8Array(signature));

  return `${TOKEN_PREFIX}${payloadB64}.${signatureB64}`;
}

export async function validateEmailVerificationToken(
  secret: string,
  token: string,
): Promise<EmailVerificationTokenPayload | null> {
  if (!token.startsWith(TOKEN_PREFIX)) {
    return null;
  }

  const body = token.slice(TOKEN_PREFIX.length);
  const dotIndex = body.indexOf(".");
  if (dotIndex === -1) {
    return null;
  }

  const payloadB64 = body.slice(0, dotIndex);
  const signatureB64 = body.slice(dotIndex + 1);

  try {
    const payloadBytes = base64urlDecode(payloadB64);
    const signatureBytes = base64urlDecode(signatureB64);

    const key = await importKey(secret);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      new Uint8Array(signatureBytes),
      new Uint8Array(payloadBytes),
    );
    if (!valid) return null;

    const decoder = new TextDecoder();
    const payload = JSON.parse(
      decoder.decode(payloadBytes),
    ) as EmailVerificationTokenPayload;

    if (payload.purpose !== "email_verification") return null;
    if (typeof payload.user_id !== "string" || payload.user_id.length === 0)
      return null;
    if (typeof payload.email !== "string" || payload.email.length === 0)
      return null;
    if (typeof payload.exp !== "number" || payload.exp < Date.now())
      return null;

    return payload;
  } catch {
    return null;
  }
}
