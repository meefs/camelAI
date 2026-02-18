/**
 * Unified cookie utilities for session management.
 */

export const SESSION_HEADER = 'X-Chiridion-Session-Id';
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

/**
 * Get the session cookie name for the current environment.
 * Handles subdomains like asdf.apps.staging.camelai.dev
 */
export function getSessionCookieName(hostname: string | undefined): string {
  if (!hostname) return 'chiridion_session_v3';

  const host = hostname.split(':')[0];

  if (host === 'localhost' || host === '127.0.0.1') return 'chiridion_session_local';
  if (host.endsWith('.staging.camelai.dev') || host === 'staging.camelai.dev') return 'chiridion_session_staging';
  if (host.endsWith('.dev-illiana.camelai.dev') || host === 'dev-illiana.camelai.dev') return 'chiridion_session_illiana';
  if (host.endsWith('.dev-miguel.camelai.dev') || host === 'dev-miguel.camelai.dev') return 'chiridion_session_miguel';
  if (host.endsWith('.camelai.dev') || host === 'camelai.dev') return 'chiridion_session_v3';

  return 'chiridion_session_v3';
}

/**
 * Get the cookie domain for subdomain sharing.
 */
export function getCookieDomain(hostname: string | undefined): string | undefined {
  if (!hostname) return undefined;
  const host = hostname.split(':')[0];

  if (host === 'localhost' || host === '127.0.0.1') return undefined;
  if (host.endsWith('.staging.camelai.dev') || host === 'staging.camelai.dev') return '.staging.camelai.dev';
  if (host.endsWith('.dev-illiana.camelai.dev') || host === 'dev-illiana.camelai.dev') return '.dev-illiana.camelai.dev';
  if (host.endsWith('.dev-miguel.camelai.dev') || host === 'dev-miguel.camelai.dev') return '.dev-miguel.camelai.dev';
  if (host.endsWith('.camelai.dev') || host === 'camelai.dev') return '.camelai.dev';

  return undefined;
}

function isSecure(request: Request): boolean {
  const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  if (proto) return proto === 'https';
  try {
    const cf = JSON.parse(request.headers.get('cf-visitor') || '{}');
    if (cf.scheme) return cf.scheme === 'https';
  } catch {}
  return true;
}

function getHostname(request: Request): string | undefined {
  return request.headers.get('host')?.split(':')[0];
}

function buildCookie(name: string, value: string, maxAge: number, secure: boolean, domain?: string): string {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (secure) parts.push('Secure');
  if (domain) parts.push(`Domain=${domain}`);
  return parts.join('; ');
}

function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  let result: string | null = null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) result = rest.join('=') || '';
  }
  return result;
}

export function getSessionIdFromRequest(request: Request): string | null {
  const header = request.headers.get(SESSION_HEADER);
  if (header) return header;

  const hostname = getHostname(request);
  return parseCookie(request.headers.get('Cookie'), getSessionCookieName(hostname));
}

export function createSessionCookie(sessionId: string, request: Request): string {
  const hostname = getHostname(request);
  return buildCookie(
    getSessionCookieName(hostname),
    sessionId,
    SESSION_MAX_AGE,
    isSecure(request),
    getCookieDomain(hostname)
  );
}

export function createDeleteSessionCookie(request: Request): string {
  const hostname = getHostname(request);
  return buildCookie(getSessionCookieName(hostname), '', 0, isSecure(request), getCookieDomain(hostname));
}

export function withSessionCookies(headers: Headers, sessionId: string, request: Request): Headers {
  headers.append('Set-Cookie', createSessionCookie(sessionId, request));
  return headers;
}

export function withDeleteSessionCookies(headers: Headers, request: Request): Headers {
  headers.append('Set-Cookie', createDeleteSessionCookie(request));
  return headers;
}
