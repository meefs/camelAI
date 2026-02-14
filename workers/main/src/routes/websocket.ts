/**
 * WebSocket routes for chat
 */

import type { RouteContext } from '../types.js';
import { requireChatWebSocketAccess } from '../helpers/auth.js';
import { getUserStub, getThreadStub } from '../helpers/stubs.js';
import { text } from '../helpers/response.js';

export async function handleChatWebSocket({ req, env, url }: RouteContext): Promise<Response> {
  const threadIdFromUrl = url.searchParams.get('threadId');
  if (!threadIdFromUrl) {
    return text('Missing threadId', 400);
  }

  const access = await requireChatWebSocketAccess(req, env, threadIdFromUrl);
  if ('error' in access) return access.error;

  const { orgId, workspaceId, userId, threadId } = access;

  // Get user profile
  const profile = await getUserStub(env, userId).getProfile();
  if (!profile) return text('User not found', 404);

  // Build request with user info headers
  const headers = new Headers(req.headers);
  headers.delete('X-Chiridion-User-Name');
  headers.delete('X-Chiridion-User-Email');
  if (profile.name) headers.set('X-Chiridion-User-Name', profile.name);
  headers.set('X-Chiridion-User-Email', profile.email);

  const doUrl = new URL('https://chat-thread/chat');
  doUrl.searchParams.set('threadId', threadId);
  doUrl.searchParams.set('workspaceId', workspaceId);
  doUrl.searchParams.set('orgId', orgId);

  const modifiedReq = new Request(doUrl.toString(), { method: 'GET', headers });
  return getThreadStub(env, threadId).fetch(modifiedReq);
}
