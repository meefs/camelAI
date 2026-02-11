/**
 * WebSocket routes for chat
 */

import type { RouteContext } from '../types.js';
import { THREAD_TOKEN_HEADER } from '../types.js';
import { createSignedToken } from '../signed-tokens.js';
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

  const { orgId, orgSlug, workspaceId, userId, threadId } = access;

  // Get user profile
  const profile = await getUserStub(env, userId).getProfile();
  if (!profile) return text('User not found', 404);

  // Build request with user info headers
  const headers = new Headers(req.headers);
  headers.delete('X-Chiridion-User-Name');
  headers.delete('X-Chiridion-User-Email');
  if (profile.name) headers.set('X-Chiridion-User-Name', profile.name);
  headers.set('X-Chiridion-User-Email', profile.email);

  headers.set(
    THREAD_TOKEN_HEADER,
    await createSignedToken(env.TOKEN_SIGNING_SECRET, {
      org_id: orgId,
      org_slug: orgSlug,
      user_id: userId,
      scopes: ['deploy'],
      exp: Date.now() + 24 * 60 * 60 * 1000,
      workspace_id: workspaceId,
      thread_id: threadId,
      name: `deploy-thread-${threadId}`,
    })
  );
  headers.set(
    'X-Chiridion-MCP-Token',
    await createSignedToken(env.TOKEN_SIGNING_SECRET, {
      org_id: orgId,
      org_slug: orgSlug,
      user_id: userId,
      scopes: ['mcp'],
      exp: Date.now() + 24 * 60 * 60 * 1000,
      workspace_id: workspaceId,
      thread_id: threadId,
      name: `mcp-thread-${threadId}`,
    })
  );

  const doUrl = new URL('https://chat-thread/chat');
  doUrl.searchParams.set('threadId', threadId);
  doUrl.searchParams.set('workspaceId', workspaceId);
  doUrl.searchParams.set('orgId', orgId);

  const modifiedReq = new Request(doUrl.toString(), { method: 'GET', headers });
  return getThreadStub(env, threadId).fetch(modifiedReq);
}
