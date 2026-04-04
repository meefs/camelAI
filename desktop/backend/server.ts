import type { ServerWebSocket } from 'bun';
import { DesktopService } from './service';
import { logDesktop } from './log';
import type { DesktopClientEvent, DesktopServerEvent } from '../shared/protocol';

const BACKEND_PORT = Number(process.env.DESKTOP_BACKEND_PORT || 4315);
const USE_STDIO_TRANSPORT = process.env.DESKTOP_BACKEND_TRANSPORT === 'stdio';

const service = new DesktopService();

function disposeService(): void {
  service.dispose();
}

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  headers.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  return new Response(JSON.stringify(body), { ...init, headers });
}

function startStdioTransport(): void {
  let stdioBuffer = '';
  const unsubscribe = service.subscribe((event) => {
    logDesktop('server', 'stdio:event_out', {
      type: event.type,
      threadId: 'threadId' in event ? event.threadId : undefined,
    }, 'debug');
    process.stdout.write(`${JSON.stringify(event)}\n`);
  });

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    stdioBuffer += chunk;
    while (true) {
      const newlineIndex = stdioBuffer.indexOf('\n');
      if (newlineIndex === -1) {
        break;
      }

      const line = stdioBuffer.slice(0, newlineIndex).trim();
      stdioBuffer = stdioBuffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }

      try {
        const event = JSON.parse(line) as DesktopClientEvent;
        logDesktop('server', 'stdio:event_in', {
          type: event.type,
          threadId: 'threadId' in event ? event.threadId : undefined,
        }, 'debug');
        service.handleClientEvent(event);
      } catch (error) {
        process.stdout.write(
          `${JSON.stringify({
            type: 'error',
            message: error instanceof Error ? error.message : 'Invalid stdio payload.',
          } satisfies DesktopServerEvent)}\n`
        );
      }
    }
  });

  process.on('exit', () => {
    unsubscribe();
    disposeService();
  });
  process.on('SIGTERM', () => {
    unsubscribe();
    disposeService();
    process.exit(0);
  });
  service.emitSnapshot();
}

function startHttpTransport(): void {
  const connections = new Set<ServerWebSocket<unknown>>();
  const unsubscribe = service.subscribe((event) => {
    logDesktop('server', 'ws:event_out', {
      type: event.type,
      threadId: 'threadId' in event ? event.threadId : undefined,
      connectionCount: connections.size,
    }, 'debug');
    const payload = JSON.stringify(event);
    for (const socket of connections) {
      socket.send(payload);
    }
  });

  const server = Bun.serve({
    port: BACKEND_PORT,
    fetch(request, server) {
      const url = new URL(request.url);

      if (request.method === 'OPTIONS') {
        return json({ ok: true });
      }

      if (url.pathname === '/ws') {
        if (server.upgrade(request)) {
          return undefined;
        }
        return json({ error: 'WebSocket upgrade failed' }, { status: 400 });
      }

      if (url.pathname === '/health') {
        const snapshot = service.getSnapshot();
        return json({
          ok: true,
          provider: snapshot.provider,
          model: snapshot.model,
          auth: snapshot.auth,
          runtimeStatus: snapshot.runtimeStatus,
        });
      }

      if (url.pathname === '/api/snapshot') {
        return json(service.getSnapshot());
      }

      if (url.pathname === '/api/thread' && request.method === 'POST') {
        service.handleClientEvent({ type: 'create_thread', title: 'New thread' });
        return json(service.getSnapshot(), { status: 201 });
      }

      return json({ error: 'Not found' }, { status: 404 });
    },
    websocket: {
      open(socket) {
        connections.add(socket);
        logDesktop('server', 'ws:open', {
          connectionCount: connections.size,
        }, 'debug');
        socket.send(JSON.stringify({
          type: 'snapshot',
          snapshot: service.getSnapshot(),
        } satisfies DesktopServerEvent));
      },
      close(socket) {
        connections.delete(socket);
        logDesktop('server', 'ws:close', {
          connectionCount: connections.size,
        }, 'debug');
      },
      message(socket, raw) {
        try {
          const event = JSON.parse(String(raw)) as DesktopClientEvent;
          logDesktop('server', 'ws:event_in', {
            type: event.type,
            threadId: 'threadId' in event ? event.threadId : undefined,
          }, 'debug');
          service.handleClientEvent(event);
        } catch (error) {
          socket.send(JSON.stringify({
            type: 'error',
            message: error instanceof Error ? error.message : 'Invalid message payload.',
          } satisfies DesktopServerEvent));
        }
      },
    },
  });

  process.on('exit', () => {
    unsubscribe();
    disposeService();
  });
  process.on('SIGTERM', () => {
    unsubscribe();
    disposeService();
    process.exit(0);
  });
  console.log(`[desktop-backend] listening on http://127.0.0.1:${server.port}`);
}

if (USE_STDIO_TRANSPORT) {
  startStdioTransport();
} else {
  startHttpTransport();
}
