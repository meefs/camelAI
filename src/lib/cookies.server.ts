import { parse, serialize, type SerializeOptions } from 'cookie';
import type { SessionData } from '../../workers/main/src/session-kv';
import { getSession as getSessionKV } from '../../workers/main/src/session-kv';

interface EnvWithSessions {
  SESSIONS: KVNamespace;
}

// Cookie configuration
export const SESSION_COOKIE_NAME = 'chiridion_session_v2';
export const LEGACY_SESSION_COOKIE_NAME = 'chiridion_session';
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days in seconds

export const SESSION_COOKIE_OPTIONS: SerializeOptions = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  maxAge: SESSION_MAX_AGE,
};

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
export function getSessionIdFromRequest(request: Request): string | null {
  const cookies = parseCookies(request);
  return (
    cookies[SESSION_COOKIE_NAME] ||
    cookies[LEGACY_SESSION_COOKIE_NAME] ||
    null
  );
}

/**
 * Get the request scheme (http or https) from headers
 */
function getRequestScheme(request: Request): 'http' | 'https' | null {
  const forwardedProto = request.headers.get('x-forwarded-proto');
  if (forwardedProto) {
    const scheme = forwardedProto.split(',')[0]?.trim().toLowerCase();
    if (scheme === 'https' || scheme === 'http') return scheme;
  }

  const cfVisitor = request.headers.get('cf-visitor');
  if (cfVisitor) {
    try {
      const parsed = JSON.parse(cfVisitor) as { scheme?: unknown };
      const scheme =
        typeof parsed.scheme === 'string' ? parsed.scheme.toLowerCase() : null;
      if (scheme === 'https' || scheme === 'http') return scheme;
    } catch {
      // ignore
    }
  }

  return null;
}

/**
 * Determine if secure cookie should be used based on request
 */
function shouldUseSecureCookie(request: Request): boolean {
  const scheme = getRequestScheme(request);
  if (scheme) return scheme === 'https';
  return true; // Default to secure in production
}

/**
 * Get the cookie domain from the request hostname
 * Returns undefined for localhost (host-only cookie), or the parent domain for chiridion.ai
 */
function getCookieDomain(request: Request): string | undefined {
  const hostname = request.headers.get('host')?.split(':')[0];
  if (!hostname) return undefined;

  // For chiridion.ai domains, set domain to .chiridion.ai to include all subdomains
  if (hostname.endsWith('.chiridion.ai') || hostname === 'chiridion.ai') {
    return '.chiridion.ai';
  }

  // For localhost or other domains, don't set domain (host-only cookie)
  return undefined;
}

/**
 * Create a Set-Cookie header value for the session
 */
export function createSessionCookieHeader(
  sessionId: string,
  request: Request
): string {
  const domain = getCookieDomain(request);
  return serialize(SESSION_COOKIE_NAME, sessionId, {
    ...SESSION_COOKIE_OPTIONS,
    secure: shouldUseSecureCookie(request),
    ...(domain && { domain }),
  });
}

/**
 * Create a Set-Cookie header to delete the session cookie
 */
export function createDeleteSessionCookieHeader(request: Request): string {
  const domain = getCookieDomain(request);
  return serialize(SESSION_COOKIE_NAME, '', {
    ...SESSION_COOKIE_OPTIONS,
    maxAge: 0,
    expires: new Date(0),
    secure: shouldUseSecureCookie(request),
    ...(domain && { domain }),
  });
}

/**
 * Create a Set-Cookie header to delete the legacy session cookie
 */
export function createDeleteLegacySessionCookieHeader(request: Request): string {
  const domain = getCookieDomain(request);
  return serialize(LEGACY_SESSION_COOKIE_NAME, '', {
    ...SESSION_COOKIE_OPTIONS,
    maxAge: 0,
    expires: new Date(0),
    secure: shouldUseSecureCookie(request),
    ...(domain && { domain }),
  });
}

/**
 * Add session cookie to response headers
 */
export function withSessionCookie(
  headers: Headers,
  sessionId: string,
  request: Request
): Headers {
  headers.append('Set-Cookie', createSessionCookieHeader(sessionId, request));
  return headers;
}

/**
 * Add delete session cookie to response headers
 */
export function withDeleteSessionCookie(
  headers: Headers,
  request: Request
): Headers {
  headers.append('Set-Cookie', createDeleteSessionCookieHeader(request));
  return headers;
}

/**
 * Get a specific cookie value from the request
 */
export function getCookie(request: Request, name: string): string | null {
  const cookies = parseCookies(request);
  return cookies[name] || null;
}

/**
 * Alias for getSessionIdFromRequest for convenience
 */
export function getSessionId(request: Request): string | null {
  return getSessionIdFromRequest(request);
}

/**
 * Alias for createSessionCookieHeader that doesn't require request
 * Note: This creates a session cookie with default secure settings
 * Use createSessionCookieHeader when you have access to the request for proper domain/secure handling
 */
export function createSessionCookie(sessionId: string): string {
  return serialize(SESSION_COOKIE_NAME, sessionId, {
    ...SESSION_COOKIE_OPTIONS,
    secure: true,
  });
}

/**
 * Alias for createDeleteSessionCookieHeader that doesn't require request
 */
export function deleteSessionCookie(): string {
  return serialize(SESSION_COOKIE_NAME, '', {
    ...SESSION_COOKIE_OPTIONS,
    maxAge: 0,
    expires: new Date(0),
    secure: true,
  });
}

/**
 * Delete legacy session cookie without request context.
 */
export function deleteLegacySessionCookie(): string {
  return serialize(LEGACY_SESSION_COOKIE_NAME, '', {
    ...SESSION_COOKIE_OPTIONS,
    maxAge: 0,
    expires: new Date(0),
    secure: true,
  });
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
