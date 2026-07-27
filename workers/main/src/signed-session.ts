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
/** `auth_source` tag for an org-scoped direct enterprise OIDC session. */
export const ENTERPRISE_OIDC_AUTH_SOURCE = "enterprise_oidc";

/** Identity source attached to signed sessions. */
export type AuthSource =
  | typeof CLOUDFLARE_ACCESS_AUTH_SOURCE
  | typeof POMERIUM_AUTH_SOURCE
  | typeof ENTERPRISE_OIDC_AUTH_SOURCE;

export interface SignedSessionData {
  user_id: string;
  org_id: string;
  workspace_id: string | null;
  created_at: number;
  /** Optional shorter absolute expiry for enterprise SSO sessions. */
  expires_at?: number;
  sso_connection_id?: string | null;
  sso_config_version?: number | null;
  user_name?: string | null;
  user_email?: string | null;
  auth_source?: AuthSource | null;
}

export interface SignedOAuthStateData {
  provider: string;
  redirect_url: string;
  nonce: string;
  created_at: number;
}

export interface SignedEnterpriseSsoStateData {
  org_id: string;
  transaction_id: string;
  connection_id: string;
  config_version: number;
  purpose?: "login" | "test";
  created_at: number;
}

export interface SignedEnterpriseSsoLinkData {
  org_id: string;
  user_id: string;
  created_at: number;
}

const SESSION_PREFIX = 'ss_';
const OAUTH_STATE_PREFIX = 'os_';
const ENTERPRISE_SSO_STATE_PREFIX = 'es_';
const ENTERPRISE_SSO_LINK_PREFIX = 'el_';
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const OAUTH_STATE_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes
const ENTERPRISE_SSO_STATE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes
const ENTERPRISE_SSO_LINK_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

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
    const payload = JSON.parse(decoder.decode(payloadBytes)) as T & {
      created_at: number;
      expires_at?: number;
    };

    if (Date.now() - payload.created_at > maxAgeMs) return null;
    if (typeof payload.expires_at === "number" && Date.now() >= payload.expires_at) return null;

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

export function createSignedEnterpriseSsoState(
  secret: string,
  data: SignedEnterpriseSsoStateData,
): Promise<string> {
  return sign(secret, ENTERPRISE_SSO_STATE_PREFIX, data);
}

export function parseSignedEnterpriseSsoState(
  secret: string,
  token: string,
): Promise<SignedEnterpriseSsoStateData | null> {
  return verify<SignedEnterpriseSsoStateData>(
    secret,
    ENTERPRISE_SSO_STATE_PREFIX,
    token,
    ENTERPRISE_SSO_STATE_MAX_AGE_MS,
  );
}

export function createSignedEnterpriseSsoLink(
  secret: string,
  data: SignedEnterpriseSsoLinkData,
): Promise<string> {
  return sign(secret, ENTERPRISE_SSO_LINK_PREFIX, data);
}

export function parseSignedEnterpriseSsoLink(
  secret: string,
  token: string,
): Promise<SignedEnterpriseSsoLinkData | null> {
  return verify<SignedEnterpriseSsoLinkData>(
    secret,
    ENTERPRISE_SSO_LINK_PREFIX,
    token,
    ENTERPRISE_SSO_LINK_MAX_AGE_MS,
  );
}
