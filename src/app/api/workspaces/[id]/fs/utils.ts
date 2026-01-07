import { NextRequest } from 'next/server';
import * as authDO from '@/lib/auth-do';
import { forbiddenResponse, getSessionId, unauthorizedResponse } from '@/lib/auth';

export async function requireWorkspaceSession(
  workspaceId: string,
  options: { requireWrite?: boolean } = {}
) {
  const sessionId = await getSessionId();
  if (!sessionId) {
    return { response: unauthorizedResponse() };
  }

  const session = await authDO.getSession(sessionId);
  if (!session) {
    return { response: unauthorizedResponse() };
  }

  const workspace = await authDO.getWorkspace(workspaceId);
  if (!workspace || workspace.org_id !== session.org_id) {
    return { response: forbiddenResponse('Workspace not found') };
  }

  // FIXME: Enforce viewer role restrictions when publishing is implemented.
  // Viewers should only access published apps, not workspace files.
  const access = await authDO.getWorkspaceAccess(workspaceId, session.user_id);
  if (access === 'none') {
    return { response: forbiddenResponse('Workspace not found') };
  }
  if (options.requireWrite && access !== 'full') {
    return { response: forbiddenResponse('Read-only workspace access') };
  }

  return { session, access };
}

export function normalizeWorkspacePath(input?: string | null): string {
  if (!input) return '/';
  let raw = input.trim();
  if (!raw.startsWith('/')) raw = `/${raw}`;

  const segments: string[] = [];
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (segments.length === 0) {
        throw new Error('Path escapes workspace root');
      }
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  return `/${segments.join('/')}`;
}

export function getPathParam(request: NextRequest, key = 'path'): string {
  const value = request.nextUrl.searchParams.get(key);
  return normalizeWorkspacePath(value);
}

export async function parseJson<T>(request: NextRequest): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new Error('Invalid JSON body');
  }
}

const encoder = new TextEncoder();

export async function hashContent(content: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(content));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
