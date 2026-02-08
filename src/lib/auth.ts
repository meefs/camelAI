import {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE,
  getSessionIdFromRequest,
  createDeleteSessionCookieHeader,
} from './cookies.server';

export { SESSION_COOKIE_NAME, SESSION_MAX_AGE };

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

export function getSessionId(request: Request): string | null {
  return getSessionIdFromRequest(request);
}

export function deleteSessionCookie(request: Request): string {
  return createDeleteSessionCookieHeader(request);
}
