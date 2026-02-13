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
  getContainer,
  terminateContainer,
  execInContainer,
  getControlPlanePort,
  touchContainer,
  addWebSocket,
  removeWebSocket,
} from './container-manager';
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
 *   /v1/sandboxes/{name}
 *   /v1/sandboxes/{name}/fs/read?path=...
 *   /v1/sandboxes/{name}/exec
 *   /v1/sandboxes/{name}/env
 *   /v1/sandboxes/{name}/health
 *   /v1/sandboxes/{name}/chat
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
      // ─── Lifecycle ───────────────────────────────────────

      if (!subpath) {
        // POST /v1/sandboxes/{name} — Create or reconnect (idempotent)
        if (req.method === 'POST') {
          const record = await ensureContainer(name);
          return jsonResponse({
            id: record.containerId,
            name: record.name,
            status: 'warm',
          });
        }

        // GET /v1/sandboxes/{name} — Get info
        if (req.method === 'GET') {
          const record = await getContainer(name);
          if (!record) {
            return errorResponse('Sandbox not found', 404);
          }
          return jsonResponse({
            id: record.containerId,
            name: record.name,
            status: 'warm',
          });
        }

        // DELETE /v1/sandboxes/{name} — Terminate
        if (req.method === 'DELETE') {
          const success = await terminateContainer(name);
          return jsonResponse({ success });
        }

        return errorResponse('Method not allowed', 405);
      }

      // ─── Filesystem (host FS) ──────────────────────────────

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

      // ─── Exec ────────────────────────────────────────────

      if (subpath === '/exec' && req.method === 'POST') {
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

      // ─── Control Plane Proxy ─────────────────────────────

      // POST /v1/sandboxes/{name}/env → container :8080/env
      if (subpath === '/env' && req.method === 'POST') {
        return proxyToControlPlane(name, '/env', req);
      }

      // GET /v1/sandboxes/{name}/health → container :8080/health
      if (subpath === '/health' && req.method === 'GET') {
        return proxyToControlPlane(name, '/health', req);
      }

      // WebSocket /v1/sandboxes/{name}/chat → container :8080/chat
      if (subpath === '/chat') {
        if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
          return errorResponse('WebSocket upgrade required', 426);
        }

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

console.log(`[SandboxHost] listening on port ${PORT}`);
