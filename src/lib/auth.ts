import type { User, Organization, OrgMembership, WorkspaceWithAccess } from '@/types';
import {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE,
  getSessionIdFromRequest,
  createSessionCookieHeader,
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
 * Create a Set-Cookie header to set the session cookie.
 * Add this to your response headers.
 */
export function setSessionCookie(sessionId: string, request: Request): string {
  return createSessionCookieHeader(sessionId, request);
}

/**
 * Create a Set-Cookie header to delete the session cookie.
 * Add this to your response headers.
 */
export function deleteSessionCookie(request: Request): string {
  return createDeleteSessionCookieHeader(request);
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
