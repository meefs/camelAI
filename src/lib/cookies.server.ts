/**
 * Cookie utilities for React Router routes.
 *
 * Uses the shared cookie module from workers/main/src/cookies.ts
 * for constants and domain logic.
 */

import { parse } from 'cookie';
import type { SessionData } from '../../workers/main/src/session-kv';
import { getSession as getSessionKV } from '../../workers/main/src/session-kv';
import {
  SESSION_COOKIE,
  LEGACY_SESSION_COOKIE,
  SESSION_MAX_AGE,
  getCookieDomain,
  shouldUseSecureCookie,
  getHostname,
  createSessionCookie,
  createDeleteSessionCookie,
  createDeleteLegacyCookie,
  getSessionIdFromRequest,
  withSessionCookies,
  withDeleteSessionCookies,
} from '../../workers/main/src/cookies';

// Re-export constants for backwards compatibility
export const SESSION_COOKIE_NAME = SESSION_COOKIE;
export const LEGACY_SESSION_COOKIE_NAME = LEGACY_SESSION_COOKIE;
export { SESSION_MAX_AGE };

interface EnvWithSessions {
  SESSIONS: KVNamespace;
}

/**
 * Parse cookies from a request
 */
export function parseCookies(request: Request): Record<string, string | undefined> {
  const cookieHeader = request.headers.get('Cookie');
  return cookieHeader ? parse(cookieHeader) : {};
}

/**
 * Get session ID from request cookies
 */
export { getSessionIdFromRequest };

/**
 * Alias for getSessionIdFromRequest for convenience
 */
export function getSessionId(request: Request): string | null {
  return getSessionIdFromRequest(request);
}

/**
 * Create a Set-Cookie header value for the session
 */
export function createSessionCookieHeader(sessionId: string, request: Request): string {
  return createSessionCookie(sessionId, request);
}

/**
 * Create a Set-Cookie header to delete the session cookie
 */
export function createDeleteSessionCookieHeader(request: Request): string {
  return createDeleteSessionCookie(request);
}

/**
 * Create a Set-Cookie header to delete the legacy session cookie
 */
export function createDeleteLegacySessionCookieHeader(request: Request): string {
  return createDeleteLegacyCookie(request);
}

/**
 * Add session cookie to response headers
 */
export function withSessionCookie(
  headers: Headers,
  sessionId: string,
  request: Request
): Headers {
  return withSessionCookies(headers, sessionId, request);
}

/**
 * Add delete session cookie to response headers
 */
export function withDeleteSessionCookie(
  headers: Headers,
  request: Request
): Headers {
  return withDeleteSessionCookies(headers, request);
}

/**
 * Get a specific cookie value from the request
 */
export function getCookie(request: Request, name: string): string | null {
  const cookies = parseCookies(request);
  return cookies[name] || null;
}

/**
 * Get session data from KV storage
 */
export async function getSession(
  env: EnvWithSessions,
  sessionId: string
): Promise<SessionData | null> {
  return getSessionKV(env.SESSIONS, sessionId);
}
