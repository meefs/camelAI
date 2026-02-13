/**
 * OverlayFS mount manager for tiered workspace storage.
 *
 * Each workspace gets an overlay mount:
 *   lower  = /mnt/juicefs/{name}    (JuiceFS, durable canonical data)
 *   upper  = /mnt/nvme/{name}       (NVMe RAID0, fast ephemeral writes)
 *   work   = /mnt/nvme/.work/{name} (overlayfs workdir)
 *   merged = /mnt/workspaces/{name} (what containers see)
 *
 * New/modified files land on NVMe (fast), unchanged files read from JuiceFS.
 * Background sync flushes merged → JuiceFS via jfs:// protocol (bypasses FUSE).
 * NVMe is only cleared on teardown AFTER the final sync completes, so
 * reconnecting during a sync always sees complete data from NVMe.
 *
 * Sync uses `juicefs sync` with the `jfs://` protocol to write directly to
 * the JuiceFS backend (bypassing FUSE). The volume name is resolved via an
 * env var: JFS_VOLUME_NAME=<meta-url> → jfs://JFS_VOLUME_NAME/path.
 *
 * IMPORTANT: OverlayFS is required for write performance. JuiceFS FUSE direct
 * mounts (even with --writeback) are too slow for bulk file creation (bun install,
 * git clone, etc). Do not replace this with JuiceFS-direct mounts.
 */
import { mkdir } from 'fs/promises';
import { exec, execSync } from 'child_process';

const JFS_ROOT = process.env.JFS_ROOT || '/mnt/juicefs';
const NVME_ROOT = process.env.NVME_ROOT || '/mnt/nvme';
const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT || '/mnt/workspaces';
const SYNC_INTERVAL_MS = parseInt(process.env.OVERLAY_SYNC_INTERVAL_MS || String(60_000), 10);
const SYNC_TIMEOUT_MS = 5 * 60_000; // 5 minutes for large workspaces
const SYNC_THREADS = parseInt(process.env.OVERLAY_SYNC_THREADS || '100', 10);

// JuiceFS volume name for jfs:// protocol sync (env var holds the metadata URL).
// The env var name must match the volume name used in jfs:// URIs.
const JFS_VOLUME_NAME = process.env.JFS_VOLUME_NAME || 'chiridion_workspaces';

// Build jfs:// destination path for a workspace, bypassing FUSE.
function jfsDst(name: string): string {
  return `jfs://${JFS_VOLUME_NAME}/${name}/`;
}

interface OverlayMount {
  name: string;
  lowerDir: string;
  upperDir: string;
  workDir: string;
  mergedDir: string;
  mountedAt: number;
  lastSyncedAt: number;
  /** Promise-based sync lock. Only one sync runs at a time per workspace. */
  syncLock: Promise<void> | null;
}

const mounts = new Map<string, OverlayMount>();

/** Synchronous exec for fast commands (mount, umount, mkdir, chown). */
function run(cmd: string): string {
  return execSync(cmd, { encoding: 'utf-8', timeout: 30_000 }).trim();
}

/** Async exec for long-running commands (juicefs sync). */
function runAsync(cmd: string, timeoutMs = SYNC_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { encoding: 'utf-8', timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`${cmd.split(' ')[0]} failed: ${stderr || err.message}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

function isMounted(path: string): boolean {
  try {
    run(`mountpoint -q "${path}"`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire the sync lock for a workspace. Returns a release function.
 * If a sync is already in progress, waits for it to finish first.
 */
async function acquireSyncLock(mount: OverlayMount): Promise<() => void> {
  // Wait for any in-progress sync to complete
  while (mount.syncLock) {
    await mount.syncLock;
  }

  // Create a new lock with an externally-resolvable promise
  let release!: () => void;
  mount.syncLock = new Promise<void>((resolve) => {
    release = () => {
      mount.syncLock = null;
      resolve();
    };
  });

  return release;
}

/**
 * Ensure overlay mount exists for a workspace.
 * Creates JuiceFS lower dir, NVMe upper/work dirs, and mounts overlayfs.
 */
export async function ensureOverlay(name: string): Promise<string> {
  const existing = mounts.get(name);
  if (existing && isMounted(existing.mergedDir)) {
    return existing.mergedDir;
  }

  const lowerDir = `${JFS_ROOT}/${name}`;
  const upperDir = `${NVME_ROOT}/${name}`;
  const workDir = `${NVME_ROOT}/.work/${name}`;
  const mergedDir = `${WORKSPACES_ROOT}/${name}`;

  // Create all directories
  await Promise.all([
    mkdir(lowerDir, { recursive: true }),
    mkdir(upperDir, { recursive: true }),
    mkdir(workDir, { recursive: true }),
    mkdir(mergedDir, { recursive: true }),
  ]);

  // Set ownership on lower and upper dirs
  try {
    run(`chown 1001:1001 "${lowerDir}" "${upperDir}"`);
  } catch {
    // May not have permissions in dev
  }

  // Mount overlayfs if not already mounted
  if (!isMounted(mergedDir)) {
    run(
      `mount -t overlay overlay ` +
      `-o lowerdir="${lowerDir}",upperdir="${upperDir}",workdir="${workDir}" ` +
      `"${mergedDir}"`
    );
    console.log(`[Overlay] mounted ${name}: lower=${lowerDir} upper=${upperDir} merged=${mergedDir}`);
  }

  const now = Date.now();
  mounts.set(name, {
    name,
    lowerDir,
    upperDir,
    workDir,
    mergedDir,
    mountedAt: now,
    lastSyncedAt: now,
    syncLock: null,
  });

  return mergedDir;
}

/**
 * Sync workspace data from merged overlay to JuiceFS (non-disruptive).
 *
 * Acquires the per-workspace sync lock so only one sync runs at a time.
 * Uses `juicefs sync` with jfs:// protocol to write directly to the JuiceFS
 * backend (bypassing FUSE). Reads from the merged overlayfs view so deletions
 * are handled correctly (--delete-dst removes files from JuiceFS that were
 * deleted in the overlay).
 *
 * Does NOT clear NVMe — the overlay stays intact so the sandbox keeps
 * its full view of files even during/after sync.
 */
export async function syncOverlay(name: string): Promise<void> {
  const mount = mounts.get(name);
  if (!mount) return;

  // If a sync is already running, skip (background sync will retry next interval)
  if (mount.syncLock) {
    console.log(`[Overlay] ${name}: sync already in progress, skipping`);
    return;
  }

  const release = await acquireSyncLock(mount);


  try {
    const start = Date.now();
    await runAsync(
      `juicefs sync --perms --delete-dst --dirs --threads ${SYNC_THREADS} "${mount.mergedDir}/" ${jfsDst(name)}`
    );
    mount.lastSyncedAt = Date.now();
    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`[Overlay] ${name}: synced to JuiceFS (${elapsed}s)`);
  } catch (err) {
    console.error(`[Overlay] sync failed for ${name}:`, err);
  } finally {
    release();
  }
}

/**
 * Full flush on teardown: wait for any in-progress sync, run final sync,
 * unmount overlay, then clear NVMe.
 *
 * Called when the sandbox is reaped (idle timeout) or explicitly terminated.
 * NVMe is only cleared AFTER the final sync completes successfully, so
 * reconnecting during a sync always sees complete data from the NVMe layer.
 */
export async function removeOverlay(name: string): Promise<void> {
  const mount = mounts.get(name);
  if (!mount) return;

  const start = Date.now();

  // Acquire the sync lock — waits for any in-progress background sync to finish
  const release = await acquireSyncLock(mount);


  try {
    // Final sync: merged → JuiceFS (via jfs:// protocol, bypasses FUSE)
    try {
      await runAsync(
        `juicefs sync --perms --delete-dst --dirs --threads ${SYNC_THREADS} "${mount.mergedDir}/" ${jfsDst(name)}`
      );
      console.log(`[Overlay] ${name}: final sync completed`);
    } catch (err) {
      console.error(`[Overlay] ${name}: final sync failed:`, err);
    }

    // Unmount overlay
    if (isMounted(mount.mergedDir)) {
      try {
        run(`umount "${mount.mergedDir}"`);
      } catch {
        try { run(`umount -l "${mount.mergedDir}"`); } catch { /* best effort */ }
      }
    }

    // Catch any stragglers written between sync and umount
    try {
      await runAsync(
        `juicefs sync --perms --dirs --threads ${SYNC_THREADS} "${mount.upperDir}/" ${jfsDst(name)}`
      );
    } catch {
      // Best effort — upper may already be empty
    }

    // Clear NVMe upper + work dirs (data is on JuiceFS now)
    try {
      run(`rm -rf "${mount.upperDir}" "${mount.workDir}"`);
    } catch {
      // Best effort
    }
  } finally {
    release();
  }

  mounts.delete(name);
  const elapsed = Math.round((Date.now() - start) / 1000);
  console.log(`[Overlay] ${name}: removed (flushed + cleared NVMe in ${elapsed}s)`);
}

/**
 * Check if an overlay is mounted for a workspace.
 */
export function hasOverlay(name: string): boolean {
  const mount = mounts.get(name);
  return !!mount && isMounted(mount.mergedDir);
}

// ─── Background Sync ──────────────────────────────────────────

async function syncAllOverlays(): Promise<void> {
  const now = Date.now();
  for (const [name, mount] of mounts) {
    if (!isMounted(mount.mergedDir)) {
      mounts.delete(name);
      continue;
    }
    const sinceLast = now - mount.lastSyncedAt;
    if (sinceLast >= SYNC_INTERVAL_MS) {
      await syncOverlay(name);
    }
  }
}

setInterval(() => {
  syncAllOverlays().catch((err) =>
    console.error('[Overlay] background sync error:', err)
  );
}, SYNC_INTERVAL_MS);

console.log(`[Overlay] background sync started (interval=${SYNC_INTERVAL_MS / 1000}s)`);
