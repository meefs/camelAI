/**
 * Host filesystem operations.
 *
 * All operations use Node fs on /mnt/workspaces/{name}/...
 * Path resolution ensures traversal stays under the workspace root.
 */
import { writeFile, readdir, stat, rm, rename, mkdir } from 'fs/promises';
import { resolve, relative, dirname } from 'path';
import type { FsEntry, FsExistsResult } from './types';

const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT || '/mnt/workspaces';

/**
 * Resolve a sandbox-relative path to an absolute host path.
 * Rejects traversal outside the workspace root.
 */
function resolveHostPath(name: string, sandboxPath: string): string {
  const wsRoot = resolve(WORKSPACES_ROOT, name);
  // Strip /home/claude prefix if present (container paths map to workspace root)
  let cleaned = sandboxPath;
  if (cleaned.startsWith('/home/claude/')) {
    cleaned = cleaned.slice('/home/claude'.length);
  } else if (cleaned === '/home/claude') {
    cleaned = '/';
  }
  // Resolve relative to workspace root
  const resolved = resolve(wsRoot, cleaned.startsWith('/') ? cleaned.slice(1) : cleaned);
  // Security: ensure resolved path stays under workspace root
  const rel = relative(wsRoot, resolved);
  if (rel.startsWith('..') || resolve(wsRoot, rel) !== resolved) {
    throw new Error(`Path traversal detected: ${sandboxPath}`);
  }
  return resolved;
}

/**
 * Resolve a file path and return its host path + size for streaming.
 * Throws ENOENT if the file doesn't exist.
 */
export async function fsReadInfo(name: string, path: string): Promise<{ hostPath: string; size: number }> {
  const hostPath = resolveHostPath(name, path);
  const s = await stat(hostPath);
  return { hostPath, size: s.size };
}

export async function fsWrite(name: string, path: string, data: Uint8Array): Promise<void> {
  const hostPath = resolveHostPath(name, path);
  // Ensure parent directory exists
  await mkdir(dirname(hostPath), { recursive: true });
  await writeFile(hostPath, data);
  // Set ownership to claude user (uid 1001)
  try {
    const { chown } = await import('fs/promises');
    await chown(hostPath, 1001, 1001);
  } catch {
    // May not have permissions in dev
  }
}

export async function fsList(name: string, path: string): Promise<FsEntry[]> {
  const hostPath = resolveHostPath(name, path);
  const entries = await readdir(hostPath, { withFileTypes: true });
  const results: FsEntry[] = [];

  for (const entry of entries) {
    try {
      const fullPath = resolve(hostPath, entry.name);
      const s = await stat(fullPath);
      results.push({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
        size: s.size,
        modifiedAt: s.mtime.toISOString(),
      });
    } catch {
      // Skip entries we can't stat
    }
  }

  return results;
}

export async function fsDelete(name: string, path: string, recursive: boolean): Promise<void> {
  const hostPath = resolveHostPath(name, path);
  await rm(hostPath, { recursive, force: true });
}

export async function fsMove(name: string, source: string, dest: string): Promise<void> {
  const sourcePath = resolveHostPath(name, source);
  const destPath = resolveHostPath(name, dest);
  // Ensure parent directory of dest exists
  await mkdir(dirname(destPath), { recursive: true });
  await rename(sourcePath, destPath);
}

export async function fsMkdir(name: string, path: string): Promise<void> {
  const hostPath = resolveHostPath(name, path);
  await mkdir(hostPath, { recursive: true });
  // Set ownership to claude user (uid 1001)
  try {
    const { chown } = await import('fs/promises');
    await chown(hostPath, 1001, 1001);
  } catch {
    // May not have permissions in dev
  }
}

export async function fsExists(name: string, path: string): Promise<FsExistsResult> {
  const hostPath = resolveHostPath(name, path);
  try {
    const s = await stat(hostPath);
    return {
      exists: true,
      isFile: s.isFile(),
      isDirectory: s.isDirectory(),
      size: s.size,
      modifiedAt: s.mtime.toISOString(),
    };
  } catch {
    return { exists: false };
  }
}
