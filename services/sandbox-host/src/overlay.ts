/**
 * OverlayFS mount manager for tiered workspace storage.
 *
 * Each workspace gets an overlay mount:
 *   lower  = /mnt/nfs/{name}     (Azure Blob NFS v3, durable canonical data)
 *   upper  = /mnt/nvme/{name}    (NVMe RAID0, fast ephemeral writes)
 *   work   = /mnt/nvme/.work/{name}  (overlayfs workdir)
 *   merged = /mnt/workspaces/{name}  (what containers see)
 *
 * New/modified files land on NVMe (fast), unchanged files read from NFS
 * (kernel-native, no FUSE). Background sync copies upper → NFS for durability.
 */
import { mkdir } from 'fs/promises';
import { execSync } from 'child_process';

const NFS_ROOT = process.env.NFS_ROOT || '/mnt/nfs';
const NVME_ROOT = process.env.NVME_ROOT || '/mnt/nvme';
const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT || '/mnt/workspaces';
const SYNC_INTERVAL_MS = parseInt(process.env.OVERLAY_SYNC_INTERVAL_MS || String(60_000), 10);

interface OverlayMount {
  name: string;
  lowerDir: string;
  upperDir: string;
  workDir: string;
  mergedDir: string;
  mountedAt: number;
  lastSyncedAt: number;
}

const mounts = new Map<string, OverlayMount>();

function run(cmd: string): string {
  return execSync(cmd, { encoding: 'utf-8', timeout: 30_000 }).trim();
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
 * Creates NFS lower dir, NVMe upper/work dirs, and mounts overlayfs.
 */
export async function ensureOverlay(name: string): Promise<string> {
  const existing = mounts.get(name);
  if (existing && isMounted(existing.mergedDir)) {
    return existing.mergedDir;
  }

  const lowerDir = `${NFS_ROOT}/${name}`;
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
  });

  return mergedDir;
}

/**
 * Sync a workspace's upper layer (NVMe) to the lower layer (NFS).
 * Uses rsync from the merged view to NFS for correct handling of deletions.
 */
export async function syncOverlay(name: string): Promise<void> {
  const mount = mounts.get(name);
  if (!mount) return;

  try {
    run(`rsync -a --delete --whole-file "${mount.mergedDir}/" "${mount.lowerDir}/"`);
    mount.lastSyncedAt = Date.now();
  } catch (err) {
    console.error(`[Overlay] sync failed for ${name}:`, err);
  }
}

/**
 * Unmount overlay, sync to NFS, clean up NVMe upper layer.
 */
export async function removeOverlay(name: string): Promise<void> {
  const mount = mounts.get(name);
  if (!mount) return;

  // Final sync before teardown
  await syncOverlay(name);

  // Unmount
  if (isMounted(mount.mergedDir)) {
    try {
      run(`umount "${mount.mergedDir}"`);
      console.log(`[Overlay] unmounted ${name}`);
    } catch (err) {
      console.error(`[Overlay] unmount failed for ${name}:`, err);
      // Force unmount
      try { run(`umount -l "${mount.mergedDir}"`); } catch { /* best effort */ }
    }
  }

  // Clean up NVMe upper+work dirs (data is on NFS now)
  try {
    run(`rm -rf "${mount.upperDir}" "${mount.workDir}"`);
  } catch {
    // Best effort
  }

  mounts.delete(name);
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
