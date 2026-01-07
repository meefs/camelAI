import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';
import type { User, Organization, OrgMembership, WorkspaceWithAccess } from '@/types';

// Cookie configuration
export const SESSION_COOKIE_NAME = 'chiridion_session';
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days in seconds

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

function getRequestScheme(request?: NextRequest): 'http' | 'https' | null {
  if (!request) return null;

  const forwardedProto = request.headers.get('x-forwarded-proto');
  if (forwardedProto) {
    const scheme = forwardedProto.split(',')[0]?.trim().toLowerCase();
    if (scheme === 'https' || scheme === 'http') return scheme;
  }

  const cfVisitor = request.headers.get('cf-visitor');
  if (cfVisitor) {
    try {
      const parsed = JSON.parse(cfVisitor) as { scheme?: unknown };
      const scheme = typeof parsed.scheme === 'string' ? parsed.scheme.toLowerCase() : null;
      if (scheme === 'https' || scheme === 'http') return scheme;
    } catch {
      // ignore
    }
  }

  const protocol = request.nextUrl?.protocol;
  if (protocol === 'https:' || protocol === 'http:') return protocol.slice(0, -1) as 'https' | 'http';

  return null;
}

function shouldUseSecureCookie(request?: NextRequest): boolean {
  const scheme = getRequestScheme(request);
  if (scheme) return scheme === 'https';
  return (process.env.NEXTJS_ENV ?? process.env.NODE_ENV) === 'production';
}

// Get session ID from cookie
export async function getSessionId(): Promise<string | null> {
  const cookieStore = await cookies();
  const cookie = cookieStore.get(SESSION_COOKIE_NAME);
  return cookie?.value || null;
}

// Set session cookie
export async function setSessionCookie(sessionId: string, request?: NextRequest): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, sessionId, {
    ...SESSION_COOKIE_OPTIONS,
    secure: shouldUseSecureCookie(request),
  });
}

// Delete session cookie
export async function deleteSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE_NAME);
}

// Response helpers for API routes
export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

export function unauthorizedResponse(message = 'Unauthorized'): Response {
  return errorResponse(message, 401);
}

export function forbiddenResponse(message = 'Forbidden'): Response {
  return errorResponse(message, 403);
}

// Validation helpers
export function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

export function isValidPassword(password: string): boolean {
  return password.length >= 8;
}

// Auth result type for API routes
export interface AuthResult {
  user: User;
  currentOrg: Organization;
  currentWorkspace?: WorkspaceWithAccess | null;
  orgs: OrgMembership[];
  workspaces?: WorkspaceWithAccess[];
  sessionId: string;
}
