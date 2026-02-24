/**
 * WebSocket routes for chat
 */

import type { RouteContext } from '../types.js';
import { requireSession } from '../helpers/auth.js';
import { getThreadStub } from '../helpers/stubs.js';
import { text } from '../helpers/response.js';

export async function handleChatWebSocket({ req, env, url }: RouteContext): Promise<Response> {
  const threadId = url.searchParams.get('threadId');
  if (!threadId) {
    return text('Missing threadId', 400);
  }

  // 1. Session lookup (KV) — session is server-created and trusted
  const auth = await requireSession(req, env);
  if ('error' in auth) return auth.error;

  const { session } = auth;
  const { org_id: orgId, workspace_id: workspaceId } = session;
  if (!orgId) return text('No organization selected', 400);
  if (!workspaceId) return text('No workspace selected', 400);

  // 2. Forward directly to ChatThreadDO — skip WorkspaceDO/OrgDO validation hops.
  //    Session data is trusted (set server-side at login), same trust model as SSR loaders.
  const headers = new Headers(req.headers);
  headers.delete('X-Chiridion-User-Name');
  headers.delete('X-Chiridion-User-Email');
  if (session.user_name) headers.set('X-Chiridion-User-Name', session.user_name);
  if (session.user_email) headers.set('X-Chiridion-User-Email', session.user_email);

  const doUrl = new URL('https://chat-thread/chat');
  doUrl.searchParams.set('threadId', threadId);
  doUrl.searchParams.set('workspaceId', workspaceId);
  doUrl.searchParams.set('orgId', orgId);

  const modifiedReq = new Request(doUrl.toString(), { method: 'GET', headers });
  return getThreadStub(env, threadId).fetch(modifiedReq);
}
