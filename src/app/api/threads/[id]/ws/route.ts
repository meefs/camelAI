import { getCloudflareContext } from '@opennextjs/cloudflare';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface Env {
  CHAT_SERVICE: { fetch: (request: Request) => Promise<Response> };
}

export async function GET(request: Request, { params }: RouteContext) {
  const { id } = await params;

  // Check for WebSocket upgrade
  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('Expected WebSocket', { status: 426 });
  }

  try {
    const { env } = await getCloudflareContext() as unknown as { env: Env };

    // Forward the WebSocket upgrade to chat-do service
    const wsUrl = new URL(`/ws/${id}`, 'http://internal');
    const wsRequest = new Request(wsUrl.toString(), {
      headers: request.headers,
    });

    return env.CHAT_SERVICE.fetch(wsRequest);
  } catch (e) {
    return new Response(`WebSocket error: ${e}`, { status: 500 });
  }
}
