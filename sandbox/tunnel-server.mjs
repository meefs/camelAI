const port = Number.parseInt(process.env.SANDBOX_TUNNEL_PORT || '8787', 10);

if (!Number.isFinite(port)) {
  console.error('[tunnel] Invalid SANDBOX_TUNNEL_PORT:', process.env.SANDBOX_TUNNEL_PORT);
  process.exit(1);
}

const clients = new Set();
const decoder = new TextDecoder();

function broadcast(message) {
  const payload = JSON.stringify(message);
  for (const ws of clients) {
    try {
      ws.send(payload);
    } catch {
      // Ignore disconnected sockets.
    }
  }
}

const server = Bun.serve({
  port,
  hostname: '0.0.0.0',
  fetch(req, bunServer) {
    if (bunServer.upgrade(req)) {
      return;
    }

    const url = new URL(req.url);
    if (req.method === 'POST' && url.pathname === '/emit') {
      return req
        .json()
        .then((event) => {
          broadcast({ type: 'emit', event });
          return new Response('ok');
        })
        .catch((err) => {
          console.error('[tunnel] Failed to parse emit payload:', err);
          return new Response('bad request', { status: 400 });
        });
    }

    return new Response('Sandbox tunnel');
  },
  websocket: {
    open(ws) {
      clients.add(ws);
      ws.send(JSON.stringify({ type: 'tunnel_ready', pid: process.pid }));
    },
    message(ws, message) {
      const text = typeof message === 'string' ? message : decoder.decode(message);
      try {
        const data = JSON.parse(text);
        if (data?.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        } else if (data?.type === 'tunnel_init') {
          ws.send(JSON.stringify({ type: 'tunnel_ack', ts: Date.now() }));
        }
      } catch {
        // Ignore malformed messages.
      }
    },
    close(ws) {
      clients.delete(ws);
    },
  },
});

console.log(`[tunnel] WebSocket server listening on port ${server.port}`);
