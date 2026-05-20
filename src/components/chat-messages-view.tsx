import { memo, useMemo } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { ChatHarness, Integration, LlmProvider, Message } from "@/types";
import { ChatErrorNotice } from "@/components/chat-error-notice";
import { CompactingIndicator } from "@/components/compacting-indicator";
import { LoadingDots } from "@/components/loading-dots";
import {
  MessageBubble,
  isInterruptMessage,
  parseLocalCommandStdout,
  parseSlashCommand,
  userFacingContentToString,
} from "@/components/message-bubble";
import { Skeleton } from "@/components/ui/skeleton";
import type { ChatApiErrorPresentation } from "@/lib/chat-api-errors";
import { cn } from "@/lib/utils";

const MESSAGE_LAYOUT_CONTAINMENT_STYLE = {
  contain: "layout paint style",
} as const;

/**
 * True when the message was directly authored by the user — not a
 * system-generated message that happens to carry `role: 'user'`
 * (e.g. compact summaries, meta/skill-sheet messages, interrupts,
 * slash commands, local-command-stdout).
 */
function isDirectUserMessage(msg: Message): boolean {
  if (msg.role !== "user" || msg.isCompactSummary) return false;
  if (isInterruptMessage(msg.content)) return false;
  if (parseSlashCommand(msg.content)) return false;
  if (parseLocalCommandStdout(msg.content)) return false;
  return true;
}

interface ChatMessagesViewProps {
  visibleMessages: Message[];
  lastUserMessageId: string | null;
  lastMessageId: string | null;
  isAwaitingAssistant: boolean;
  isLastMessageAssistantLike: boolean;
  copyMessage: (messageId: string, content: string) => void;
  copiedMessageId: string | null;
  forkMessage?: (messageId: string, renderedMessageId?: string) => void;
  forkingMessageId?: string | null;
  assistantTurnActive: boolean;
  activeAssistantMessageId: string | null;
  skillSheetsByToolId: Map<string, string>;
  error: ChatApiErrorPresentation | null;
  setError: Dispatch<SetStateAction<ChatApiErrorPresentation | null>>;
  llmProvider?: LlmProvider | null;
  threadProvider: ChatHarness;
  isCompacting: boolean;
  compactingPriorMessageId: string | null;
  isLoadingMessages: boolean;
  showGlobalAssistantIndicator: boolean;
  shouldRenderSpacer: boolean;
  lastUserMessageRef: RefObject<HTMLDivElement | null>;
  assistantMeasureRef: RefObject<HTMLDivElement | null>;
  assistantPendingMeasureRef: RefObject<HTMLDivElement | null>;
  assistantSpacerRef: RefObject<HTMLDivElement | null>;
  messagesEndRef: RefObject<HTMLDivElement | null>;
  mentionSlugMap?: Map<string, Integration>;
}

export const ChatMessagesView = memo(function ChatMessagesView({
  visibleMessages,
  lastUserMessageId,
  lastMessageId,
  isAwaitingAssistant,
  isLastMessageAssistantLike,
  copyMessage,
  copiedMessageId,
  forkMessage,
  forkingMessageId,
  assistantTurnActive,
  activeAssistantMessageId,
  skillSheetsByToolId,
  error,
  setError,
  llmProvider,
  threadProvider,
  isCompacting,
  compactingPriorMessageId,
  isLoadingMessages,
  showGlobalAssistantIndicator,
  shouldRenderSpacer,
  lastUserMessageRef,
  assistantMeasureRef,
  assistantPendingMeasureRef,
  assistantSpacerRef,
  messagesEndRef,
  mentionSlugMap,
}: ChatMessagesViewProps) {
  const messageGroups = useMemo(() => {
    const groups: Array<{
      key: string;
      messages: Message[];
      isAssistantTurn: boolean;
      actionMessageId: string;
      copyContent?: string;
    }> = [];

    for (let index = 0; index < visibleMessages.length;) {
      const firstMessage = visibleMessages[index];
      const isAssistantTurn = firstMessage.role === "assistant";
      let endIndex = index + 1;

      if (isAssistantTurn) {
        while (
          endIndex < visibleMessages.length &&
          visibleMessages[endIndex].role === "assistant"
        ) {
          endIndex += 1;
        }
      }

      const messages = visibleMessages.slice(index, endIndex);
      const actionMessage = messages[messages.length - 1];
      const copyContent = isAssistantTurn
        ? [...messages]
            .reverse()
            .map((message) => userFacingContentToString(message.content))
            .find(Boolean) ?? ""
        : undefined;

      groups.push({
        key: `${isAssistantTurn ? "assistant" : "message"}-${firstMessage.id}`,
        messages,
        isAssistantTurn,
        actionMessageId: actionMessage.id,
        copyContent,
      });

      index = endIndex;
    }

    return groups;
  }, [visibleMessages]);

  return (
    <>
      {isLoadingMessages && visibleMessages.length === 0 && (
        <>
          <div className="mt-6 flex flex-col items-end gap-1">
            <Skeleton className="h-16 w-3/4 rounded-3xl" />
          </div>
          <div className="mt-4 flex flex-col gap-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-2/3" />
          </div>
          <div className="mt-6 flex flex-col items-end gap-1">
            <Skeleton className="h-12 w-1/2 rounded-3xl" />
          </div>
          <div className="mt-4 flex flex-col gap-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-11/12" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        </>
      )}

      {messageGroups.map((messageGroup) => (
        <div
          key={messageGroup.key}
          style={MESSAGE_LAYOUT_CONTAINMENT_STYLE}
          className={messageGroup.isAssistantTurn ? "group/turn" : undefined}
        >
          {messageGroup.messages.map((msg) => {
            const isLastUserMessage = msg.id === lastUserMessageId;
            const isLastAssistantMessage =
              !isAwaitingAssistant &&
              isLastMessageAssistantLike &&
              msg.id === lastMessageId;
            const messageRef = isLastUserMessage
              ? lastUserMessageRef
              : isLastAssistantMessage
                ? assistantMeasureRef
                : undefined;
            const isTurnActionMessage = msg.id === messageGroup.actionMessageId;

            return (
              <div
                key={msg.id}
                ref={messageRef}
                data-message-id={msg.id}
                style={MESSAGE_LAYOUT_CONTAINMENT_STYLE}
                className={cn(
                  "group",
                  isDirectUserMessage(msg) ? "mb-1 mt-6" : "",
                )}
              >
                <MessageBubble
                  message={msg}
                  onCopy={copyMessage}
                  copiedId={copiedMessageId}
                  onFork={forkMessage}
                  forkingId={forkingMessageId}
                  showStreamingIndicator={
                    assistantTurnActive && msg.id === activeAssistantMessageId
                  }
                  suppressFinalizedState={
                    isCompacting && msg.id === compactingPriorMessageId
                  }
                  showActionRow={
                    !messageGroup.isAssistantTurn || isTurnActionMessage
                  }
                  actionCopyContent={
                    messageGroup.isAssistantTurn && isTurnActionMessage
                      ? messageGroup.copyContent
                      : undefined
                  }
                  actionHoverClassName={
                    messageGroup.isAssistantTurn
                      ? "opacity-0 group-hover/turn:opacity-100 group-focus-within/turn:opacity-100 pointer-coarse:opacity-100"
                      : undefined
                  }
                  skillSheets={skillSheetsByToolId}
                  mentionSlugMap={mentionSlugMap}
                  llmProvider={llmProvider}
                  threadProvider={threadProvider}
                />
              </div>
            );
          })}
        </div>
      ))}

      {error ? (
        <ChatErrorNotice error={error} onDismiss={() => setError(null)} />
      ) : null}

      {isCompacting && (
        <div ref={assistantPendingMeasureRef}>
          <CompactingIndicator />
        </div>
      )}

      {showGlobalAssistantIndicator && !isCompacting && (
        <div ref={assistantPendingMeasureRef}>
          <LoadingDots />
        </div>
      )}
      {shouldRenderSpacer ? (
        <div className="flex flex-col">
          <div
            ref={assistantSpacerRef}
            aria-hidden="true"
            className="pointer-events-none w-full shrink-0"
          />
          <div ref={messagesEndRef} />
        </div>
      ) : (
        <div ref={messagesEndRef} />
      )}
    </>
  );
});
