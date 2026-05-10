import type { AppLoadContext } from "react-router";
import { getEnv } from "@/lib/cloudflare.server";
import * as chatDO from "@/lib/chat-do.server";
import type { ContentBlock, Message } from "@/types";
import {
  WorkspaceContainer,
  type WorkspaceContainerEnv,
} from "../../workers/main/src/workspace-container";
import { parseMessageContent } from "./chat-message-content";

interface ReadThreadMessagesOptions {
  workspaceId: string;
  orgId: string;
  threadId: string;
  skipBanCheck?: boolean;
}

export async function readThreadMessages(
  context: AppLoadContext,
  {
    workspaceId,
    orgId,
    threadId,
    skipBanCheck = false,
  }: ReadThreadMessagesOptions,
): Promise<Message[]> {
  const env = getEnv(context);
  const container = new WorkspaceContainer(
    env as unknown as WorkspaceContainerEnv,
    workspaceId,
    orgId,
  );
  const legacyClaudeSessionId = await chatDO.getLegacyClaudeSessionId(
    context,
    threadId,
  );
  const codexSessionId = await chatDO.getCodexSessionId(context, threadId);
  const streamResult = await container.readThreadMessagesStream(threadId, {
    claudeSessionId: legacyClaudeSessionId,
    codexSessionId,
    skipBanCheck,
  });
  if (!streamResult.success || !streamResult.response) {
    throw new Error(streamResult.error || "Failed to load messages");
  }

  const payload = (await streamResult.response.json()) as {
    messages?: unknown;
  };
  const rawMessages = Array.isArray(payload.messages) ? payload.messages : [];

  return rawMessages.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    const messageId = typeof item.id === "string" ? item.id : null;
    const role =
      item.role === "assistant"
        ? "assistant"
        : item.role === "user"
          ? "user"
          : null;
    const createdAt =
      typeof item.created_at === "number" ? item.created_at : null;
    if (!messageId || !role || createdAt === null) return [];

    return [
      {
        id: messageId,
        thread_id:
          typeof item.thread_id === "string" ? item.thread_id : threadId,
        role,
        content: parseMessageContent(
          (item.content ?? "") as string | ContentBlock[],
        ),
        created_at: createdAt,
        forkEntryId:
          typeof item.forkEntryId === "string" && item.forkEntryId.trim()
            ? item.forkEntryId.trim()
            : undefined,
        isMeta: item.isMeta === true,
        sourceToolUseID:
          typeof item.sourceToolUseID === "string"
            ? item.sourceToolUseID
            : undefined,
        isCompactSummary: item.isCompactSummary === true,
      },
    ];
  });
}
