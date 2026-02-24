/**
 * WebSocket routes for chat
 */

import type { RouteContext } from '../types.js';
import { requireSession } from '../helpers/auth.js';
import { getUserStub, getWorkspaceStub, getThreadStub } from '../helpers/stubs.js';
import { text } from '../helpers/response.js';

export async function handleChatWebSocket({ req, env, url }: RouteContext): Promise<Response> {
  const threadIdFromUrl = url.searchParams.get('threadId');
  if (!threadIdFromUrl) {
    return text('Missing threadId', 400);
  }

  // 1. Session lookup (KV)
  const auth = await requireSession(req, env);
  if ('error' in auth) return auth.error;

  const { session } = auth;
  const { org_id: orgId, workspace_id: workspaceId, user_id: userId } = session;
  if (!orgId) return text('No organization selected', 400);
  if (!workspaceId) return text('No workspace selected', 400);

  // 2. Run validateChatThreadAccess + getProfile in parallel
  //    Both are independent DO calls that only need data from the session.
  const [validation, profile] = await Promise.all([
    getWorkspaceStub(env, workspaceId)
      .validateChatThreadAccess(userId, orgId, threadIdFromUrl)
      .catch(() => null),
    getUserStub(env, userId)
      .getProfile()
      .catch(() => null),
  ]);

  if (!validation?.ok) {
    if (validation && !validation.ok) {
      switch (validation.reason) {
        case 'workspace_not_found':
        case 'org_not_found':
          return text('Workspace not found', 404);
        case 'thread_not_found':
          return text('Thread not found', 404);
        default:
          return text('Forbidden', 403);
      }
    }
    return text('Forbidden', 403);
  }

  // 3. Forward to ChatThreadDO with user headers
  const headers = new Headers(req.headers);
  headers.delete('X-Chiridion-User-Name');
  headers.delete('X-Chiridion-User-Email');
  if (profile?.name) headers.set('X-Chiridion-User-Name', profile.name);
  if (profile?.email) headers.set('X-Chiridion-User-Email', profile.email);

  const doUrl = new URL('https://chat-thread/chat');
  doUrl.searchParams.set('threadId', validation.threadId);
  doUrl.searchParams.set('workspaceId', validation.workspaceId);
  doUrl.searchParams.set('orgId', validation.orgId);

  const modifiedReq = new Request(doUrl.toString(), { method: 'GET', headers });
  return getThreadStub(env, validation.threadId).fetch(modifiedReq);
}
