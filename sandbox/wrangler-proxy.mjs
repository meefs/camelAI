import http from 'node:http';

const listenHost = process.env.WRANGLER_PROXY_HOST || '127.0.0.1';
const listenPort = Number(process.env.WRANGLER_PROXY_PORT || '8788');
const targetBase = process.env.CHIRIDION_BASE_URL;

if (!targetBase) {
  console.error('[wrangler-proxy] CHIRIDION_BASE_URL is required');
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const targetUrl = new URL(url.pathname + url.search, targetBase);

    const incomingAuth = req.headers['authorization'];
    const bearer = typeof incomingAuth === 'string' ? incomingAuth.match(/^Bearer\s+(.+)\s*$/i)?.[1]?.trim() : null;
    if (!bearer) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing Authorization bearer token' }));
      return;
    }

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'undefined') continue;
      if (k.toLowerCase() === 'host') continue;
      if (k.toLowerCase() === 'content-length') continue;
      if (k.toLowerCase() === 'authorization') continue;
      if (Array.isArray(v)) headers.set(k, v.join(','));
      else headers.set(k, v);
    }
    headers.set('X-Chiridion-Deploy-Token', bearer);

    const method = (req.method || 'GET').toUpperCase();
    const body =
      method === 'GET' || method === 'HEAD'
        ? undefined
        : await new Promise((resolve, reject) => {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => resolve(Buffer.concat(chunks)));
            req.on('error', reject);
          });

    const resp = await fetch(targetUrl, { method, headers, body });

    const respHeaders = {};
    resp.headers.forEach((value, key) => {
      if (key.toLowerCase() === 'transfer-encoding') return;
      respHeaders[key] = value;
    });

    res.writeHead(resp.status, respHeaders);
    res.end(Buffer.from(await resp.arrayBuffer()));
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(e) }));
  }
});

server.listen(listenPort, listenHost, () => {
  console.error(`[wrangler-proxy] listening on http://${listenHost}:${listenPort} -> ${targetBase}`);
});

