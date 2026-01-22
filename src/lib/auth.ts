import {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE,
  getSessionIdFromRequest,
  createDeleteSessionCookieHeader,
} from './cookies.server';

// Re-export cookie configuration for convenience
export { SESSION_COOKIE_NAME, SESSION_MAX_AGE } from './cookies.server';

export interface SessionCookieOptions {
  httpOnly: boolean;
  secure?: boolean;
  sameSite: 'lax' | 'strict' | 'none';
  path: string;
  maxAge: number;
}

export const SESSION_COOKIE_OPTIONS: SessionCookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  maxAge: SESSION_MAX_AGE,
};

/**
 * Get session ID from request cookies.
 * Use this in loaders/actions where you have access to the request.
 */
export function getSessionId(request: Request): string | null {
  return getSessionIdFromRequest(request);
}

/**
 * Create a Set-Cookie header to delete the session cookie.
 * Add this to your response headers.
 */
export function deleteSessionCookie(request: Request): string {
  return createDeleteSessionCookieHeader(request);
}
