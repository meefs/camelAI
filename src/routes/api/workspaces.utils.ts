import type { AppLoadContext } from 'react-router';
import { getSession } from '@/lib/auth.server';
import { getEnv, type CloudflareEnv } from '@/lib/cloudflare.server';
import { type AuthEnv } from '@/lib/auth-helpers';
import { getWorkspace, getWorkspaceAccess } from '@/lib/auth-do';
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
 * Workspace path '/' maps to '/home/claude', '/foo' maps to '/home/claude/foo'.
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
  container: DurableObjectStub<WorkspaceContainer>,
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
  container: DurableObjectStub<WorkspaceContainer>,
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
