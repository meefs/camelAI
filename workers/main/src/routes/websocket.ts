/**
 * Remaining non-Agent WebSocket helpers.
 */

import type { RouteContext } from '../types.js';
import { requireWorkspaceAccess } from '../helpers/auth.js';
import { text } from '../helpers/response.js';
import {
  formatAttributedUserMessage,
  type ChatAuthorIdentity,
} from '../chat-author-attribution.js';
import { injectFileSafetyMessage } from '../file-safety.js';
import { applyMentionContext } from '../mention-context.js';
import { WorkspaceFilesystemClient } from '../workspace-filesystem-do.js';

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
  let contentWithMentionContext = safeContent;

  if (safeContent.includes('@')) {
    try {
      const workspaceStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
      const workspaceFs = new WorkspaceFilesystemClient(env, workspaceId);
      const [integrations, projects] = await Promise.all([
        Promise.resolve().then(() => workspaceStub.getIntegrations()).catch(() => []),
        Promise.resolve().then(() => workspaceFs.listProjects()).catch(() => []),
      ]);
      contentWithMentionContext = applyMentionContext(
        safeContent,
        { integrations, projects },
      ).content;
    } catch {
      // Mention context is best-effort.
    }
  }

  return formatAttributedUserMessage(contentWithMentionContext, author);
}
