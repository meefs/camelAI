import type { AppLoadContext } from 'react-router';
import { getSession } from '@/lib/auth.server';
import { getEnv, type CloudflareEnv } from '@/lib/cloudflare.server';
import { type AuthEnv } from '@/lib/auth-helpers';
import { getWorkspace, getWorkspaceAccess } from '@/lib/auth-do';
import type { WorkspaceDO, WorkspaceAccessLevel } from '../../../workers/main/src/workspace';
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
  container: WorkspaceContainer;
}

export interface WorkspaceAccessAuth {
  userId: string;
  orgId: string;
  workspaceId: string;
  access: WorkspaceAccessLevel;
}

/**
 * Require workspace session with optional write access check.
 * Performs auth + access validation only (no container startup).
 */
export async function requireWorkspaceAccess(
  request: Request,
  context: AppLoadContext,
  workspaceId: string,
  options: { requireWrite?: boolean } = {}
): Promise<WorkspaceAccessAuth> {
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

  return {
    userId: sessionContext.session.user_id,
    orgId: sessionContext.session.org_id,
    workspaceId,
    access,
  };
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
  const accessAuth = await requireWorkspaceAccess(request, context, workspaceId, options);
  const env = getEnv(context);

  // Ensure sprite is created and bootstrapped via WorkspaceDO (persistent version tracking)
  const workspaceStub = env.WORKSPACE.get(
    env.WORKSPACE.idFromName(accessAuth.workspaceId)
  ) as unknown as WorkspaceDO;
  await workspaceStub.ensureSpriteReady(accessAuth.workspaceId, accessAuth.orgId);

  // Get workspace container and init env vars
  const containerEnv = env as unknown as WorkspaceContainerEnv;
  const container = getWorkspaceContainer(containerEnv, accessAuth.workspaceId);
  await container.startForWorkspace(accessAuth.workspaceId, accessAuth.orgId);

  return {
    ...accessAuth,
    container,
  };
}

/** Workspace root directory inside sprite runtime */
const WORKSPACE_ROOT = '/home/sprite';

const NORMALIZABLE_WHITESPACE = /[ \u00A0\u2007\u202F]/;

/**
 * Replace non-breaking spaces (U+00A0) and other Unicode whitespace with
 * regular ASCII spaces. macOS uses non-breaking spaces in screenshot filenames
 * (e.g. "Screenshot 2026-01-23 at 12.39.52\u00a0PM.png") which causes
 * mismatches when tools report these paths with regular spaces.
 */
export function normalizeWhitespace(input: string): string {
  return input.replace(/[\u00A0\u2007\u202F]/g, ' ');
}

export function hasNormalizableWhitespace(input: string): boolean {
  return NORMALIZABLE_WHITESPACE.test(input);
}

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
 * Workspace path '/' maps to '/home/sprite', '/foo' maps to '/home/sprite/foo'.
 */
export function toContainerPath(workspacePath: string): string {
  const normalized = normalizeWorkspacePath(workspacePath);
  if (normalized === '/') return WORKSPACE_ROOT;
  return `${WORKSPACE_ROOT}${normalized}`;
}

function splitWorkspacePath(workspacePath: string): { dir: string; base: string } {
  const normalized = normalizeWorkspacePath(workspacePath);
  if (normalized === '/') return { dir: '/', base: '' };
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash <= 0) return { dir: '/', base: normalized.slice(1) };
  return {
    dir: normalized.slice(0, lastSlash),
    base: normalized.slice(lastSlash + 1),
  };
}

function joinContainerPath(dir: string, base: string): string {
  if (!base) return dir;
  if (dir.endsWith('/')) return `${dir}${base}`;
  return `${dir}/${base}`;
}

/**
 * Resolve an existing workspace path to the actual container path, matching
 * entries whose names normalize to the same whitespace (e.g. NBSP vs space).
 * Returns null if no match is found or the path has no normalizable whitespace.
 */
export async function resolveContainerPath(
  container: WorkspaceContainer,
  workspacePath: string
): Promise<string | null> {
  const normalizedPath = normalizeWorkspacePath(workspacePath);
  if (normalizedPath === '/') return toContainerPath('/');
  if (!hasNormalizableWhitespace(normalizedPath)) return null;

  const segments = normalizedPath.slice(1).split('/');
  let currentPath = toContainerPath('/');

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const normalizedSegment = normalizeWhitespace(segment);

    let listing: Awaited<ReturnType<WorkspaceContainer['listFiles']>>;
    try {
      listing = await container.listFiles(currentPath, {
        recursive: false,
        includeHidden: true,
      });
    } catch {
      return null;
    }
    const entries = listing.files ?? [];

    let match = entries.find((entry) => entry.name === segment);
    if (!match) {
      const matches = entries.filter(
        (entry) => normalizeWhitespace(entry.name) === normalizedSegment
      );
      if (matches.length !== 1) {
        return null;
      }
      match = matches[0];
    }

    if (i < segments.length - 1 && match.type !== 'directory') {
      return null;
    }

    currentPath = match.absolutePath || joinContainerPath(currentPath, match.name);
  }

  return currentPath;
}

/**
 * Resolve a workspace path for write-like operations. If an existing entry
 * matches via whitespace normalization, that path is used. Otherwise, attempt
 * to resolve the parent directory and join the original basename.
 */
export async function resolveContainerPathForWrite(
  container: WorkspaceContainer,
  workspacePath: string,
  options: { allowExisting?: boolean } = {}
): Promise<string> {
  const normalizedPath = normalizeWorkspacePath(workspacePath);
  const containerPath = toContainerPath(normalizedPath);
  if (!hasNormalizableWhitespace(normalizedPath)) return containerPath;

  const allowExisting = options.allowExisting ?? true;
  if (allowExisting) {
    const resolvedFull = await resolveContainerPath(container, normalizedPath);
    if (resolvedFull) return resolvedFull;
  }

  const { dir, base } = splitWorkspacePath(normalizedPath);
  const resolvedParent = await resolveContainerPath(container, dir);
  if (resolvedParent) {
    return joinContainerPath(resolvedParent, base);
  }

  return containerPath;
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
