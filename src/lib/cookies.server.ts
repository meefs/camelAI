/**
 * Cookie utilities for React Router routes.
 */

import { parse } from 'cookie';
import {
  SESSION_MAX_AGE,
  getSessionCookieName,
  getSessionIdFromRequest as getSessionIdFromRequestBase,
  getSignedSessionFromRequest as getSignedSessionFromRequestBase,
  createSignedSessionCookie as createSignedSessionCookieBase,
  createSessionCookie,
  createDeleteSessionCookie,
  withSessionCookies,
  withDeleteSessionCookies,
  type SignedSessionData,
} from '../../workers/main/src/cookies';

export { SESSION_MAX_AGE };
export type { SignedSessionData };

// For backwards compat - returns the cookie name for the current request
export function getSessionCookieNameForRequest(request: Request): string {
  const hostname = request.headers.get('host')?.split(':')[0];
  return getSessionCookieName(hostname);
}

// Alias for backwards compat
export const SESSION_COOKIE_NAME = 'chiridion_session_v3'; // Default/prod name

export function getSessionIdFromRequest(request: Request): string | null {
  return getSessionIdFromRequestBase(request);
}

export function parseCookies(request: Request): Record<string, string | undefined> {
  const cookieHeader = request.headers.get('Cookie');
  return cookieHeader ? parse(cookieHeader) : {};
}

export function getCookie(request: Request, name: string): string | null {
  const cookies = parseCookies(request);
  return cookies[name] || null;
}

export function createSessionCookieHeader(sessionId: string, request: Request): string {
  return createSessionCookie(sessionId, request);
}

export function createDeleteSessionCookieHeader(request: Request): string {
  return createDeleteSessionCookie(request);
}

export function withSessionCookie(headers: Headers, sessionId: string, request: Request): Headers {
  return withSessionCookies(headers, sessionId, request);
}

export function withDeleteSessionCookie(headers: Headers, request: Request): Headers {
  return withDeleteSessionCookies(headers, request);
}

// --- Signed session helpers ---

export async function getSignedSessionFromRequest(
  request: Request,
  secret: string
): Promise<SignedSessionData | null> {
  return getSignedSessionFromRequestBase(request, secret);
}

export async function createSignedSessionCookieHeader(
  sessionData: SignedSessionData,
  secret: string,
  request: Request
): Promise<string> {
  return createSignedSessionCookieBase(sessionData, secret, request);
}
