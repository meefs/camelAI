/**
 * Debug WebSocket route for validating Worker -> SANDBOX_HOST tunnel stability.
 */

import type { RouteContext } from '../types.js';
import { requireSession } from '../helpers/auth.js';
import { text } from '../helpers/response.js';

export async function handleDebugAzureEchoWebSocket({ req, env }: RouteContext): Promise<Response> {
  if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return text('WebSocket upgrade required', 426);
  }

  const auth = await requireSession(req, env);
  if ('error' in auth) return auth.error;

  const headers = new Headers(req.headers);
  headers.set('Upgrade', 'websocket');
  if (env.SANDBOX_PROXY_SECRET) {
    headers.set('X-Sandbox-Secret', env.SANDBOX_PROXY_SECRET);
  }

  const upstream = await env.SANDBOX_HOST.fetch('http://sandbox-host/debug/ws-echo', {
    method: 'GET',
    headers,
  });

  if (upstream.status !== 101 || !upstream.webSocket) {
    const body = await upstream.text();
    return text(`Failed to open debug azure echo websocket: ${upstream.status} ${body}`, 502);
  }

  return upstream;
}
