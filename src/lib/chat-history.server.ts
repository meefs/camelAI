import type { AppLoadContext } from "react-router";
import { getEnv } from "@/lib/cloudflare.server";
import * as chatDO from "@/lib/chat-do.server";
import type { ContentBlock, Message } from "@/types";
import {
  WorkspaceContainer,
  type WorkspaceContainerEnv,
} from "../../workers/main/src/workspace-container";
import {
  recordErrorEvent,
  recordObservabilityEvent,
} from "../../workers/main/src/observability";
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
  const startedAt = Date.now();
  try {
    const piMessages = await chatDO.getPiCoreMessages(context, threadId);
    if (piMessages.length > 0) {
      recordObservabilityEvent(env, {
        event: "chat_history_read",
        component: "react_router",
        operation: "read_thread_messages",
        status: "pi_core_hit",
        threadId,
        workspaceId,
        orgId,
        count: piMessages.length,
        durationMs: Date.now() - startedAt,
      });
      return piMessages as Message[];
    }

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

    const messages: Message[] = rawMessages.flatMap((raw): Message[] => {
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

    recordObservabilityEvent(env, {
      event: "chat_history_read",
      component: "react_router",
      operation: "read_thread_messages",
      status: messages.length > 0 ? "legacy_hit" : "empty",
      threadId,
      workspaceId,
      orgId,
      count: messages.length,
      size: rawMessages.length,
      durationMs: Date.now() - startedAt,
    });
    return messages;
  } catch (error) {
    recordErrorEvent(env, {
      event: "chat_history_read_exception",
      component: "react_router",
      operation: "read_thread_messages",
      status: "exception",
      threadId,
      workspaceId,
      orgId,
      durationMs: Date.now() - startedAt,
      error,
    });
    throw error;
  }
}
