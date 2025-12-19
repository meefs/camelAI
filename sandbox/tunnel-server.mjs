const port = Number.parseInt(process.env.SANDBOX_TUNNEL_PORT || '8787', 10);

if (!Number.isFinite(port)) {
  console.error('[tunnel] Invalid SANDBOX_TUNNEL_PORT:', process.env.SANDBOX_TUNNEL_PORT);
  process.exit(1);
}

const clients = new Set();
const decoder = new TextDecoder();
const pending = new Map();

function getProxySocket() {
  for (const ws of clients) return ws;
  return null;
}

function withTimeout(promise, timeoutMs, onTimeout) {
  let timeoutId;
  const timeoutPromise = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve(onTimeout()), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

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

    if (url.pathname.startsWith('/client/v4')) {
      const ws = getProxySocket();
      if (!ws) {
        return new Response('tunnel not connected', { status: 503 });
      }

      const requestId = crypto.randomUUID();
      const method = req.method.toUpperCase();
      const headers = {};
      for (const [key, value] of req.headers.entries()) {
        headers[key] = value;
      }
      const body =
        method === 'GET' || method === 'HEAD'
          ? null
          : Buffer.from(await req.arrayBuffer()).toString('base64');

      const responsePromise = new Promise((resolve) => {
        pending.set(requestId, resolve);
      });

      ws.send(
        JSON.stringify({
          type: 'cf_api_request',
          id: requestId,
          method,
          path: url.pathname,
          search: url.search,
          headers,
          body,
        })
      );

      const response = await withTimeout(responsePromise, 120000, () => ({
        type: 'cf_api_response',
        id: requestId,
        status: 504,
        headers: { 'content-type': 'text/plain' },
        body: Buffer.from('tunnel timeout').toString('base64'),
      }));

      pending.delete(requestId);
      const status = response.status ?? 502;
      const responseHeaders = new Headers(response.headers ?? {});
      const responseBody = response.body ? Buffer.from(response.body, 'base64') : null;
      return new Response(responseBody, { status, headers: responseHeaders });
    }

    return new Response('Sandbox tunnel');
  },
  websocket: {
    open(ws) {
      clients.add(ws);
      ws.send(JSON.stringify({ type: 'tunnel_ready', pid: process.pid }));
    },
    message(_ws, message) {
      const text = typeof message === 'string' ? message : decoder.decode(message);
      try {
        const data = JSON.parse(text);
        if (data?.type === 'ping') {
          _ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        } else if (data?.type === 'tunnel_init') {
          _ws.send(JSON.stringify({ type: 'tunnel_ack', ts: Date.now() }));
        } else if (data?.type === 'cf_api_response' && data.id) {
          const resolver = pending.get(data.id);
          if (resolver) {
            resolver(data);
          }
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
