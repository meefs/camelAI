/**
 * Unified cookie utilities for session management.
 *
 * This is the single source of truth for cookie configuration.
 * Used by both React Router routes and worker routes (OAuth).
 */

// Cookie names
export const SESSION_COOKIE = 'chiridion_session_v2';
export const LEGACY_SESSION_COOKIE = 'chiridion_session';
export const SESSION_HEADER = 'X-Chiridion-Session-Id';

// Cookie settings
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days in seconds

/**
 * Get the cookie domain for a hostname.
 * Returns `.chiridion.ai` for chiridion.ai domains (enables subdomain access).
 * Returns undefined for localhost/other domains (host-only cookie).
 */
export function getCookieDomain(hostname: string | undefined): string | undefined {
  if (!hostname) return undefined;

  // Strip port if present
  const host = hostname.split(':')[0];

  // For chiridion.ai domains, set domain to .chiridion.ai to include all subdomains
  if (host.endsWith('.chiridion.ai') || host === 'chiridion.ai') {
    return '.chiridion.ai';
  }

  // For localhost or other domains, don't set domain (host-only cookie)
  return undefined;
}

/**
 * Determine if secure cookie should be used.
 * Checks x-forwarded-proto and cf-visitor headers, defaults to secure.
 */
export function shouldUseSecureCookie(request: Request): boolean {
  // Check x-forwarded-proto
  const forwardedProto = request.headers.get('x-forwarded-proto');
  if (forwardedProto) {
    const scheme = forwardedProto.split(',')[0]?.trim().toLowerCase();
    if (scheme === 'http') return false;
    if (scheme === 'https') return true;
  }

  // Check cf-visitor
  const cfVisitor = request.headers.get('cf-visitor');
  if (cfVisitor) {
    try {
      const parsed = JSON.parse(cfVisitor) as { scheme?: unknown };
      if (parsed.scheme === 'http') return false;
      if (parsed.scheme === 'https') return true;
    } catch {
      // ignore
    }
  }

  // Default to secure in production
  return true;
}

/**
 * Get hostname from request.
 */
export function getHostname(request: Request): string | undefined {
  return request.headers.get('host')?.split(':')[0];
}

/**
 * Build a Set-Cookie header string.
 */
function buildCookieHeader(
  name: string,
  value: string,
  options: {
    maxAge: number;
    secure: boolean;
    domain?: string;
  }
): string {
  const parts = [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${options.maxAge}`,
  ];

  if (options.secure) {
    parts.push('Secure');
  }

  if (options.domain) {
    parts.push(`Domain=${options.domain}`);
  }

  return parts.join('; ');
}

/**
 * Create a Set-Cookie header for the session.
 * Always requires request to ensure proper domain is set.
 */
export function createSessionCookie(sessionId: string, request: Request): string {
  const hostname = getHostname(request);
  const domain = getCookieDomain(hostname);
  const secure = shouldUseSecureCookie(request);

  return buildCookieHeader(SESSION_COOKIE, sessionId, {
    maxAge: SESSION_MAX_AGE,
    secure,
    domain,
  });
}

/**
 * Create a Set-Cookie header to delete the session cookie.
 */
export function createDeleteSessionCookie(request: Request): string {
  const hostname = getHostname(request);
  const domain = getCookieDomain(hostname);
  const secure = shouldUseSecureCookie(request);

  return buildCookieHeader(SESSION_COOKIE, '', {
    maxAge: 0,
    secure,
    domain,
  });
}

/**
 * Create a Set-Cookie header to delete the legacy session cookie.
 */
export function createDeleteLegacyCookie(request: Request): string {
  const hostname = getHostname(request);
  const domain = getCookieDomain(hostname);
  const secure = shouldUseSecureCookie(request);

  return buildCookieHeader(LEGACY_SESSION_COOKIE, '', {
    maxAge: 0,
    secure,
    domain,
  });
}

/**
 * Parse a cookie value from a Cookie header.
 */
export function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=') || '';
  }
  return null;
}

/**
 * Get session ID from request (checks header and cookies).
 */
export function getSessionIdFromRequest(request: Request): string | null {
  // Check header first (for API clients)
  const headerSession = request.headers.get(SESSION_HEADER);
  if (headerSession) return headerSession;

  // Check cookies
  const cookieHeader = request.headers.get('Cookie');
  return (
    parseCookie(cookieHeader, SESSION_COOKIE) ||
    parseCookie(cookieHeader, LEGACY_SESSION_COOKIE) ||
    null
  );
}

/**
 * Add session cookies to response headers.
 */
export function withSessionCookies(
  headers: Headers,
  sessionId: string,
  request: Request
): Headers {
  headers.append('Set-Cookie', createSessionCookie(sessionId, request));
  headers.append('Set-Cookie', createDeleteLegacyCookie(request));
  return headers;
}

/**
 * Add delete session cookies to response headers.
 */
export function withDeleteSessionCookies(
  headers: Headers,
  request: Request
): Headers {
  headers.append('Set-Cookie', createDeleteSessionCookie(request));
  headers.append('Set-Cookie', createDeleteLegacyCookie(request));
  return headers;
}
