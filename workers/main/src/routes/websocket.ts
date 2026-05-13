/**
 * WebSocket routes for chat
 */

import type { RouteContext } from '../types.js';
import { requireChatWebSocketAccess, requireWorkspaceAccess } from '../helpers/auth.js';
import { getThreadStub } from '../helpers/stubs.js';
import { text } from '../helpers/response.js';
import {
  formatAttributedUserMessage,
  type ChatAuthorIdentity,
} from '../chat-author-attribution.js';
import { injectFileSafetyMessage } from '../file-safety.js';
import { applyConnectionMentionContext } from '../connection-mention-context.js';

export async function handleChatWebSocket({ req, env, url }: RouteContext): Promise<Response> {
  const threadIdFromUrl = url.searchParams.get('threadId');
  if (!threadIdFromUrl) {
    return text('Missing threadId', 400);
  }

  const access = await requireChatWebSocketAccess(req, env, threadIdFromUrl);
  if ('error' in access) return access.error;

  const { session, orgId, workspaceId, threadId, userId } = access;

  const headers = new Headers(req.headers);
  headers.delete('X-Chiridion-User-Id');
  headers.delete('X-Chiridion-User-Name');
  headers.delete('X-Chiridion-User-Email');
  headers.set('X-Chiridion-User-Id', userId);
  if (session.user_name) headers.set('X-Chiridion-User-Name', session.user_name);
  if (session.user_email) headers.set('X-Chiridion-User-Email', session.user_email);

  const doUrl = new URL('https://chat-thread/chat');
  doUrl.searchParams.set('threadId', threadId);
  doUrl.searchParams.set('workspaceId', workspaceId);
  doUrl.searchParams.set('orgId', orgId);

  const modifiedReq = new Request(doUrl.toString(), { method: 'GET', headers });
  return getThreadStub(env, threadId).fetch(modifiedReq);
}

export async function handleChatRunnerWebSocket({ req, env, url }: RouteContext): Promise<Response> {
  const threadIdFromUrl = url.searchParams.get('threadId');
  if (!threadIdFromUrl) {
    return text('Missing threadId', 400);
  }

  const access = await requireChatWebSocketAccess(req, env, threadIdFromUrl);
  if ('error' in access) return access.error;

  const { session, orgId, workspaceId, threadId, userId } = access;

  const headers = new Headers(req.headers);
  headers.delete('X-Chiridion-User-Id');
  headers.delete('X-Chiridion-User-Name');
  headers.delete('X-Chiridion-User-Email');
  headers.set('X-Chiridion-User-Id', userId);
  if (session.user_name) headers.set('X-Chiridion-User-Name', session.user_name);
  if (session.user_email) headers.set('X-Chiridion-User-Email', session.user_email);

  const doUrl = new URL('https://chat-thread/runner');
  doUrl.searchParams.set('threadId', threadId);
  doUrl.searchParams.set('workspaceId', workspaceId);
  doUrl.searchParams.set('orgId', orgId);

  const modifiedReq = new Request(doUrl.toString(), { method: 'GET', headers });
  return getThreadStub(env, threadId).fetch(modifiedReq);
}

export async function handleWorkspaceStatusWebSocket({
  req,
  env,
  match,
}: RouteContext): Promise<Response> {
  const workspaceIdFromPath = decodeURIComponent(match[1] ?? '').trim();
  if (!workspaceIdFromPath) {
    return text('Missing workspaceId', 400);
  }

  const access = await requireWorkspaceAccess(req, env);
  if ('error' in access) return access.error;
  if (access.workspaceId !== workspaceIdFromPath) {
    return text('Forbidden', 403);
  }

  const doUrl = new URL('https://workspace/status');
  const modifiedReq = new Request(doUrl.toString(), {
    method: 'GET',
    headers: req.headers,
  });
  return access.wsStub.fetch(modifiedReq);
}

export async function buildRunnerUserMessageContent(
  env: RouteContext['env'],
  workspaceId: string,
  rawContent: string,
  author?: ChatAuthorIdentity | null,
): Promise<string> {
  const safeContent = injectFileSafetyMessage(rawContent);
  let contentWithConnectionContext = safeContent;

  if (safeContent.includes('@')) {
    try {
      const workspaceStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
      const integrations = await workspaceStub.getIntegrations();
      contentWithConnectionContext = applyConnectionMentionContext(
        safeContent,
        integrations,
      ).content;
    } catch (error) {
      console.error('[chat websocket] apply connection mentions failed', error);
    }
  }

  return formatAttributedUserMessage(contentWithConnectionContext, author);
}
