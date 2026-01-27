/**
 * Response helper functions
 */

import { SESSION_COOKIE, LEGACY_SESSION_COOKIE, SESSION_HEADER } from '../types.js';

export function getCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=') || '';
  }
  return null;
}

export function getSessionId(req: Request): string | null {
  return (
    req.headers.get(SESSION_HEADER) ||
    getCookie(req.headers.get('Cookie'), SESSION_COOKIE) ||
    getCookie(req.headers.get('Cookie'), LEGACY_SESSION_COOKIE)
  );
}

function sessionCookie(id: string, secure: boolean): string {
  const opts = [`${SESSION_COOKIE}=${id}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=2592000'];
  if (secure) opts.push('Secure');
  return opts.join('; ');
}

function deleteCookie(name: string, secure: boolean): string {
  const opts = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) opts.push('Secure');
  return opts.join('; ');
}

export function redirect(url: string, sessionId?: string, secure = true): Response {
  const headers = new Headers({ Location: url });
  if (sessionId) {
    headers.append('Set-Cookie', sessionCookie(sessionId, secure));
    headers.append('Set-Cookie', deleteCookie(LEGACY_SESSION_COOKIE, secure));
  }
  return new Response(null, { status: 302, headers });
}

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const text = (body: string, status = 200) => new Response(body, { status });
