import type { AppLoadContext } from 'react-router';
import { getSession } from '@/lib/auth.server';
import { getEnv, type CloudflareEnv } from '@/lib/cloudflare.server';
import { getWorkspace, getWorkspaceAccess, type AuthEnv } from '@/lib/auth-do';
import type { WorkspaceAccessLevel } from '../../../workers/main/src/workspace';
import {
  getWorkspaceContainer,
  type WorkspaceContainer,
  type WorkspaceContainerEnv,
} from '../../../workers/main/src/workspace-container';

export interface WorkspaceAuth {
  userId: string;
  orgId: string;
  workspaceId: string;
  access: WorkspaceAccessLevel;
  container: DurableObjectStub<WorkspaceContainer>;
}

/**
 * Require workspace session with optional write access check.
 * Returns workspace auth info and container stub, or throws Response on error.
 */
export async function requireWorkspaceAuth(
  request: Request,
  context: AppLoadContext,
  workspaceId: string,
  options: { requireWrite?: boolean } = {}
): Promise<WorkspaceAuth> {
  const sessionContext = await getSession(request, context);
  if (!sessionContext) {
    throw Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const env = getEnv(context);

  // Cast to AuthEnv for auth-do functions
  const authEnv = env as unknown as AuthEnv;

  const workspace = await getWorkspace(authEnv, workspaceId);
  if (!workspace || workspace.org_id !== sessionContext.session.org_id) {
    throw Response.json({ error: 'Workspace not found' }, { status: 404 });
  }

  const access = await getWorkspaceAccess(authEnv, workspaceId, sessionContext.session.user_id);
  if (access === 'none') {
    throw Response.json({ error: 'Workspace not found' }, { status: 404 });
  }
  if (options.requireWrite && access !== 'full') {
    throw Response.json({ error: 'Read-only workspace access' }, { status: 403 });
  }

  // Get workspace container - cast to WorkspaceContainerEnv
  const containerEnv = env as unknown as WorkspaceContainerEnv;
  const container = getWorkspaceContainer(containerEnv, workspaceId);

  // Ensure container is initialized with env vars before any operations
  await container.startForWorkspace(workspaceId, workspace.org_id);

  return {
    userId: sessionContext.session.user_id,
    orgId: sessionContext.session.org_id,
    workspaceId,
    access,
    container,
  };
}

/** Workspace root directory inside the container */
const WORKSPACE_ROOT = '/home/claude';

/**
 * Normalize a workspace path, preventing directory traversal attacks.
 */
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

/**
 * Convert a workspace-relative path to an absolute container path.
 * Workspace path '/' maps to '/home/claude', '/foo' maps to '/home/claude/foo'.
 */
export function toContainerPath(workspacePath: string): string {
  const normalized = normalizeWorkspacePath(workspacePath);
  if (normalized === '/') return WORKSPACE_ROOT;
  return `${WORKSPACE_ROOT}${normalized}`;
}

/**
 * Get path parameter from URL search params.
 */
export function getPathParam(url: URL, key = 'path'): string {
  const value = url.searchParams.get(key);
  return normalizeWorkspacePath(value);
}

/**
 * Parse boolean parameter from URL search params.
 */
export function parseBooleanParam(value: string | null, defaultValue: boolean): boolean {
  if (value === null) return defaultValue;
  if (value === '1' || value.toLowerCase() === 'true') return true;
  if (value === '0' || value.toLowerCase() === 'false') return false;
  return defaultValue;
}
