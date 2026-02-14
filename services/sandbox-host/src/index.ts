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
  setWorkspaceOpts,
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

interface WsData {
  name: string;
  targetWsUrl: string;
  upstream: WebSocket | null;
  upstreamReady: boolean;
  pendingMessages: string[];
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
 * Parse sandbox name + sub-path from URL:
 *   /v1/sandboxes/{name}/fs/read?path=...
 *   /v1/sandboxes/{name}/exec
 *   /v1/sandboxes/{name}/env
 *   /v1/sandboxes/{name}/health
 *   /v1/sandboxes/{name}/chat
 *   /v1/sandboxes/{name}/terminate
 */
function parseSandboxRoute(url: URL): { name: string; subpath: string } | null {
  const match = url.pathname.match(/^\/v1\/sandboxes\/([^/]+)(\/.*)?$/);
  if (!match) return null;
  return {
    name: decodeURIComponent(match[1]),
    subpath: match[2] || '',
  };
}

/**
 * Proxy an HTTP request to a container's control plane.
 */
async function proxyToControlPlane(
  name: string,
  path: string,
  req: Request
): Promise<Response> {
  const port = await getControlPlanePort(name);
  const url = new URL(req.url);
  const targetUrl = `http://127.0.0.1:${port}${path}${url.search}`;

  const headers = new Headers(req.headers);
  // Remove proxy auth — control plane doesn't need it
  headers.delete('Authorization');

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

  async fetch(req: Request, server) {

    const url = new URL(req.url);

    // Service health check
    if (url.pathname === '/health') {
      return jsonResponse({ status: 'ok', service: 'sandbox-host' });
    }

    const route = parseSandboxRoute(url);
    if (!route) {
      return errorResponse('Not found', 404);
    }

    const { name, subpath } = route;

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
        await ensureContainer(name);
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

      // POST /v1/sandboxes/{name}/env → container :8080/env
      if (subpath === '/env' && req.method === 'POST') {
        const body = (await req.json()) as Record<string, string>;

        // Extract workspace opts from env body for R2 bind mounts
        if (body.ORG_ID && body.WORKSPACE_ID) {
          setWorkspaceOpts(name, { orgId: body.ORG_ID, workspaceId: body.WORKSPACE_ID });
        }

        // Auto-create container if not running
        await ensureContainer(name);

        // Proxy to control plane
        return proxyToControlPlane(name, '/env', new Request(req.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }));
      }

      // GET /v1/sandboxes/{name}/health → container :8080/health
      if (subpath === '/health' && req.method === 'GET') {
        await ensureContainer(name);
        return proxyToControlPlane(name, '/health', req);
      }

      // WebSocket /v1/sandboxes/{name}/chat → container :8080/chat
      if (subpath === '/chat') {
        if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
          return errorResponse('WebSocket upgrade required', 426);
        }

        // Auto-create container if not running
        await ensureContainer(name);
        const port = await getControlPlanePort(name);
        const targetWsUrl = `ws://127.0.0.1:${port}/chat`;

        // Upgrade client connection
        const upgraded = server.upgrade(req, {
          data: {
            name,
            targetWsUrl,
            upstream: null,
            upstreamReady: false,
            pendingMessages: [],
          },
        });
        if (!upgraded) {
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
      const { name, targetWsUrl } = ws.data;

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

      upstream.addEventListener('close', () => {
        try { ws.close(); } catch { /* already closed */ }
      });

      upstream.addEventListener('error', (err) => {
        console.error(`[SandboxHost] upstream ws error:`, err);
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

    close(ws: ServerWebSocket<WsData>) {
      removeWebSocket(ws.data.name);
      if (ws.data.upstream && ws.data.upstream.readyState === WebSocket.OPEN) {
        ws.data.upstream.close();
      }
    },
  },
});

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
