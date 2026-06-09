import type { AppLoadContext } from "react-router";
import { getEnv } from "@/lib/cloudflare.server";
import * as chatDO from "@/lib/chat-do.server";
import type { ContentBlock, Message } from "@/types";
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

interface LegacyThreadMessagesResponse {
  messages?: unknown;
}

function legacyWorkspaceUrl(
  orgId: string,
  workspaceId: string,
  subpath: string,
  query?: Record<string, string>,
): string {
  const url = new URL("http://legacy-workspace");
  const basePath = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  const cleanedSubpath = subpath.startsWith("/") ? subpath : `/${subpath}`;
  url.pathname = `${basePath}/v1/workspaces/${encodeURIComponent(orgId)}/${encodeURIComponent(workspaceId)}${cleanedSubpath}`;
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

async function fetchLegacyWorkspace(
  env: ReturnType<typeof getEnv>,
  url: string,
  init: RequestInit,
): Promise<Response> {
  if (!env.LEGACY_WORKSPACE_HOST) {
    throw new Error("LEGACY_WORKSPACE_HOST binding is not configured");
  }
  return env.LEGACY_WORKSPACE_HOST.fetch(new Request(url, init));
}

function parseLegacyMessages(
  rawMessages: unknown[],
  threadId: string,
): Message[] {
  return rawMessages.flatMap((raw): Message[] => {
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
        ...(item.sentDuringStreaming === true
          ? { sentDuringStreaming: true }
          : {}),
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

async function readLegacyThreadMessages(
  context: AppLoadContext,
  env: ReturnType<typeof getEnv>,
  {
    workspaceId,
    orgId,
    threadId,
    skipBanCheck,
  }: ReadThreadMessagesOptions,
): Promise<{ messages: Message[]; rawCount: number }> {
  const query: Record<string, string> = { threadId };
  const legacyClaudeSessionId = await chatDO.getLegacyClaudeSessionId(
    context,
    threadId,
  );
  if (legacyClaudeSessionId) query.claudeSessionId = legacyClaudeSessionId;
  const codexSessionId = await chatDO.getCodexSessionId(
    context,
    threadId,
  );
  if (codexSessionId) query.codexSessionId = codexSessionId;

  const response = await fetchLegacyWorkspace(
    env,
    legacyWorkspaceUrl(orgId, workspaceId, "/chat/messages", query),
    { headers: { Accept: "application/json" } },
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Failed to load legacy messages: ${response.status}`);
  }

  void skipBanCheck;
  const payload = (await response.json()) as LegacyThreadMessagesResponse;
  const rawMessages = Array.isArray(payload.messages) ? payload.messages : [];
  return {
    messages: parseLegacyMessages(rawMessages, threadId),
    rawCount: rawMessages.length,
  };
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
    const { messages: legacyMessages, rawCount: legacyRawCount } =
      await readLegacyThreadMessages(
        context,
        env,
        {
          workspaceId,
          orgId,
          threadId,
          skipBanCheck,
        },
      ).catch((error) => {
        if (
          piMessages.length > 0 ||
          !env.LEGACY_WORKSPACE_HOST
        ) {
          return { messages: [] as Message[], rawCount: 0 };
        }
        throw error;
      });

    if (legacyMessages.length > 0) {
      const hydration = await chatDO.hydratePiCoreFromParsedMessages(
        context,
        threadId,
        legacyMessages,
      ).catch((error) => {
        recordErrorEvent(env, {
          event: "chat_history_hydrate_legacy_exception",
          component: "react_router",
          operation: "hydrate_pi_core_from_legacy",
          status: "exception",
          threadId,
          workspaceId,
          orgId,
          durationMs: Date.now() - startedAt,
          error,
        });
        throw error;
      });
      const refreshedPiMessages =
        hydration?.hydrated
          ? await chatDO.getPiCoreMessages(context, threadId)
          : piMessages;
      if (refreshedPiMessages.length === 0) {
        if (hydration?.deferred) {
          recordObservabilityEvent(env, {
            event: "chat_history_read",
            component: "react_router",
            operation: "read_thread_messages",
            status: "pi_core_hydration_deferred_empty",
            threadId,
            workspaceId,
            orgId,
            count: 0,
            size: legacyRawCount,
            durationMs: Date.now() - startedAt,
          });
          return [];
        }
        throw new Error(
          `Legacy chat history for thread ${threadId} could not be hydrated into Pi core messages`,
        );
      }
      recordObservabilityEvent(env, {
        event: "chat_history_read",
        component: "react_router",
        operation: "read_thread_messages",
        status:
          hydration?.hydrated
            ? "pi_core_hydrated_hit"
            : hydration?.deferred
              ? "pi_core_hydration_deferred_hit"
            : "pi_core_already_hydrated_hit",
        threadId,
        workspaceId,
        orgId,
        count: refreshedPiMessages.length,
        size: legacyRawCount,
        durationMs: Date.now() - startedAt,
      });
      return refreshedPiMessages as Message[];
    }

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

    recordObservabilityEvent(env, {
      event: "chat_history_read",
      component: "react_router",
      operation: "read_thread_messages",
      status: "empty",
      threadId,
      workspaceId,
      orgId,
      count: 0,
      size: legacyRawCount,
      durationMs: Date.now() - startedAt,
    });
    return [];
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
