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
 * Background sync flushes upper → JuiceFS and clears the NVMe layer,
 * so NVMe acts as a write buffer rather than accumulating data.
 */
import { mkdir } from 'fs/promises';
import { exec, execSync } from 'child_process';

const JFS_ROOT = process.env.JFS_ROOT || '/mnt/juicefs';
const NVME_ROOT = process.env.NVME_ROOT || '/mnt/nvme';
const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT || '/mnt/workspaces';
const SYNC_INTERVAL_MS = parseInt(process.env.OVERLAY_SYNC_INTERVAL_MS || String(60_000), 10);
const RSYNC_TIMEOUT_MS = 5 * 60_000; // 5 minutes for large workspaces

interface OverlayMount {
  name: string;
  lowerDir: string;
  upperDir: string;
  workDir: string;
  mergedDir: string;
  mountedAt: number;
  lastSyncedAt: number;
  syncing: boolean;
}

const mounts = new Map<string, OverlayMount>();

/** Synchronous exec for fast commands (mount, umount, mkdir, chown). */
function run(cmd: string): string {
  return execSync(cmd, { encoding: 'utf-8', timeout: 30_000 }).trim();
}

/** Async exec for long-running commands (rsync). */
function runAsync(cmd: string, timeoutMs = RSYNC_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = exec(cmd, { encoding: 'utf-8', timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
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
    syncing: false,
  });

  return mergedDir;
}

/**
 * Sync workspace data from NVMe to JuiceFS (non-disruptive).
 *
 * Just copies data — no unmount, no NVMe clear. The overlay stays up
 * and the container keeps running without interruption. NVMe upper layer
 * accumulates until the sandbox is reaped (removeOverlay flushes + clears).
 */
export async function syncOverlay(name: string): Promise<void> {
  const mount = mounts.get(name);
  if (!mount) return;

  if (mount.syncing) {
    console.log(`[Overlay] ${name}: sync already in progress, skipping`);
    return;
  }
  mount.syncing = true;

  try {
    const start = Date.now();
    await runAsync(`juicefs sync --delete-dst "${mount.mergedDir}/" "${mount.lowerDir}/"`);
    mount.lastSyncedAt = Date.now();
    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`[Overlay] ${name}: synced to JuiceFS (${elapsed}s)`);
  } catch (err) {
    console.error(`[Overlay] sync failed for ${name}:`, err);
  } finally {
    mount.syncing = false;
  }
}

/**
 * Full flush on teardown: sync to JuiceFS, unmount overlay, clear NVMe.
 * Called when the sandbox is reaped (idle timeout) or explicitly terminated.
 */
export async function removeOverlay(name: string): Promise<void> {
  const mount = mounts.get(name);
  if (!mount) return;

  const start = Date.now();

  // Final sync: merged → JuiceFS
  try {
    await runAsync(`juicefs sync --delete-dst "${mount.mergedDir}/" "${mount.lowerDir}/"`);
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
    await runAsync(`juicefs sync "${mount.upperDir}/" "${mount.lowerDir}/"`);
  } catch {
    // Best effort — upper may already be empty
  }

  // Clear NVMe upper + work dirs (data is on JuiceFS now)
  try {
    run(`rm -rf "${mount.upperDir}" "${mount.workDir}"`);
  } catch {
    // Best effort
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
