import { parseCookie } from "../../workers/main/src/cookies";

const BINDING_PREFIX = "enterprise_sso_binding_";
const LINK_PREFIX = "enterprise_sso_link_";

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function createSsoBrowserBinding(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashSsoBrowserBinding(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64url(new Uint8Array(digest));
}

export function getSsoBrowserBindingCookie(
  request: Request,
  transactionId: string,
): string | null {
  return parseCookie(request.headers.get("Cookie"), `${BINDING_PREFIX}${transactionId}`);
}

export function createSsoBrowserBindingCookie(
  transactionId: string,
  value: string,
  maxAgeSeconds: number,
): string {
  return `${BINDING_PREFIX}${transactionId}=${value}; Path=/api/auth/enterprise-oidc/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function deleteSsoBrowserBindingCookie(transactionId: string): string {
  return `${BINDING_PREFIX}${transactionId}=; Path=/api/auth/enterprise-oidc/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function getSsoLinkCookie(request: Request, orgId: string): string | null {
  return parseCookie(request.headers.get("Cookie"), `${LINK_PREFIX}${orgId}`);
}

export function createSsoLinkCookie(orgId: string, value: string): string {
  return `${LINK_PREFIX}${orgId}=${value}; Path=/sso/; HttpOnly; Secure; SameSite=Lax; Max-Age=300`;
}

export function deleteSsoLinkCookie(orgId: string): string {
  return `${LINK_PREFIX}${orgId}=; Path=/sso/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
