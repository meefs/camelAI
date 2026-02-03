/**
 * Response helper functions
 */

import {
  SESSION_COOKIE,
  LEGACY_SESSION_COOKIE,
  SESSION_HEADER,
  SESSION_MAX_AGE,
  getCookieDomain,
  parseCookie,
  getSessionIdFromRequest,
} from '../cookies.js';

// Re-export for backwards compatibility
export { parseCookie as getCookie, getSessionIdFromRequest as getSessionId };

/**
 * Build a Set-Cookie header (simple version for OAuth redirect).
 * Uses hostname string directly since we don't have the full request in redirect context.
 */
function buildSessionCookie(sessionId: string, secure: boolean, hostname?: string): string {
  const domain = getCookieDomain(hostname);
  const parts = [
    `${SESSION_COOKIE}=${sessionId}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_MAX_AGE}`,
  ];
  if (secure) parts.push('Secure');
  if (domain) parts.push(`Domain=${domain}`);
  return parts.join('; ');
}

function buildDeleteCookie(name: string, secure: boolean, hostname?: string): string {
  const domain = getCookieDomain(hostname);
  const parts = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  if (domain) parts.push(`Domain=${domain}`);
  return parts.join('; ');
}

/**
 * Create a redirect response, optionally setting session cookie.
 */
export function redirect(url: string, sessionId?: string, secure = true, hostname?: string): Response {
  const headers = new Headers({ Location: url });
  if (sessionId) {
    headers.append('Set-Cookie', buildSessionCookie(sessionId, secure, hostname));
    headers.append('Set-Cookie', buildDeleteCookie(LEGACY_SESSION_COOKIE, secure, hostname));
  }
  return new Response(null, { status: 302, headers });
}

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const text = (body: string, status = 200) => new Response(body, { status });
