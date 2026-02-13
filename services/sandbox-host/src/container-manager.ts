/**
 * Docker container lifecycle manager.
 *
 * Uses Docker CLI via Bun.spawn — no dockerode dependency.
 * Containers run with gVisor (--runtime=runsc) and mount host
 * directories from /mnt/workspaces/{name} → /home/claude inside.
 *
 * Idle reaper terminates containers with no active WebSocket connections
 * and no recent HTTP requests after IDLE_TIMEOUT_MS.
 */
import type { ContainerRecord, ExecResult } from './types';
import { ensureOverlay, removeOverlay } from './overlay';

const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT || '/mnt/workspaces';
const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || 'chiridion-sandbox:latest';
const CONTAINER_MEMORY = process.env.CONTAINER_MEMORY || '16g';
const CONTAINER_CPU_SHARES = process.env.CONTAINER_CPU_SHARES || '2048';
const CONTAINER_RUNTIME = process.env.CONTAINER_RUNTIME || 'runsc';
const CONTROL_PLANE_PORT = 8080;
const IDLE_TIMEOUT_MS = parseInt(process.env.IDLE_TIMEOUT_MS || String(30 * 1000), 10);
const REAPER_INTERVAL_MS = 10_000;
const R2_MOUNT_ROOT = process.env.R2_MOUNT_ROOT || '/mnt/r2';

export interface EnsureContainerOptions {
  orgId?: string;
  workspaceId?: string;
}

const containers = new Map<string, ContainerRecord>();

async function dockerExec(args: string[], timeoutMs = 30_000): Promise<ExecResult> {
  const proc = Bun.spawn(['docker', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(timer);

  return { success: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

function workspacePath(name: string): string {
  return `${WORKSPACES_ROOT}/${name}`;
}

/**
 * Get the host port mapped to a container's control plane port.
 */
async function getHostPort(name: string): Promise<number | null> {
  const result = await dockerExec(['port', name, String(CONTROL_PLANE_PORT)]);
  if (!result.success) return null;
  // Output: "0.0.0.0:32768" or "[::]:32768"
  const match = result.stdout.match(/:(\d+)$/m);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Check if a container is running.
 */
async function isRunning(name: string): Promise<boolean> {
  const result = await dockerExec([
    'inspect', '--format', '{{.State.Running}}', name,
  ]);
  return result.success && result.stdout === 'true';
}

/**
 * Wait for the control plane health endpoint to respond.
 */
async function waitForHealth(port: number, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return true;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * Touch a container's lastAccessedAt timestamp.
 */
export function touchContainer(name: string): void {
  const record = containers.get(name);
  if (record) {
    record.lastAccessedAt = Date.now();
  }
}

/**
 * Increment active WebSocket count for a container.
 */
export function addWebSocket(name: string): void {
  const record = containers.get(name);
  if (record) {
    record.activeWebSockets++;
    record.lastAccessedAt = Date.now();
  }
}

/**
 * Decrement active WebSocket count for a container.
 */
export function removeWebSocket(name: string): void {
  const record = containers.get(name);
  if (record) {
    record.activeWebSockets = Math.max(0, record.activeWebSockets - 1);
    record.lastAccessedAt = Date.now();
  }
}

/**
 * Compute the R2 bind mount prefix for a workspace.
 * Same logic as workspace-container.ts buildEnvVars.
 */
function r2MountPrefix(orgId: string, workspaceId: string): string {
  return orgId === workspaceId ? orgId : `${orgId}/${workspaceId}`;
}

/**
 * Create or reconnect to a container (idempotent).
 * When orgId + workspaceId are provided, R2 bind mounts are added
 * at container creation time (host-level rclone mount at R2_MOUNT_ROOT).
 */
export async function ensureContainer(name: string, opts?: EnsureContainerOptions): Promise<ContainerRecord> {
  // Check cache first
  const cached = containers.get(name);
  if (cached) {
    cached.lastAccessedAt = Date.now();
    if (await isRunning(name)) {
      return cached;
    }
    // Container stopped — remove from cache and recreate
    containers.delete(name);
  }

  // Check if container already exists and is running
  if (await isRunning(name)) {
    const port = await getHostPort(name);
    if (port) {
      const record: ContainerRecord = {
        name,
        containerId: name,
        hostPort: port,
        status: 'running',
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
        activeWebSockets: 0,
        orgId: opts?.orgId,
        workspaceId: opts?.workspaceId,
      };
      containers.set(name, record);
      console.log(`[ContainerManager] reconnected to existing container ${name} (port=${port})`);
      return record;
    }
  }

  // Remove any stopped container with the same name
  await dockerExec(['rm', '-f', name]).catch(() => {});

  // Set up overlayfs mount: NFS (lower) + NVMe (upper) → merged workspace dir
  await ensureOverlay(name);
  const wsPath = workspacePath(name);

  console.log(`[ContainerManager] creating container ${name}`);

  const runArgs = [
    'run', '-d',
    `--name=${name}`,
    `--runtime=${CONTAINER_RUNTIME}`,
    `-v`, `${wsPath}:/home/claude`,
    '--network=bridge',
    `--memory=${CONTAINER_MEMORY}`,
    `--cpu-shares=${CONTAINER_CPU_SHARES}`,
    '-p', `0:${CONTROL_PLANE_PORT}`,
    '-e', 'HOME=/home/claude',
    '-e', 'USER=claude',
  ];

  // Add R2 bind mounts if orgId + workspaceId are available and host mount exists
  if (opts?.orgId && opts?.workspaceId) {
    const prefix = r2MountPrefix(opts.orgId, opts.workspaceId);
    const uploadsHost = `${R2_MOUNT_ROOT}/${prefix}/user-uploads`;
    const outputsHost = `${R2_MOUNT_ROOT}/${prefix}/user-outputs`;

    // Ensure host directories exist (mkdir -p is safe even if R2 mount populates them)
    const { mkdirSync } = await import('fs');
    try { mkdirSync(uploadsHost, { recursive: true }); } catch {}
    try { mkdirSync(outputsHost, { recursive: true }); } catch {}

    runArgs.push('-v', `${uploadsHost}:/mnt/user-uploads:ro`);
    runArgs.push('-v', `${outputsHost}:/mnt/user-outputs`);
    console.log(`[ContainerManager] R2 bind mounts: ${prefix}`);
  }

  runArgs.push(
    SANDBOX_IMAGE,
    'bun', 'run', '/opt/chiridion/control-plane.mjs',
  );

  const result = await dockerExec(runArgs, 60_000);
  if (!result.success) {
    throw new Error(`Failed to create container ${name}: ${result.stderr}`);
  }

  const containerId = result.stdout.slice(0, 12);
  const port = await getHostPort(name);
  if (!port) {
    throw new Error(`Container ${name} created but no port mapping found`);
  }

  // Wait for control plane to be healthy
  const healthy = await waitForHealth(port);
  if (!healthy) {
    console.warn(`[ContainerManager] container ${name} health check timed out, proceeding anyway`);
  }

  const record: ContainerRecord = {
    name,
    containerId,
    hostPort: port,
    status: 'running',
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    activeWebSockets: 0,
    orgId: opts?.orgId,
    workspaceId: opts?.workspaceId,
  };
  containers.set(name, record);
  console.log(`[ContainerManager] created container ${name} (id=${containerId}, port=${port})`);
  return record;
}

/**
 * Get container info.
 */
export async function getContainer(name: string): Promise<ContainerRecord | null> {
  const cached = containers.get(name);
  if (cached) {
    cached.lastAccessedAt = Date.now();
    if (await isRunning(name)) {
      return cached;
    }
    containers.delete(name);
  }

  // Check if container exists
  if (await isRunning(name)) {
    const port = await getHostPort(name);
    if (port) {
      const record: ContainerRecord = {
        name,
        containerId: name,
        hostPort: port,
        status: 'running',
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
        activeWebSockets: 0,
      };
      containers.set(name, record);
      return record;
    }
  }

  return null;
}

/**
 * Terminate and remove a container.
 */
export async function terminateContainer(name: string): Promise<boolean> {
  const result = await dockerExec(['rm', '-f', name]);
  containers.delete(name);
  if (result.success) {
    console.log(`[ContainerManager] terminated container ${name}`);
  }
  // Sync upper → NFS, unmount overlay, clean up NVMe
  await removeOverlay(name);
  return result.success;
}

/**
 * Execute a command inside a container via docker exec.
 */
export async function execInContainer(
  name: string,
  cmd: string[],
  options?: { cwd?: string; env?: Record<string, string> }
): Promise<ExecResult> {
  const args: string[] = ['exec'];

  if (options?.cwd) {
    args.push('-w', options.cwd);
  }

  if (options?.env) {
    for (const [key, value] of Object.entries(options.env)) {
      args.push('-e', `${key}=${value}`);
    }
  }

  args.push(name, ...cmd);
  return dockerExec(args, 120_000);
}

/**
 * Get the host port for a container's control plane.
 * Ensures container exists first.
 */
export async function getControlPlanePort(name: string): Promise<number> {
  const record = containers.get(name);
  if (record) {
    record.lastAccessedAt = Date.now();
    return record.hostPort;
  }

  // Try to reconnect
  const container = await getContainer(name);
  if (!container) {
    throw new Error(`Container ${name} not found`);
  }
  return container.hostPort;
}

/**
 * List all tracked containers.
 */
export function listContainers(): ContainerRecord[] {
  return Array.from(containers.values());
}

// ─── Idle Reaper ──────────────────────────────────────────────

async function reapIdleContainers(): Promise<void> {
  const now = Date.now();
  for (const [name, record] of containers) {
    if (record.activeWebSockets > 0) continue;
    const idleMs = now - record.lastAccessedAt;
    if (idleMs >= IDLE_TIMEOUT_MS) {
      console.log(
        `[ContainerManager] reaping idle container ${name} (idle=${Math.round(idleMs / 1000)}s)`
      );
      await terminateContainer(name);
    }
  }
}

setInterval(() => {
  reapIdleContainers().catch((err) =>
    console.error('[ContainerManager] reaper error:', err)
  );
}, REAPER_INTERVAL_MS);

console.log(
  `[ContainerManager] idle reaper started (timeout=${IDLE_TIMEOUT_MS / 1000}s, interval=${REAPER_INTERVAL_MS / 1000}s)`
);
