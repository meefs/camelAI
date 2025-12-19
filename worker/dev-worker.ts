import { Sandbox } from '@cloudflare/sandbox';
import { ChatIndexDO, ChatThreadDO } from './durable-objects';
import { OrgDO, SessionDO, UserDO } from './auth';
export { DoRpcService } from './rpc-service.js';

export { ChatIndexDO, ChatThreadDO, SessionDO, UserDO, OrgDO };
export { Sandbox as ThreadSandbox };

interface Env {
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const wsMatch = url.pathname.match(/^\/ws\/([^\/]+)$/);

    if (wsMatch && request.headers.get('Upgrade') === 'websocket') {
      const threadId = wsMatch[1];
      const stub = env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(threadId));
      return stub.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
};
