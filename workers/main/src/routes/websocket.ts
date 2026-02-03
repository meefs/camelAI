/**
 * WebSocket routes for chat and thread preview
 */

import type { RouteContext } from '../types.js';
import { THREAD_TOKEN_HEADER } from '../types.js';
import { handleWebSocketUpgrade } from '../workspace-container.js';
import { createSignedToken } from '../signed-tokens.js';
import { requireSession, requireWorkspaceAccess } from '../helpers/auth.js';
import { getUserStub, getWorkspaceStub, getOrgStub, getThreadStub } from '../helpers/stubs.js';
import { text } from '../helpers/response.js';

export async function handleThreadWebSocket({ req, env, match }: RouteContext): Promise<Response> {
  const threadId = match[1];

  const auth = await requireSession(req, env);
  if ('error' in auth) return auth.error;

  const { session } = auth;
  if (!session.workspace_id) return text('No workspace selected', 400);

  const wsStub = getWorkspaceStub(env, session.workspace_id);
  const wsInfo = await wsStub.getInfo();
  if (!wsInfo || wsInfo.archived) return text('Workspace not found', 404);

  const orgStub = getOrgStub(env, wsInfo.org_id);
  const thread = await orgStub.getThread(threadId);
  if (!thread || thread.workspace_id !== session.workspace_id) {
    return text('Thread not found', 404);
  }

  return getThreadStub(env, threadId).fetch(req);
}

export async function handleChatWebSocket({ req, env, url }: RouteContext): Promise<Response> {
  const access = await requireWorkspaceAccess(req, env);
  if ('error' in access) return access.error;

  const { orgId, workspaceId, userId, wsStub, orgStub } = access;

  // Get user profile
  const profile = await getUserStub(env, userId).getProfile();
  if (!profile) return text('User not found', 404);

  // Validate thread if provided
  const threadIdFromUrl = url.searchParams.get('threadId');
  let validatedThreadId: string | null = null;

  if (threadIdFromUrl) {
    const wsInfo = await wsStub.getInfo();
    if (wsInfo && !wsInfo.archived) {
      const thread = await orgStub.getThread(threadIdFromUrl);
      if (thread && thread.workspace_id === workspaceId) {
        validatedThreadId = threadIdFromUrl;
      }
    }
  }

  // Get org slug for deploy tokens
  const orgInfo = await orgStub.getInfo();
  const orgSlug = orgInfo?.slug || `org-${orgId.slice(0, 3)}`;

  // Build request with user info headers
  const headers = new Headers(req.headers);
  headers.delete('X-Chiridion-User-Name');
  headers.delete('X-Chiridion-User-Email');
  if (profile.name) headers.set('X-Chiridion-User-Name', profile.name);
  headers.set('X-Chiridion-User-Email', profile.email);

  if (validatedThreadId) {
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
  }

  const modifiedReq = new Request(req.url, { method: req.method, headers, body: req.body });
  return handleWebSocketUpgrade(modifiedReq, env, workspaceId, orgId);
}
