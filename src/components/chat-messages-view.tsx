import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, Dispatch, RefObject, SetStateAction } from "react";
import type { AtMentionEntity, LlmModel, LlmProvider, Message } from "@/types";
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
} satisfies CSSProperties;

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

type MessageGroup = {
  key: string;
  messages: Message[];
  isAssistantTurn: boolean;
  actionMessageId: string;
  turnKey?: string;
  copyContent?: string;
  precedingUserMessageId?: string;
  stepCount: number;
  fallbackDurationMs: number;
  traceMessage: Message | null;
  finalOutputMessage: Message | null;
};

function haveSameMessageRefs(left: Message[], right: Message[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

interface ChatMessagesViewProps {
  visibleMessages: Message[];
  copyMessage: (messageId: string, content: string) => void;
  copiedMessageId: string | null;
  forkMessage?: (messageId: string, renderedMessageId?: string) => void;
  forkingMessageId?: string | null;
  runningStartedAt: number | null;
  activeTurnActionMessageId: string | null;
  isAssistantTurnActive: boolean;
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
  deferRendering?: boolean;
  showGlobalAssistantIndicator: boolean;
  messagesEndRef: RefObject<HTMLDivElement | null>;
  mentionSlugMap?: Map<string, AtMentionEntity>;
}

export const ChatMessagesView = memo(function ChatMessagesView({
  visibleMessages,
  copyMessage,
  copiedMessageId,
  forkMessage,
  forkingMessageId,
  runningStartedAt,
  activeTurnActionMessageId,
  isAssistantTurnActive,
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
  deferRendering = false,
  showGlobalAssistantIndicator,
  messagesEndRef,
  mentionSlugMap,
}: ChatMessagesViewProps) {
  const [messageTimeZone, setMessageTimeZone] = useState<string | undefined>(
    "UTC",
  );
  const messageGroupCacheRef = useRef<Map<string, MessageGroup>>(new Map());

  useEffect(() => {
    setMessageTimeZone(undefined);
  }, []);

  const messageGroups = useMemo(() => {
    const groups: MessageGroup[] = [];
    const previousGroups = messageGroupCacheRef.current;
    const nextGroups = new Map<string, MessageGroup>();
    let lastDirectUserMessage: Message | undefined;
    let lastFreshPromptUserMessageId: string | undefined;

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
      const key = `${isAssistantTurn ? "assistant" : "message"}-${firstMessage.id}`;
      const turnKey = isAssistantTurn
        ? (lastFreshPromptUserMessageId ?? actionMessage.id)
        : undefined;
      const previousGroup = previousGroups.get(key);
      if (
        previousGroup &&
        previousGroup.isAssistantTurn === isAssistantTurn &&
        previousGroup.actionMessageId === actionMessage.id &&
        previousGroup.turnKey === turnKey &&
        previousGroup.precedingUserMessageId === lastDirectUserMessage?.id &&
        haveSameMessageRefs(previousGroup.messages, messages)
      ) {
        groups.push(previousGroup);
        nextGroups.set(key, previousGroup);
        if (!isAssistantTurn && isDirectUserMessage(firstMessage)) {
          lastDirectUserMessage = firstMessage;
          if (firstMessage.sentDuringStreaming !== true) {
            lastFreshPromptUserMessageId = firstMessage.id;
          }
        }
        index = endIndex;
        continue;
      }

      const copyContent = isAssistantTurn
        ? messages
            .map((message) => userFacingContentToString(message.content))
            .filter(Boolean)
            .join("\n\n")
        : undefined;
      const precedingUserMessage = isAssistantTurn
        ? lastDirectUserMessage
        : undefined;
      const precedingUserMessageId = precedingUserMessage?.id;
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

      const group: MessageGroup = {
        key,
        messages,
        isAssistantTurn,
        actionMessageId: actionMessage.id,
        turnKey,
        copyContent,
        precedingUserMessageId,
        stepCount,
        fallbackDurationMs,
        traceMessage,
        finalOutputMessage,
      };
      groups.push(group);
      nextGroups.set(key, group);

      if (!isAssistantTurn && isDirectUserMessage(firstMessage)) {
        lastDirectUserMessage = firstMessage;
        if (firstMessage.sentDuringStreaming !== true) {
          lastFreshPromptUserMessageId = firstMessage.id;
        }
      }

      index = endIndex;
    }

    messageGroupCacheRef.current = nextGroups;
    return groups;
  }, [visibleMessages]);

  const lastGroupIndexByTurnKey = useMemo(() => {
    const map = new Map<string, number>();
    messageGroups.forEach((group, index) => {
      if (group.isAssistantTurn && group.turnKey) {
        map.set(group.turnKey, index);
      }
    });
    return map;
  }, [messageGroups]);

  const activeTurnKey = useMemo(
    () =>
      messageGroups.find(
        (group) =>
          group.isAssistantTurn &&
          group.actionMessageId === activeTurnActionMessageId,
      )?.turnKey ?? null,
    [activeTurnActionMessageId, messageGroups],
  );

  const completedTurnKey = useMemo(
    () =>
      freshlyCompletedTurnId != null
        ? messageGroups.find(
            (group) =>
              group.isAssistantTurn &&
              group.actionMessageId === freshlyCompletedTurnId,
          )?.turnKey ?? null
        : null,
    [freshlyCompletedTurnId, messageGroups],
  );

  if (deferRendering) {
    return (
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
        <div ref={messagesEndRef} />
      </>
    );
  }

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

      {messageGroups.map((messageGroup, index) => {
        const isActiveTurn =
          messageGroup.isAssistantTurn &&
          messageGroup.actionMessageId === activeTurnActionMessageId;
        const isFinalChunkOfTurn =
          messageGroup.isAssistantTurn &&
          messageGroup.turnKey != null &&
          lastGroupIndexByTurnKey.get(messageGroup.turnKey) === index;
        const isDeferredCurrentTurnChunk =
          isAssistantTurnActive &&
          activeTurnKey != null &&
          messageGroup.isAssistantTurn &&
          !isActiveTurn &&
          messageGroup.turnKey === activeTurnKey;
        const shouldShowSummary =
          messageGroup.isAssistantTurn &&
          !isActiveTurn &&
          !isDeferredCurrentTurnChunk &&
          messageGroup.stepCount > 0;

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
          const isTurnActionMessage = msg.id === messageGroup.actionMessageId;
          const renderMode = options?.renderMode ?? "full";

          return (
            <div
              key={`${msg.id}-${renderMode}`}
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
          const renderFinalAnswer =
            isFinalChunkOfTurn && finalOutputMessage !== null;
          const showDuration = renderFinalAnswer && durationMs >= 1000;
          const showSeparator = renderFinalAnswer;

          return (
            <div
              key={messageGroup.key}
              style={MESSAGE_LAYOUT_CONTAINMENT_STYLE}
              className="group/turn"
            >
              <div
                data-message-id={
                  !renderFinalAnswer ? messageGroup.actionMessageId : undefined
                }
                style={MESSAGE_LAYOUT_CONTAINMENT_STYLE}
              >
                <TurnSummaryBar
                  durationMs={durationMs}
                  stepCount={messageGroup.stepCount}
                  showDuration={showDuration}
                  showSeparator={showSeparator}
                  animateOnMount={
                    completedTurnKey != null &&
                    messageGroup.turnKey === completedTurnKey
                  }
                  onAutoCollapseScheduled={
                    onFreshlyCompletedTurnAnimationScheduled
                  }
                >
                  {renderFinalAnswer
                    ? (messageGroup.traceMessage
                        ? renderMessage(messageGroup.traceMessage, {
                            renderMode: "full",
                            showActionRow: false,
                            omitMessageAnchor: true,
                          })
                        : null)
                    : messageGroup.messages.map((msg) =>
                        renderMessage(msg, {
                          renderMode: "full",
                          showActionRow: false,
                          omitMessageAnchor: true,
                        }),
                      )}
                </TurnSummaryBar>
              </div>
              {renderFinalAnswer && finalOutputMessage ? (
                <div
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

      {isCompacting && <CompactingIndicator />}

      {showGlobalAssistantIndicator && !isCompacting && (
        <ChatThreadWorkingIndicator startedAt={runningStartedAt} />
      )}
      <div ref={messagesEndRef} />
    </>
  );
});
