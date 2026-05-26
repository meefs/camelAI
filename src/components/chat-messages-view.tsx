import { memo, useEffect, useMemo, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { Integration, LlmModel, LlmProvider, Message } from "@/types";
import { ChatErrorNotice } from "@/components/chat-error-notice";
import { ChatThreadWorkingIndicator } from "@/components/chat-thread-working-indicator";
import { CompactingIndicator } from "@/components/compacting-indicator";
import {
  MessageBubble,
  isInterruptMessage,
  parseLocalCommandStdout,
  parseSlashCommand,
  userFacingContentToString,
} from "@/components/message-bubble";
import { TurnSummaryBar } from "@/components/turn-summary-bar";
import { Skeleton } from "@/components/ui/skeleton";
import type { ChatApiErrorPresentation } from "@/lib/chat-api-errors";
import {
  buildFinalOutputMessageView,
  buildTraceMessageView,
  countTurnSteps,
  type MessageRenderMode,
} from "@/lib/turn-utils";
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
  runningStartedAt: number | null;
  activeTurnActionMessageId: string | null;
  completedTurns: Map<string, { durationMs: number; completedAtMs: number }>;
  freshlyCompletedTurnId: string | null;
  onFreshlyCompletedTurnAnimationScheduled: () => void;
  skillSheetsByToolId: Map<string, string>;
  error: ChatApiErrorPresentation | null;
  setError: Dispatch<SetStateAction<ChatApiErrorPresentation | null>>;
  llmProvider?: LlmProvider | null;
  threadModel?: LlmModel | null;
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
  runningStartedAt,
  activeTurnActionMessageId,
  completedTurns,
  freshlyCompletedTurnId,
  onFreshlyCompletedTurnAnimationScheduled,
  skillSheetsByToolId,
  error,
  setError,
  llmProvider,
  threadModel,
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
  const [messageTimeZone, setMessageTimeZone] = useState<string | undefined>(
    "UTC",
  );

  useEffect(() => {
    setMessageTimeZone(undefined);
  }, []);

  const messageGroups = useMemo(() => {
    const groups: Array<{
      key: string;
      messages: Message[];
      isAssistantTurn: boolean;
      actionMessageId: string;
      copyContent?: string;
      precedingUserMessageId?: string;
      stepCount: number;
      fallbackDurationMs: number;
      traceMessage: Message | null;
      finalOutputMessage: Message | null;
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
        ? messages
            .map((message) => userFacingContentToString(message.content))
            .filter(Boolean)
            .join("\n\n")
        : undefined;
      let precedingUserMessage: Message | undefined;
      let precedingUserMessageId: string | undefined;
      if (isAssistantTurn) {
        for (let previous = index - 1; previous >= 0; previous -= 1) {
          const candidate = visibleMessages[previous];
          if (isDirectUserMessage(candidate)) {
            precedingUserMessage = candidate;
            precedingUserMessageId = candidate.id;
            break;
          }
        }
      }
      const stepCount = isAssistantTurn ? countTurnSteps(messages) : 0;
      const fallbackDurationMs =
        isAssistantTurn && precedingUserMessage
          ? Math.max(0, actionMessage.created_at - precedingUserMessage.created_at)
          : 0;
      const traceMessage = isAssistantTurn
        ? buildTraceMessageView(messages, actionMessage.id)
        : null;
      const finalOutputMessage = isAssistantTurn
        ? buildFinalOutputMessageView(messages, actionMessage.id)
        : null;

      groups.push({
        key: `${isAssistantTurn ? "assistant" : "message"}-${firstMessage.id}`,
        messages,
        isAssistantTurn,
        actionMessageId: actionMessage.id,
        copyContent,
        precedingUserMessageId,
        stepCount,
        fallbackDurationMs,
        traceMessage,
        finalOutputMessage,
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

      {messageGroups.map((messageGroup) => {
        const isActiveTurn =
          messageGroup.isAssistantTurn &&
          messageGroup.actionMessageId === activeTurnActionMessageId;
        const shouldShowSummary =
          messageGroup.isAssistantTurn && !isActiveTurn && messageGroup.stepCount > 0;

        const renderMessage = (
          msg: Message,
          options?: {
            renderMode?: MessageRenderMode;
            showActionRow?: boolean;
            actionCopyContent?: string;
            actionHoverClassName?: string;
            omitMessageAnchor?: boolean;
          },
        ) => {
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
          const renderMode = options?.renderMode ?? "full";

          return (
            <div
              key={`${msg.id}-${renderMode}`}
              ref={options?.omitMessageAnchor ? undefined : messageRef}
              data-message-id={options?.omitMessageAnchor ? undefined : msg.id}
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
                suppressFinalizedState={
                  isCompacting && msg.id === compactingPriorMessageId
                }
                showActionRow={
                  options?.showActionRow ??
                  (!messageGroup.isAssistantTurn || isTurnActionMessage)
                }
                actionCopyContent={
                  options?.actionCopyContent ??
                  (messageGroup.isAssistantTurn && isTurnActionMessage
                    ? messageGroup.copyContent
                    : undefined)
                }
                actionHoverClassName={
                  options?.actionHoverClassName ??
                  (messageGroup.isAssistantTurn
                    ? "opacity-0 group-hover/turn:opacity-100 group-focus-within/turn:opacity-100 pointer-coarse:opacity-100"
                    : undefined)
                }
                renderMode={renderMode}
                skillSheets={skillSheetsByToolId}
                mentionSlugMap={mentionSlugMap}
                llmProvider={llmProvider}
                threadModel={threadModel}
                messageTimeZone={messageTimeZone}
              />
            </div>
          );
        };

        if (shouldShowSummary) {
          const completed = completedTurns.get(messageGroup.actionMessageId);
          const durationMs =
            completed?.durationMs ?? messageGroup.fallbackDurationMs;
          const finalOutputMessage = messageGroup.finalOutputMessage;
          const isLastAssistantMessage =
            !isAwaitingAssistant &&
            isLastMessageAssistantLike &&
            messageGroup.actionMessageId === lastMessageId;
          const finalMessageRef =
            finalOutputMessage && isLastAssistantMessage
              ? assistantMeasureRef
              : undefined;
          const summaryMessageRef =
            !finalOutputMessage && isLastAssistantMessage
              ? assistantMeasureRef
              : undefined;

          return (
            <div
              key={messageGroup.key}
              style={MESSAGE_LAYOUT_CONTAINMENT_STYLE}
              className="group/turn"
            >
              <div
                ref={summaryMessageRef}
                data-message-id={
                  !finalOutputMessage ? messageGroup.actionMessageId : undefined
                }
                style={MESSAGE_LAYOUT_CONTAINMENT_STYLE}
              >
                <TurnSummaryBar
                  durationMs={durationMs}
                  stepCount={messageGroup.stepCount}
                  animateOnMount={
                    messageGroup.actionMessageId === freshlyCompletedTurnId
                  }
                  onAutoCollapseScheduled={
                    onFreshlyCompletedTurnAnimationScheduled
                  }
                >
                  {messageGroup.traceMessage
                    ? renderMessage(messageGroup.traceMessage, {
                        renderMode: "full",
                        showActionRow: false,
                        omitMessageAnchor: true,
                      })
                    : null}
                </TurnSummaryBar>
              </div>
              {finalOutputMessage ? (
                <div
                  ref={finalMessageRef}
                  data-message-id={finalOutputMessage.id}
                  style={MESSAGE_LAYOUT_CONTAINMENT_STYLE}
                  className="group"
                >
                  <MessageBubble
                    message={finalOutputMessage}
                    onCopy={copyMessage}
                    copiedId={copiedMessageId}
                    onFork={forkMessage}
                    forkingId={forkingMessageId}
                    suppressFinalizedState={
                      isCompacting &&
                      finalOutputMessage.id === compactingPriorMessageId
                    }
                    showActionRow
                    actionHoverClassName="opacity-0 group-hover/turn:opacity-100 group-focus-within/turn:opacity-100 pointer-coarse:opacity-100"
                    renderMode="final-text-only"
                    skillSheets={skillSheetsByToolId}
                    mentionSlugMap={mentionSlugMap}
                    llmProvider={llmProvider}
                    threadModel={threadModel}
                    messageTimeZone={messageTimeZone}
                  />
                </div>
              ) : null}
            </div>
          );
        }

        return (
          <div
            key={messageGroup.key}
            style={MESSAGE_LAYOUT_CONTAINMENT_STYLE}
            className={messageGroup.isAssistantTurn ? "group/turn" : undefined}
          >
            {messageGroup.messages.map((msg) => renderMessage(msg))}
          </div>
        );
      })}

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
          <ChatThreadWorkingIndicator startedAt={runningStartedAt} />
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
