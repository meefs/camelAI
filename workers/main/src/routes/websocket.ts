/**
 * WebSocket routes for chat
 */

import type { RouteContext } from '../types.js';
import { THREAD_TOKEN_HEADER } from '../types.js';
import { createSignedToken } from '../signed-tokens.js';
import { requireWorkspaceAccess } from '../helpers/auth.js';
import { getUserStub, getThreadStub } from '../helpers/stubs.js';
import { text } from '../helpers/response.js';

export async function handleChatWebSocket({ req, env, url }: RouteContext): Promise<Response> {
  const access = await requireWorkspaceAccess(req, env);
  if ('error' in access) return access.error;

  const { orgId, workspaceId, userId, wsStub, orgStub } = access;

  // Get user profile
  const profile = await getUserStub(env, userId).getProfile();
  if (!profile) return text('User not found', 404);

  // Validate thread - required for chat channel
  const threadIdFromUrl = url.searchParams.get('threadId');
  if (!threadIdFromUrl) {
    return text('Missing threadId', 400);
  }

  const wsInfo = await wsStub.getInfo();
  if (!wsInfo || wsInfo.archived) {
    return text('Workspace not found', 404);
  }
  const thread = await orgStub.getThread(threadIdFromUrl);
  if (!thread || thread.workspace_id !== workspaceId) {
    return text('Thread not found', 404);
  }
  const validatedThreadId = threadIdFromUrl;

  // Get org slug for deploy tokens
  const orgInfo = await orgStub.getInfo();
  const orgSlug = orgInfo?.slug || `org-${orgId.slice(0, 3)}`;

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
      thread_id: validatedThreadId,
      name: `deploy-thread-${validatedThreadId}`,
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
      thread_id: validatedThreadId,
      name: `mcp-thread-${validatedThreadId}`,
    })
  );

  const doUrl = new URL('https://chat-thread/chat');
  doUrl.searchParams.set('threadId', validatedThreadId);
  doUrl.searchParams.set('workspaceId', workspaceId);
  doUrl.searchParams.set('orgId', orgId);

  const modifiedReq = new Request(doUrl.toString(), { method: 'GET', headers });
  return getThreadStub(env, validatedThreadId).fetch(modifiedReq);
}
