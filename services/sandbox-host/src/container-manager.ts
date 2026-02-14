/**
 * Docker container lifecycle manager.
 *
 * Uses Docker CLI via Bun.spawn — no dockerode dependency.
 * Containers run with gVisor (--runtime=runsc) and mount host
 * directories from /mnt/workspaces/{name} → /home/claude inside.
 *
 * Idle reaper terminates containers with no active WebSocket connections
 * and no recent HTTP requests after IDLE_TIMEOUT_MS.
 *
 * NVMe reclaim runs every 5 minutes. For workspaces idle >10 minutes
 * with no running/pending container, it calls reclaimOverlay which does:
 * final sync → safety double-check → unmount → atomic rename → rm -rf.
 * The pendingWorkspaces Set prevents races with concurrent ensureContainer.
 */
import type { ContainerRecord, ExecResult } from './types';
import { ensureOverlay, syncOverlay, hasOverlay, reclaimOverlay } from './overlay';

const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT || '/mnt/workspaces';
const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || 'chiridion-sandbox:latest';
const CONTAINER_MEMORY = process.env.CONTAINER_MEMORY || '16g';
const CONTAINER_CPU_SHARES = process.env.CONTAINER_CPU_SHARES || '2048';
const CONTAINER_RUNTIME = process.env.CONTAINER_RUNTIME || 'runsc';
const PORT = parseInt(process.env.PORT || '80', 10);
const CONTROL_PLANE_PORT = 8080;
const IDLE_TIMEOUT_MS = parseInt(process.env.IDLE_TIMEOUT_MS || String(30 * 1000), 10);
const CF_DISPATCH_NAMESPACE = process.env.CF_DISPATCH_NAMESPACE || '';
const REAPER_INTERVAL_MS = 10_000;
const R2_MOUNT_ROOT = process.env.R2_MOUNT_ROOT || '/mnt/r2';
const RECLAIM_IDLE_MS = parseInt(process.env.RECLAIM_IDLE_MS || String(10 * 60_000), 10);
const RECLAIM_INTERVAL_MS = 5 * 60_000;
const TRACE_SANDBOX_LIFECYCLE = process.env.TRACE_SANDBOX_LIFECYCLE !== '0';

export interface EnsureContainerOptions {
  orgId?: string;
  workspaceId?: string;
}

const containers = new Map<string, ContainerRecord>();
const containerIpIndex = new Map<string, string>();

function traceLifecycle(event: string, details: Record<string, unknown>): void {
  if (!TRACE_SANDBOX_LIFECYCLE) return;
  try {
    console.log(`[ContainerManager][trace] ${event} ${JSON.stringify(details)}`);
  } catch {
    console.log(`[ContainerManager][trace] ${event}`);
  }
}

function containerSnapshot(record: ContainerRecord | undefined): Record<string, unknown> | null {
  if (!record) return null;
  return {
    name: record.name,
    status: record.status,
    hostPort: record.hostPort,
    containerIp: record.containerIp || '',
    createdAt: record.createdAt,
    lastAccessedAt: record.lastAccessedAt,
    idleMs: Math.max(0, Date.now() - record.lastAccessedAt),
    activeWebSockets: record.activeWebSockets,
    inFlightProxyRequests: record.inFlightProxyRequests ?? 0,
    orgId: record.orgId || '',
    workspaceId: record.workspaceId || '',
  };
}

function normalizeSourceIp(ip: string): string {
  const trimmed = ip.trim();
  return trimmed.startsWith('::ffff:') ? trimmed.slice(7) : trimmed;
}

function sourceIpKeys(ip: string): string[] {
  const normalized = normalizeSourceIp(ip);
  if (!normalized) return [];
  const keys = new Set<string>([normalized]);
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized)) {
    keys.add(`::ffff:${normalized}`);
  }
  return Array.from(keys);
}

function indexContainerIp(ip: string, name: string): void {
  for (const key of sourceIpKeys(ip)) {
    containerIpIndex.set(key, name);
  }
}

function unindexContainerIp(ip: string): void {
  for (const key of sourceIpKeys(ip)) {
    containerIpIndex.delete(key);
  }
}

/** Refcount of in-flight ensureContainer calls per workspace (prevents reclaim race). */
const pendingWorkspaces = new Map<string, number>();

/** Shared ensureContainer promise per workspace (prevents duplicate docker run races). */
const ensureContainerInFlight = new Map<string, Promise<ContainerRecord>>();

/** When a container was last terminated (for reclaim idle guard). */
const containerTerminatedAt = new Map<string, number>();

/** True if a workspace has a running container or is being provisioned. */
function isWorkspaceActive(name: string): boolean {
  return containers.has(name) || (pendingWorkspaces.get(name) ?? 0) > 0;
}

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

async function getContainerIp(name: string): Promise<string | undefined> {
  const result = await dockerExec([
    'inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', name,
  ]);
  if (!result.success) return undefined;
  const ip = result.stdout.trim();
  return ip || undefined;
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
export function touchContainer(name: string, reason = 'unknown'): void {
  const record = containers.get(name);
  if (record) {
    record.lastAccessedAt = Date.now();
    traceLifecycle('touch_container', {
      reason,
      container: containerSnapshot(record),
    });
  } else {
    traceLifecycle('touch_container_miss', { name, reason });
  }
}

/**
 * Increment active WebSocket count for a container.
 */
export function addWebSocket(name: string, source = 'unknown'): void {
  const record = containers.get(name);
  if (record) {
    record.activeWebSockets++;
    record.lastAccessedAt = Date.now();
    traceLifecycle('ws_open', {
      source,
      container: containerSnapshot(record),
    });
  } else {
    traceLifecycle('ws_open_missing_container', { name, source });
  }
}

/**
 * Decrement active WebSocket count for a container.
 */
export function removeWebSocket(
  name: string,
  source = 'unknown',
  closeCode?: number,
  closeReason?: string,
): void {
  const record = containers.get(name);
  if (record) {
    record.activeWebSockets = Math.max(0, record.activeWebSockets - 1);
    record.lastAccessedAt = Date.now();
    traceLifecycle('ws_close', {
      source,
      closeCode: typeof closeCode === 'number' ? closeCode : null,
      closeReason: closeReason || '',
      container: containerSnapshot(record),
    });
  } else {
    traceLifecycle('ws_close_missing_container', {
      name,
      source,
      closeCode: typeof closeCode === 'number' ? closeCode : null,
      closeReason: closeReason || '',
    });
  }
}

export function addProxyRequest(name: string, reason = 'unknown'): void {
  const record = containers.get(name);
  if (!record) {
    traceLifecycle('proxy_request_open_missing_container', { name, reason });
    return;
  }
  record.inFlightProxyRequests = (record.inFlightProxyRequests ?? 0) + 1;
  record.lastAccessedAt = Date.now();
  traceLifecycle('proxy_request_open', {
    reason,
    container: containerSnapshot(record),
  });
}

export function removeProxyRequest(
  name: string,
  reason = 'unknown',
  status?: number,
  durationMs?: number,
): void {
  const record = containers.get(name);
  if (!record) {
    traceLifecycle('proxy_request_close_missing_container', {
      name,
      reason,
      status: typeof status === 'number' ? status : null,
      durationMs: typeof durationMs === 'number' ? durationMs : null,
    });
    return;
  }
  const next = Math.max(0, (record.inFlightProxyRequests ?? 0) - 1);
  record.inFlightProxyRequests = next;
  record.lastAccessedAt = Date.now();
  traceLifecycle('proxy_request_close', {
    reason,
    status: typeof status === 'number' ? status : null,
    durationMs: typeof durationMs === 'number' ? durationMs : null,
    container: containerSnapshot(record),
  });
}

export async function resolveContainerBySourceIp(sourceIp: string): Promise<ContainerRecord | null> {
  for (const key of sourceIpKeys(sourceIp)) {
    const cached = getContainerBySourceIpCached(key);
    if (cached) return cached;
  }

  // Refresh from Docker in case IP cache is stale.
  for (const [name, record] of containers) {
    const latestIp = await getContainerIp(name);
    if (!latestIp) continue;
    if (record.containerIp && record.containerIp !== latestIp) {
      unindexContainerIp(record.containerIp);
    }
    record.containerIp = latestIp;
    indexContainerIp(latestIp, name);
    const latestKeys = new Set(sourceIpKeys(latestIp));
    if (sourceIpKeys(sourceIp).some((key) => latestKeys.has(key))) {
      return record;
    }
  }

  return null;
}

function getContainerBySourceIpCached(sourceIp: string): ContainerRecord | null {
  const indexedName = containerIpIndex.get(sourceIp);
  if (indexedName) {
    const indexedRecord = containers.get(indexedName);
    if (indexedRecord) return indexedRecord;
    containerIpIndex.delete(sourceIp);
  }

  for (const [name, record] of containers) {
    if (record.containerIp && sourceIpKeys(record.containerIp).includes(sourceIp)) {
      containerIpIndex.set(sourceIp, name);
      return record;
    }
  }
  return null;
}

/**
 * Compute the R2 bind mount prefix for a workspace.
 * Same logic as workspace-container.ts buildEnvVars.
 */
function r2MountPrefix(orgId: string, workspaceId: string): string {
  return `${orgId}/${workspaceId}`;
}

/**
 * Create or reconnect to a container (idempotent).
 * When orgId + workspaceId are provided, R2 bind mounts are added
 * at container creation time (host-level rclone mount at R2_MOUNT_ROOT).
 */
export async function ensureContainer(name: string, opts?: EnsureContainerOptions): Promise<ContainerRecord> {
  traceLifecycle('ensure_container_request', {
    name,
    opts: {
      orgId: opts?.orgId || '',
      workspaceId: opts?.workspaceId || '',
    },
    hasInFlight: ensureContainerInFlight.has(name),
    isTracked: containers.has(name),
  });
  const inFlight = ensureContainerInFlight.get(name);
  if (inFlight) {
    traceLifecycle('ensure_container_join_inflight', { name });
    return inFlight;
  }

  const op = ensureContainerUnlocked(name, opts).finally(() => {
    if (ensureContainerInFlight.get(name) === op) {
      ensureContainerInFlight.delete(name);
    }
  });
  ensureContainerInFlight.set(name, op);
  return op;
}

async function ensureContainerUnlocked(name: string, opts?: EnsureContainerOptions): Promise<ContainerRecord> {
  // Mark workspace as pending so NVMe reclaim won't race with us (refcounted)
  pendingWorkspaces.set(name, (pendingWorkspaces.get(name) ?? 0) + 1);
  containerTerminatedAt.delete(name);

  try {
    // Check cache first
    const cached = containers.get(name);
    if (cached) {
      cached.lastAccessedAt = Date.now();
      if (await isRunning(name)) {
        traceLifecycle('ensure_container_cache_hit', {
          name,
          container: containerSnapshot(cached),
        });
        return cached;
      }
      // Container stopped — remove from cache and recreate
      traceLifecycle('ensure_container_cache_stale', {
        name,
        container: containerSnapshot(cached),
      });
      if (cached.containerIp) unindexContainerIp(cached.containerIp);
      containers.delete(name);
    }

    // Check if container already exists and is running
    if (await isRunning(name)) {
      const port = await getHostPort(name);
      const containerIp = await getContainerIp(name);
      if (port) {
        const record: ContainerRecord = {
          name,
          containerId: name,
          hostPort: port,
          containerIp,
          status: 'running',
          createdAt: Date.now(),
          lastAccessedAt: Date.now(),
          activeWebSockets: 0,
          inFlightProxyRequests: 0,
          orgId: opts?.orgId,
          workspaceId: opts?.workspaceId,
        };
        containers.set(name, record);
        if (containerIp) indexContainerIp(containerIp, name);
        traceLifecycle('ensure_container_reconnected_existing', {
          name,
          container: containerSnapshot(record),
        });
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
    traceLifecycle('ensure_container_create_begin', {
      name,
      workspacePath: wsPath,
      image: SANDBOX_IMAGE,
      runtime: CONTAINER_RUNTIME,
      opts: {
        orgId: opts?.orgId || '',
        workspaceId: opts?.workspaceId || '',
      },
    });

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

    // Base identity + proxy URLs (route API traffic through sandbox host proxy)
    if (opts?.orgId && opts?.workspaceId) {
      const proxyBase = `http://172.17.0.1:${PORT}/proxy`;
      runArgs.push(
        '-e', `WORKSPACE_ID=${opts.workspaceId}`,
        '-e', `ORG_ID=${opts.orgId}`,
        '-e', `ANTHROPIC_BASE_URL=${proxyBase}/api/claude`,
        '-e', `ANTHROPIC_API_KEY=proxy`,
        '-e', `CLOUDFLARE_API_BASE_URL=${proxyBase}/client/v4`,
        '-e', `CLOUDFLARE_API_TOKEN=proxy`,
        '-e', `DATA_PROXY_URL=${proxyBase}/api`,
        '-e', `DATA_PROXY_TOKEN=proxy`,
        '-e', `MCP_SERVER_URL=${proxyBase}/mcp`,
        '-e', `CLOUDFLARE_ACCOUNT_ID=chiridion`,
        '-e', `WRANGLER_SEND_METRICS=false`,
        '-e', `CI=1`,
        '-e', `CLAUDE_ENV_FILE=/home/claude/.chiridion/integration.env`,
        '-e', `DEBUG_CLAUDE_AGENT_SDK=1`,
      );
      if (CF_DISPATCH_NAMESPACE) {
        runArgs.push('-e', `CF_DISPATCH_NAMESPACE=${CF_DISPATCH_NAMESPACE}`);
      }
      // Pass through optional debug/config flags from sandbox host env
      for (const key of [
        'CHIRIDION_TRACE_EVENTS', 'CHIRIDION_DEBUG_STARTUP', 'CHIRIDION_DEBUG_SDK',
        'CHIRIDION_DEBUG_FS', 'CLAUDE_CODE_MAX_TURNS', 'CLAUDE_CODE_DISABLE_NONESSENTIAL',
        'CHIRIDION_PREQUEUE_FIRST_MESSAGE', 'CHIRIDION_FIRST_MESSAGE_DELAY_MS',
      ]) {
        if (process.env[key]) {
          runArgs.push('-e', `${key}=${process.env[key]}`);
        }
      }
    }

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
      traceLifecycle('ensure_container_create_failed', {
        name,
        exitCode: result.exitCode,
        stderr: result.stderr.slice(0, 500),
      });
      throw new Error(`Failed to create container ${name}: ${result.stderr}`);
    }

    const containerId = result.stdout.slice(0, 12);
    const port = await getHostPort(name);
    const containerIp = await getContainerIp(name);
    if (!port) {
      throw new Error(`Container ${name} created but no port mapping found`);
    }

    // Wait for control plane to be healthy
    const healthy = await waitForHealth(port);
    if (!healthy) {
      console.warn(`[ContainerManager] container ${name} health check timed out, proceeding anyway`);
      traceLifecycle('ensure_container_health_timeout', { name, hostPort: port });
    }

    const record: ContainerRecord = {
      name,
      containerId,
      hostPort: port,
      containerIp,
      status: 'running',
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      activeWebSockets: 0,
      inFlightProxyRequests: 0,
      orgId: opts?.orgId,
      workspaceId: opts?.workspaceId,
    };
    containers.set(name, record);
    if (containerIp) indexContainerIp(containerIp, name);
    traceLifecycle('ensure_container_create_success', {
      name,
      container: containerSnapshot(record),
    });
    console.log(`[ContainerManager] created container ${name} (id=${containerId}, port=${port})`);
    return record;
  } finally {
    const count = (pendingWorkspaces.get(name) ?? 1) - 1;
    if (count <= 0) {
      pendingWorkspaces.delete(name);
    } else {
      pendingWorkspaces.set(name, count);
    }
  }
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
    if (cached.containerIp) unindexContainerIp(cached.containerIp);
    containers.delete(name);
  }

  // Check if container exists
  if (await isRunning(name)) {
    const port = await getHostPort(name);
    const containerIp = await getContainerIp(name);
    if (port) {
      const record: ContainerRecord = {
        name,
        containerId: name,
        hostPort: port,
        containerIp,
        status: 'running',
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
        activeWebSockets: 0,
        inFlightProxyRequests: 0,
      };
      containers.set(name, record);
      if (containerIp) indexContainerIp(containerIp, name);
      traceLifecycle('get_container_reconnected', {
        name,
        container: containerSnapshot(record),
      });
      return record;
    }
  }

  return null;
}

/**
 * Terminate and remove a container.
 * Triggers a non-destructive sync (NVMe → JuiceFS) but does NOT unmount
 * the overlay or clear NVMe. A new container for the same workspace can
 * reuse the existing overlay mount immediately.
 */
export async function terminateContainer(name: string, reason = 'manual'): Promise<boolean> {
  const existing = containers.get(name);
  traceLifecycle('terminate_container_request', {
    name,
    reason,
    container: containerSnapshot(existing),
  });
  if (existing?.containerIp) unindexContainerIp(existing.containerIp);
  const result = await dockerExec(['rm', '-f', name]);
  containers.delete(name);
  if (result.success) {
    console.log(`[ContainerManager] terminated container ${name}`);
    traceLifecycle('terminate_container_success', { name, reason });
  } else {
    traceLifecycle('terminate_container_failed', {
      name,
      reason,
      exitCode: result.exitCode,
      stderr: result.stderr.slice(0, 500),
    });
  }
  // Track termination time for NVMe reclaim idle guard
  containerTerminatedAt.set(name, Date.now());
  // Non-destructive sync — keeps overlay + NVMe intact for fast reconnect
  syncOverlay(name).catch((err) =>
    console.error(`[ContainerManager] post-terminate sync failed for ${name}:`, err)
  );
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
export async function getControlPlanePort(name: string, opts?: EnsureContainerOptions): Promise<number> {
  const record = containers.get(name);
  if (record) {
    record.lastAccessedAt = Date.now();
    return record.hostPort;
  }

  // Try to reconnect
  const container = await getContainer(name);
  if (!container) {
    console.warn(`[ContainerManager] control plane port missing for ${name}; recreating container`);
    const ensured = await ensureContainer(name, opts);
    return ensured.hostPort;
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
  for (const [name, snapshot] of containers) {
    traceLifecycle('reaper_scan', {
      name,
      idleMs: now - snapshot.lastAccessedAt,
      activeWebSockets: snapshot.activeWebSockets,
      inFlightProxyRequests: snapshot.inFlightProxyRequests ?? 0,
      pendingEnsures: pendingWorkspaces.get(name) ?? 0,
    });
    if (snapshot.activeWebSockets > 0) continue;
    if ((snapshot.inFlightProxyRequests ?? 0) > 0) continue;
    if ((pendingWorkspaces.get(name) ?? 0) > 0) continue;
    const idleMs = now - snapshot.lastAccessedAt;
    if (idleMs < IDLE_TIMEOUT_MS) continue;

    // Guard against races: only reap if the same record is still current.
    const current = containers.get(name);
    if (!current || current !== snapshot) continue;
    if (current.activeWebSockets > 0) continue;
    if ((current.inFlightProxyRequests ?? 0) > 0) continue;
    if ((pendingWorkspaces.get(name) ?? 0) > 0) continue;

    const refreshedIdleMs = Date.now() - current.lastAccessedAt;
    if (refreshedIdleMs < IDLE_TIMEOUT_MS) continue;

    console.log(
      `[ContainerManager] reaping idle container ${name} (idle=${Math.round(refreshedIdleMs / 1000)}s)`
    );
    traceLifecycle('reaper_terminate', {
      name,
      idleMs: refreshedIdleMs,
      container: containerSnapshot(current),
    });
    await terminateContainer(name, 'idle_reaper');
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

// ─── NVMe Reclaim ────────────────────────────────────────────

async function reclaimIdleOverlays(): Promise<void> {
  const now = Date.now();
  for (const [name, terminatedAt] of containerTerminatedAt) {
    // Workspace came back — stop tracking for reclaim
    if (isWorkspaceActive(name)) {
      containerTerminatedAt.delete(name);
      continue;
    }

    // Not idle long enough yet
    if (now - terminatedAt < RECLAIM_IDLE_MS) continue;

    // No overlay to reclaim (already cleaned or lost)
    if (!hasOverlay(name)) {
      containerTerminatedAt.delete(name);
      continue;
    }

    // Attempt reclaim with double-check guard (isSafe callback runs after sync)
    console.log(`[ContainerManager] reclaiming NVMe for ${name} (idle=${Math.round((now - terminatedAt) / 1000)}s)`);
    const reclaimed = await reclaimOverlay(name, () => !isWorkspaceActive(name));
    if (reclaimed) {
      containerTerminatedAt.delete(name);
    }
    // On failure/abort, keep the entry so the next reclaim cycle retries
  }
}

setInterval(() => {
  reclaimIdleOverlays().catch((err) =>
    console.error('[ContainerManager] reclaim error:', err)
  );
}, RECLAIM_INTERVAL_MS);

console.log(
  `[ContainerManager] NVMe reclaim started (idle=${RECLAIM_IDLE_MS / 1000}s, interval=${RECLAIM_INTERVAL_MS / 1000}s)`
);
