/**
 * Shared inbound-chat message shaping (mention context, file-safety, author
 * attribution) for non-browser senders — Slack/Discord/Telegram/email ingress.
 *
 * Named for the WebSocket route that used to live here; the transport itself is
 * HTTP+SSE now (routes/status-stream.ts, index.ts chat transport).
 */

import type { RouteContext } from '../types.js';
import {
  formatAttributedUserMessage,
  type ChatAuthorIdentity,
} from '../chat-author-attribution.js';
import { injectFileSafetyMessage } from '../file-safety.js';
import { applyMentionContext } from '../mention-context.js';
import { WorkspaceFilesystemClient } from '../workspace-filesystem-do.js';

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
