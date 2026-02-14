/**
 * Sandbox Host Service — Lifecycle + Filesystem + Exec + Control Plane Proxy
 *
 * Replaces modal-proxy with Docker + gVisor containers on a host VM.
 * Same URL scheme (/v1/sandboxes/{name}/...) for minimal workspace-container.ts changes.
 *
 * FS operations use direct host filesystem access (Docker volumes map host → container).
 * Control plane requests (health, env, chat) are proxied to the container's mapped port.
 */
import type { ServerWebSocket } from 'bun';
import {
  ensureContainer,
  terminateContainer,
  execInContainer,
  getControlPlanePort,
  touchContainer,
  addWebSocket,
  removeWebSocket,
  resolveContainerBySourceIp,
} from './container-manager';
import { ensureOverlay } from './overlay';
import {
  fsReadInfo,
  fsWrite,
  fsList,
  fsDelete,
  fsMove,
  fsMkdir,
  fsExists,
} from './fs-host';

const PORT = parseInt(process.env.PORT || '80', 10);
const R2_MOUNT_ROOT = process.env.R2_MOUNT_ROOT || '/mnt/r2';
const WORKER_BASE_URL = process.env.WORKER_BASE_URL || '';
const SANDBOX_PROXY_SECRET = process.env.SANDBOX_PROXY_SECRET || '';
const SANDBOX_HOST_IDLE_TIMEOUT_SECS = Math.max(
  10,
  parseInt(process.env.SANDBOX_HOST_IDLE_TIMEOUT_SECS || '120', 10)
);
const PROXY_SESSION_ACTIVE_TTL_MS = Math.max(
  30_000,
  parseInt(process.env.PROXY_SESSION_ACTIVE_TTL_MS || String(30 * 60_000), 10)
);
const PROXY_SESSION_CLOSE_GRACE_MS = Math.max(
  5_000,
  parseInt(process.env.PROXY_SESSION_CLOSE_GRACE_MS || String(10 * 60_000), 10)
);
const PROXY_SESSION_CLEANUP_INTERVAL_MS = Math.max(
  5_000,
  parseInt(process.env.PROXY_SESSION_CLEANUP_INTERVAL_MS || '60000', 10)
);
const HEADER_WORKER_BASE_URL = 'x-chiridion-worker-base-url';
const HEADER_THREAD_ID = 'x-chiridion-thread-id';
const HEADER_PROXY_SESSION_ID = 'x-chiridion-proxy-session-id';
const HEADER_SANDBOX_SECRET = 'x-sandbox-secret';
const NON_PROXY_DENY_CIDRS = (process.env.NON_PROXY_DENY_CIDRS || '172.17.0.0/16,fc00::/7,fe80::/10')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);

interface WsData {
  name: string;
  threadId: string;
  proxySessionId: string;
  targetWsUrl: string;
  upstream: WebSocket | null;
  upstreamReady: boolean;
  pendingMessages: string[];
}

interface ProxySessionContext {
  id: string;
  containerName: string;
  orgId: string;
  workspaceId: string;
  threadId: string;
  workerBaseUrl: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  closedAt: number | null;
}

const proxySessions = new Map<string, ProxySessionContext>();

function cleanupExpiredProxySessions(): void {
  const now = Date.now();
  let removed = 0;
  for (const [sessionId, session] of proxySessions) {
    if (session.expiresAt <= now) {
      proxySessions.delete(sessionId);
      removed += 1;
    }
  }
  if (removed > 0) {
    console.log(`[SandboxHost] cleaned up ${removed} expired proxy session(s)`);
  }
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

/**
 * Derive a deterministic sandbox container name from a workspace ID.
 * Must match the logic formerly in workspace-container.ts getSandboxName().
 */
function sandboxName(workspaceId: string): string {
  const safeId = workspaceId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const raw = `chiridion-ws-${safeId}`;
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return (normalized || `chiridion-${Date.now()}`).slice(0, 63);
}

interface WorkspaceRoute {
  name: string;
  orgId: string;
  workspaceId: string;
  subpath: string;
}

/**
 * Parse workspace route from URL:
 *   /v1/workspaces/{orgId}/{workspaceId}/fs/read?path=...
 *   /v1/workspaces/{orgId}/{workspaceId}/exec
 *   /v1/workspaces/{orgId}/{workspaceId}/health
 *   /v1/workspaces/{orgId}/{workspaceId}/chat
 *   /v1/workspaces/{orgId}/{workspaceId}/terminate
 */
function parseWorkspaceRoute(url: URL): WorkspaceRoute | null {
  const match = url.pathname.match(/^\/v1\/workspaces\/([^/]+)\/([^/]+)(\/.*)?$/);
  if (!match) return null;
  const orgId = decodeURIComponent(match[1]);
  const workspaceId = decodeURIComponent(match[2]);
  return {
    name: sandboxName(workspaceId),
    orgId,
    workspaceId,
    subpath: match[3] || '',
  };
}

/**
 * Parse proxy route from URL:
 *   /proxy/{proxySessionId}/api/claude/v1/messages
 *   /proxy/{proxySessionId}/client/v4/...
 *   /proxy/{proxySessionId}/api/mssql/query
 *
 * Returns the proxy session ID and upstream path.
 */
interface ProxyRoute {
  proxySessionId: string;
  upstreamPath: string;
}

function parseProxyRoute(url: URL): ProxyRoute | null {
  const match = url.pathname.match(/^\/proxy\/([^/]+)(\/.*)?$/);
  if (!match) return null;
  return {
    proxySessionId: decodeURIComponent(match[1]),
    upstreamPath: match[2] || '/',
  };
}

function normalizeWorkerBaseUrl(raw: string | null | undefined): string | null {
  const value = (raw || '').trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    parsed.pathname = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function normalizeIpv4(ip: string): string | null {
  if (!ip) return null;
  const trimmed = ip.trim();
  const v4 = trimmed.startsWith('::ffff:') ? trimmed.slice(7) : trimmed;
  const parts = v4.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((part) => Number(part));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return nums.join('.');
}

function ipv4ToInt(ip: string): number {
  const [a, b, c, d] = ip.split('.').map(Number);
  return (((a << 24) >>> 0) | (b << 16) | (c << 8) | d) >>> 0;
}

function parseIpv6ToBigInt(ip: string): bigint | null {
  let value = ip.trim().toLowerCase();
  if (!value) return null;
  if (value.startsWith('[') && value.endsWith(']')) {
    value = value.slice(1, -1);
  }
  const zoneIdx = value.indexOf('%');
  if (zoneIdx >= 0) {
    value = value.slice(0, zoneIdx);
  }

  // Convert IPv4-embedded suffix into 2 hextets.
  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':');
    if (lastColon < 0) return null;
    const ipv4Part = normalizeIpv4(value.slice(lastColon + 1));
    if (!ipv4Part) return null;
    const ipv4Int = ipv4ToInt(ipv4Part);
    const hi = ((ipv4Int >>> 16) & 0xffff).toString(16);
    const lo = (ipv4Int & 0xffff).toString(16);
    value = `${value.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const parts = value.split('::');
  if (parts.length > 2) return null;

  const left = parts[0] ? parts[0].split(':').filter(Boolean) : [];
  const right = parts[1] ? parts[1].split(':').filter(Boolean) : [];
  const hasCompression = parts.length === 2;
  const missing = 8 - (left.length + right.length);

  if (hasCompression) {
    if (missing < 1) return null;
  } else if (missing !== 0) {
    return null;
  }

  const hextets = hasCompression
    ? [...left, ...new Array(missing).fill('0'), ...right]
    : left;
  if (hextets.length !== 8) return null;
  if (hextets.some((h) => !/^[0-9a-f]{1,4}$/i.test(h))) return null;

  let out = 0n;
  for (const h of hextets) {
    out = (out << 16n) + BigInt(parseInt(h, 16));
  }
  return out;
}

type ParsedIp =
  | { family: 'ipv4'; value: number }
  | { family: 'ipv6'; value: bigint };

function parseIp(ip: string): ParsedIp | null {
  const v4 = normalizeIpv4(ip);
  if (v4) return { family: 'ipv4', value: ipv4ToInt(v4) };
  const v6 = parseIpv6ToBigInt(ip);
  if (v6 === null) return null;
  return { family: 'ipv6', value: v6 };
}

function ipInCidr(parsedIp: ParsedIp, cidr: string): boolean {
  const [base, prefixRaw] = cidr.split('/');
  if (!base || prefixRaw === undefined) return false;

  const parsedBase = parseIp(base);
  if (!parsedBase) return false;
  if (parsedBase.family !== parsedIp.family) return false;

  const prefix = Number(prefixRaw);
  const maxBits = parsedIp.family === 'ipv4' ? 32 : 128;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxBits) return false;

  if (parsedIp.family === 'ipv4' && parsedBase.family === 'ipv4') {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (parsedIp.value & mask) === (parsedBase.value & mask);
  }

  if (parsedIp.family !== 'ipv6' || parsedBase.family !== 'ipv6') return false;
  if (prefix === 0) return true;
  const shift = BigInt(128 - prefix);
  return (parsedIp.value >> shift) === (parsedBase.value >> shift);
}

function isDeniedNonProxySourceIp(sourceIp: string): boolean {
  const parsedIp = parseIp(sourceIp);
  if (!parsedIp) return false;
  return NON_PROXY_DENY_CIDRS.some((cidr) => ipInCidr(parsedIp, cidr));
}

/**
 * Proxy container API traffic to the Worker with identity headers.
 * Strips original auth headers and adds X-Sandbox-Secret + X-Chiridion-* headers.
 */
async function handleProxyRoute(req: Request, proxy: ProxyRoute, sourceIp: string): Promise<Response> {
  if (!SANDBOX_PROXY_SECRET) {
    return errorResponse('SANDBOX_PROXY_SECRET not configured', 500);
  }

  const caller = await resolveContainerBySourceIp(sourceIp);
  if (!caller) {
    return errorResponse('Unknown proxy caller', 403);
  }
  const session = proxySessions.get(proxy.proxySessionId);
  if (!session) {
    return errorResponse('Unknown proxy session', 403);
  }
  const now = Date.now();
  if (session.expiresAt <= now) {
    proxySessions.delete(proxy.proxySessionId);
    return errorResponse('Unknown proxy session', 403);
  }
  if (session.containerName !== caller.name) {
    return errorResponse('Proxy session does not match caller container', 403);
  }

  const workerBaseUrl = normalizeWorkerBaseUrl(session.workerBaseUrl || WORKER_BASE_URL);
  if (!workerBaseUrl) {
    return errorResponse('Worker base URL unavailable for proxy session', 503);
  }

  const url = new URL(req.url);
  const targetUrl = `${workerBaseUrl}${proxy.upstreamPath}${url.search}`;
  const target = new URL(targetUrl);

  const headers = new Headers(req.headers);
  // Strip original auth — container doesn't need to authenticate
  headers.delete('Authorization');
  headers.delete('x-api-key');
  headers.delete('x-sandbox-secret');
  headers.delete('x-chiridion-org-id');
  headers.delete('x-chiridion-workspace-id');
  headers.delete('x-chiridion-thread-id');
  headers.delete('x-chiridion-proxy-session-id');
  headers.delete('x-chiridion-mcp-identity');
  // Never forward incoming host authority from container -> VM proxy.
  // Bun may use it for TLS authority, causing cert altname mismatches.
  headers.delete('host');
  if (
    !headers.has('ngrok-skip-browser-warning') &&
    (target.hostname.endsWith('.ngrok-free.dev') || target.hostname.endsWith('.ngrok.app'))
  ) {
    headers.set('ngrok-skip-browser-warning', 'true');
  }
  // Add sandbox proxy identity headers
  headers.set('X-Sandbox-Secret', SANDBOX_PROXY_SECRET);
  headers.set('X-Chiridion-Org-Id', session.orgId);
  headers.set('X-Chiridion-Workspace-Id', session.workspaceId);
  headers.set('X-Chiridion-Thread-Id', session.threadId);

  const init: RequestInit = {
    method: req.method,
    headers,
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = req.body;
    // @ts-expect-error Bun supports duplex
    init.duplex = 'half';
  }

  session.lastSeenAt = now;
  session.expiresAt = now + PROXY_SESSION_ACTIVE_TTL_MS;
  session.closedAt = null;
  return fetch(targetUrl, init);
}

/**
 * Proxy an HTTP request to a container's control plane.
 */
async function proxyToControlPlane(
  name: string,
  path: string,
  opts: { orgId?: string; workspaceId?: string } | undefined,
  req: Request
): Promise<Response> {
  const port = await getControlPlanePort(name, opts);
  const url = new URL(req.url);
  const targetUrl = `http://127.0.0.1:${port}${path}${url.search}`;

  const headers = new Headers(req.headers);
  // Remove proxy auth — control plane doesn't need it
  headers.delete('Authorization');
  headers.delete(HEADER_SANDBOX_SECRET);
  headers.delete(HEADER_WORKER_BASE_URL);
  headers.delete(HEADER_THREAD_ID);
  headers.delete(HEADER_PROXY_SESSION_ID);
  headers.delete('host');

  const init: RequestInit = {
    method: req.method,
    headers,
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = req.body;
    // @ts-expect-error Bun supports duplex
    init.duplex = 'half';
  }

  return fetch(targetUrl, init);
}

Bun.serve<WsData>({
  port: PORT,
  idleTimeout: SANDBOX_HOST_IDLE_TIMEOUT_SECS,

  async fetch(req: Request, server) {

    const url = new URL(req.url);
    const sourceIp = server.requestIP(req)?.address || '';
    if (!url.pathname.startsWith('/proxy')) {
      if (!sourceIp) {
        return errorResponse('Missing source IP for non-proxy route', 403);
      }
      if (!parseIp(sourceIp)) {
        return errorResponse('Unparseable source IP for non-proxy route', 403);
      }
      if (isDeniedNonProxySourceIp(sourceIp)) {
        return errorResponse('Sandbox containers may only access /proxy', 403);
      }
    }

    // Service health check
    if (url.pathname === '/health') {
      return jsonResponse({ status: 'ok', service: 'sandbox-host' });
    }

    // ─── Proxy route (container API traffic → Worker) ──
    const proxyRoute = parseProxyRoute(url);
    if (proxyRoute) {
      if (!sourceIp) {
        return errorResponse('Missing proxy source IP', 403);
      }
      return handleProxyRoute(req, proxyRoute, sourceIp);
    }

    const route = parseWorkspaceRoute(url);
    if (!route) {
      return errorResponse('Not found', 404);
    }

    const { name, orgId, workspaceId, subpath } = route;

    // Keep container alive while it's receiving requests
    touchContainer(name);

    try {
      // ─── Terminate ─────────────────────────────────────────

      if (subpath === '/terminate' && req.method === 'POST') {
        const success = await terminateContainer(name);
        return jsonResponse({ success });
      }

      // ─── Filesystem (host FS, overlay-only — no container) ─

      if (subpath.startsWith('/fs/')) {
        // FS operations only need the overlay mount, not a running container
        await ensureOverlay(name);
      }

      if (subpath === '/fs/read' && req.method === 'GET') {
        const path = url.searchParams.get('path');
        if (!path) return errorResponse('path query param required', 400);
        try {
          const { hostPath, size } = await fsReadInfo(name, path);
          const file = Bun.file(hostPath);
          return new Response(file.stream(), {
            headers: {
              'Content-Type': 'application/octet-stream',
              'Content-Length': String(size),
            },
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('ENOENT') || msg.includes('No such file')) {
            return errorResponse('File not found', 404);
          }
          if (msg.includes('traversal')) {
            return errorResponse(msg, 403);
          }
          return errorResponse(msg, 500);
        }
      }

      if (subpath === '/fs/write' && req.method === 'PUT') {
        const path = url.searchParams.get('path');
        if (!path) return errorResponse('path query param required', 400);
        try {
          const body = new Uint8Array(await req.arrayBuffer());
          await fsWrite(name, path, body);
          return jsonResponse({ success: true });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('traversal')) return errorResponse(msg, 403);
          return errorResponse(msg, 500);
        }
      }

      if (subpath === '/fs/list' && req.method === 'GET') {
        const path = url.searchParams.get('path') || '/';
        try {
          const files = await fsList(name, path);
          return jsonResponse({
            files,
            count: files.length,
            path,
            timestamp: new Date().toISOString(),
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('ENOENT')) return errorResponse('Path not found', 404);
          if (msg.includes('traversal')) return errorResponse(msg, 403);
          return errorResponse(msg, 500);
        }
      }

      if (subpath === '/fs/delete' && req.method === 'DELETE') {
        const body = (await req.json()) as { path?: string; recursive?: boolean };
        if (!body.path) return errorResponse('path required', 400);
        try {
          await fsDelete(name, body.path, body.recursive === true);
          return jsonResponse({ success: true });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('traversal')) return errorResponse(msg, 403);
          return errorResponse(msg, 500);
        }
      }

      if (subpath === '/fs/move' && req.method === 'POST') {
        const body = (await req.json()) as { source?: string; dest?: string };
        if (!body.source || !body.dest) return errorResponse('source and dest required', 400);
        try {
          await fsMove(name, body.source, body.dest);
          return jsonResponse({ success: true, timestamp: new Date().toISOString() });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('traversal')) return errorResponse(msg, 403);
          return errorResponse(msg, 500);
        }
      }

      if (subpath === '/fs/mkdir' && req.method === 'POST') {
        const path = url.searchParams.get('path');
        if (!path) return errorResponse('path query param required', 400);
        try {
          await fsMkdir(name, path);
          return jsonResponse({ success: true, timestamp: new Date().toISOString() });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('traversal')) return errorResponse(msg, 403);
          return errorResponse(msg, 500);
        }
      }

      if (subpath === '/fs/exists' && req.method === 'GET') {
        const path = url.searchParams.get('path');
        if (!path) return errorResponse('path query param required', 400);
        try {
          const result = await fsExists(name, path);
          return jsonResponse(result);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('traversal')) return errorResponse(msg, 403);
          return errorResponse(msg, 500);
        }
      }

      // ─── Exec (requires container) ──────────────────────

      if (subpath === '/exec' && req.method === 'POST') {
        await ensureContainer(name, { orgId, workspaceId });
        const body = (await req.json()) as {
          cmd?: string[];
          cwd?: string;
          env?: Record<string, string>;
        };
        if (!Array.isArray(body.cmd) || body.cmd.length === 0) {
          return errorResponse('cmd array required', 400);
        }
        const result = await execInContainer(name, body.cmd, {
          cwd: body.cwd,
          env: body.env,
        });
        return jsonResponse({
          success: result.exitCode === 0,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        });
      }

      // ─── Control Plane Proxy (auto-creates container) ──

      if (subpath === '/health' && req.method === 'GET') {
        await ensureContainer(name, { orgId, workspaceId });
        return proxyToControlPlane(name, '/health', { orgId, workspaceId }, req);
      }

      if (subpath === '/chat') {
        if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
          return errorResponse('WebSocket upgrade required', 426);
        }

        const threadId = req.headers.get(HEADER_THREAD_ID)?.trim() || '';
        if (!threadId) {
          return errorResponse('Missing thread ID', 400);
        }
        const proxySessionId = req.headers.get(HEADER_PROXY_SESSION_ID)?.trim() || '';
        if (!proxySessionId) {
          return errorResponse('Missing proxy session ID', 400);
        }
        const workerBaseUrl = normalizeWorkerBaseUrl(
          req.headers.get(HEADER_WORKER_BASE_URL) || WORKER_BASE_URL
        );
        if (!workerBaseUrl) {
          return errorResponse('Missing worker base URL', 400);
        }

        await ensureContainer(name, { orgId, workspaceId });
        const now = Date.now();
        proxySessions.set(proxySessionId, {
          id: proxySessionId,
          containerName: name,
          orgId,
          workspaceId,
          threadId,
          workerBaseUrl,
          createdAt: now,
          lastSeenAt: now,
          expiresAt: now + PROXY_SESSION_ACTIVE_TTL_MS,
          closedAt: null,
        });
        console.log(
          `[SandboxHost] chat session opened container=${name} thread=${threadId} proxySession=${proxySessionId}`
        );
        const port = await getControlPlanePort(name, { orgId, workspaceId });
        const targetWsUrl = `ws://127.0.0.1:${port}/chat`;

        // Upgrade client connection
        const upgraded = server.upgrade(req, {
          data: {
            name,
            threadId,
            proxySessionId,
            targetWsUrl,
            upstream: null,
            upstreamReady: false,
            pendingMessages: [],
          },
        });
        if (!upgraded) {
          proxySessions.delete(proxySessionId);
          return errorResponse('WebSocket upgrade failed', 500);
        }
        return undefined as unknown as Response;
      }

      return errorResponse('Not found', 404);
    } catch (err) {
      console.error(`[SandboxHost] request error:`, err);
      return errorResponse(`Internal error: ${err}`, 500);
    }
  },

  websocket: {
    open(ws: ServerWebSocket<WsData>) {
      const { name, threadId, proxySessionId, targetWsUrl } = ws.data;

      // Track active WS to prevent idle reaping
      addWebSocket(name);

      // Open upstream WebSocket to the container's control plane
      const upstream = new WebSocket(targetWsUrl);
      ws.data.upstream = upstream;

      // Forward messages: upstream → client
      upstream.addEventListener('message', (event) => {
        try {
          if (typeof event.data === 'string') {
            ws.send(event.data);
          } else {
            ws.send(new Uint8Array(event.data as unknown as ArrayBuffer));
          }
        } catch {
          // Client closed
        }
      });

      upstream.addEventListener('close', (event) => {
        console.log(
          `[SandboxHost] upstream ws closed container=${name} thread=${threadId} proxySession=${proxySessionId} code=${event.code} reason=${event.reason || ''}`
        );
        try { ws.close(); } catch { /* already closed */ }
      });

      upstream.addEventListener('error', (err) => {
        console.error(
          `[SandboxHost] upstream ws error container=${name} thread=${threadId} proxySession=${proxySessionId}:`,
          err
        );
        try { ws.close(); } catch { /* already closed */ }
      });

      upstream.addEventListener('open', () => {
        ws.data.upstreamReady = true;
        // Flush any messages queued while upstream was connecting
        for (const msg of ws.data.pendingMessages) {
          upstream.send(msg);
        }
        ws.data.pendingMessages.length = 0;
      });
    },

    message(ws: ServerWebSocket<WsData>, data: string | Buffer) {
      const message = typeof data === 'string' ? data : data.toString('utf-8');

      if (ws.data.upstream && ws.data.upstreamReady) {
        ws.data.upstream.send(message);
      } else if (ws.data.upstream) {
        ws.data.pendingMessages.push(message);
      }
    },

    close(ws: ServerWebSocket<WsData>, code: number, reason: string) {
      const session = proxySessions.get(ws.data.proxySessionId);
      if (session) {
        const now = Date.now();
        session.closedAt = now;
        session.expiresAt = now + PROXY_SESSION_CLOSE_GRACE_MS;
      }
      console.log(
        `[SandboxHost] chat session closed container=${ws.data.name} thread=${ws.data.threadId} proxySession=${ws.data.proxySessionId} code=${code} reason=${reason || ''}`
      );
      removeWebSocket(ws.data.name);
      if (ws.data.upstream && ws.data.upstream.readyState === WebSocket.OPEN) {
        ws.data.upstream.close();
      }
    },
  },
});

setInterval(cleanupExpiredProxySessions, PROXY_SESSION_CLEANUP_INTERVAL_MS);

// ─── Host-level R2 mount (one-time at startup) ──────────────────────
//
// Mount the entire R2 bucket to R2_MOUNT_ROOT via rclone. Individual
// containers then get per-workspace subdirectories via Docker -v bind mounts,
// avoiding FUSE/rclone inside gVisor containers entirely.

const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;

async function mountR2OnHost(): Promise<void> {
  if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_ACCOUNT_ID || !R2_BUCKET_NAME) {
    console.log('[SandboxHost] R2 credentials not configured, skipping host mount');
    return;
  }

  // Check if already mounted
  const { existsSync, mkdirSync, writeFileSync } = await import('fs');
  try {
    const { execSync } = await import('child_process');
    const mounts = execSync('mount', { encoding: 'utf8' });
    if (mounts.includes(R2_MOUNT_ROOT)) {
      console.log(`[SandboxHost] R2 already mounted at ${R2_MOUNT_ROOT}`);
      return;
    }
  } catch {}

  // Ensure mount point exists
  mkdirSync(R2_MOUNT_ROOT, { recursive: true });

  // Write rclone config
  const configPath = '/tmp/rclone-r2.conf';
  const rcloneConfig = [
    '[r2]',
    'type = s3',
    'provider = Cloudflare',
    `access_key_id = ${R2_ACCESS_KEY_ID}`,
    `secret_access_key = ${R2_SECRET_ACCESS_KEY}`,
    `endpoint = https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  ].join('\n');
  writeFileSync(configPath, rcloneConfig);

  // Mount via rclone (daemon mode so it runs in background)
  const { execSync } = await import('child_process');
  try {
    execSync(
      `rclone mount --daemon r2:${R2_BUCKET_NAME} ${R2_MOUNT_ROOT} --config=${configPath} --allow-other --dir-cache-time=5s --vfs-cache-mode=writes --vfs-write-back=0`,
      { stdio: 'pipe', timeout: 10_000 }
    );
    console.log(`[SandboxHost] R2 bucket mounted at ${R2_MOUNT_ROOT}`);
  } catch (err) {
    console.error(`[SandboxHost] Failed to mount R2 bucket:`, err);
  }

  // Verify mount
  await new Promise((r) => setTimeout(r, 1000));
  if (existsSync(R2_MOUNT_ROOT)) {
    console.log(`[SandboxHost] R2 mount verified at ${R2_MOUNT_ROOT}`);
  } else {
    console.warn(`[SandboxHost] R2 mount point not accessible after mount`);
  }
}

mountR2OnHost().catch((err) =>
  console.error('[SandboxHost] Host R2 mount startup error:', err)
);

console.log(`[SandboxHost] listening on port ${PORT}`);
