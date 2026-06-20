/**
 * HMAC-signed session and OAuth state tokens.
 *
 * Session data lives entirely in the cookie — no server-side storage needed.
 * This eliminates KV eventual-consistency issues where a session written at
 * one POP isn't visible at another POP that handles the redirect.
 *
 * Token formats:
 *   ss_<base64url(payload)>.<base64url(hmac)>  — Signed session (30-day expiry)
 *   os_<base64url(payload)>.<base64url(hmac)>  — OAuth state (5-minute expiry)
 */

/** `auth_source` tag for sessions minted from a Cloudflare Access assertion. */
export const CLOUDFLARE_ACCESS_AUTH_SOURCE = "cloudflare_access";
/** `auth_source` tag for sessions minted from a Pomerium assertion. */
export const POMERIUM_AUTH_SOURCE = "pomerium";

/** `auth_source` tag for any session minted from a trusted reverse-proxy
 * identity assertion (Cloudflare Access, Pomerium, ...). */
export type ProxyAuthSource =
  | typeof CLOUDFLARE_ACCESS_AUTH_SOURCE
  | typeof POMERIUM_AUTH_SOURCE;

export interface SignedSessionData {
  user_id: string;
  org_id: string;
  workspace_id: string | null;
  created_at: number;
  user_name?: string | null;
  user_email?: string | null;
  auth_source?: ProxyAuthSource | null;
}

export interface SignedOAuthStateData {
  provider: string;
  redirect_url: string;
  nonce: string;
  created_at: number;
}

const SESSION_PREFIX = 'ss_';
const OAUTH_STATE_PREFIX = 'os_';
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const OAUTH_STATE_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

function base64urlEncode(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

export function base64urlDecode(str: string): Uint8Array<ArrayBuffer> {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function importKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

async function sign(secret: string, prefix: string, payload: object): Promise<string> {
  const encoder = new TextEncoder();
  const payloadBytes = encoder.encode(JSON.stringify(payload));
  const payloadB64 = base64urlEncode(payloadBytes);

  const key = await importKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, payloadBytes);
  const signatureB64 = base64urlEncode(new Uint8Array(signature));

  return `${prefix}${payloadB64}.${signatureB64}`;
}

async function verify<T>(secret: string, prefix: string, token: string, maxAgeMs: number): Promise<T | null> {
  if (!token.startsWith(prefix)) return null;

  const body = token.slice(prefix.length);
  const dotIndex = body.indexOf('.');
  if (dotIndex === -1) return null;

  const payloadB64 = body.slice(0, dotIndex);
  const signatureB64 = body.slice(dotIndex + 1);

  try {
    const payloadBytes = base64urlDecode(payloadB64);
    const signatureBytes = base64urlDecode(signatureB64);

    const key = await importKey(secret);
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      new Uint8Array(signatureBytes),
      new Uint8Array(payloadBytes)
    );
    if (!valid) return null;

    const decoder = new TextDecoder();
    const payload = JSON.parse(decoder.decode(payloadBytes)) as T & { created_at: number };

    if (Date.now() - payload.created_at > maxAgeMs) return null;

    return payload;
  } catch {
    return null;
  }
}

// --- Signed Session ---

export async function createSignedSession(
  secret: string,
  data: SignedSessionData
): Promise<string> {
  return sign(secret, SESSION_PREFIX, data);
}

export async function parseSignedSession(
  secret: string,
  token: string
): Promise<SignedSessionData | null> {
  return verify<SignedSessionData>(secret, SESSION_PREFIX, token, SESSION_MAX_AGE_MS);
}

// --- OAuth State ---

export async function createSignedOAuthState(
  secret: string,
  data: SignedOAuthStateData
): Promise<string> {
  return sign(secret, OAUTH_STATE_PREFIX, data);
}

export async function parseSignedOAuthState(
  secret: string,
  token: string
): Promise<SignedOAuthStateData | null> {
  return verify<SignedOAuthStateData>(secret, OAUTH_STATE_PREFIX, token, OAUTH_STATE_MAX_AGE_MS);
}
