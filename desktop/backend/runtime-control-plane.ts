import { RuntimeManager } from "./runtime";
import { logDesktop } from "./log";
import type { SDKEvent } from "../../src/lib/streaming";

interface ControlPlaneEvent {
  type: string;
  error?: string;
  message?: string;
  event?: SDKEvent;
  text?: string;
}

interface ResultLikeEvent extends SDKEvent {
  errors?: string[];
  result?: string;
}

export interface StreamRuntimeChatOptions {
  runtimeManager: RuntimeManager;
  threadId: string;
  content: string;
  model: string;
  turnId: string;
  onEvent?: (event: SDKEvent) => void;
  onText: (delta: string) => void;
}

export interface StreamRuntimeChatResult {
  finalText: string;
  model: string;
}

function extractAssistantText(
  content: Array<{ type?: string; text?: string }> | undefined,
): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: string; text: string } =>
        block?.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("");
}

interface PendingTurnState {
  streamedText: string;
  finalAssistantText: string;
  latestAssistantText: string;
}

function pushAssistantText(
  state: PendingTurnState,
  nextText: string,
  turnId: string,
  threadId: string,
  onText: (delta: string) => void,
): void {
  if (!nextText) {
    return;
  }

  state.finalAssistantText = nextText;
  const knownText =
    state.latestAssistantText.length > state.streamedText.length
      ? state.latestAssistantText
      : state.streamedText;

  if (knownText && nextText.startsWith(knownText)) {
    const delta = nextText.slice(knownText.length);
    if (delta) {
      logDesktop(
        "runtime-bridge",
        "http_stream:assistant_text_delta",
        {
          turnId,
          threadId,
          deltaLength: delta.length,
        },
        "debug",
      );
      state.streamedText += delta;
      onText(delta);
    }
  } else if (!knownText) {
    logDesktop(
      "runtime-bridge",
      "http_stream:assistant_text_initial",
      {
        turnId,
        threadId,
        textLength: nextText.length,
      },
      "debug",
    );
    state.streamedText += nextText;
    onText(nextText);
  }

  state.latestAssistantText = nextText;
}

export async function streamRuntimeChat({
  runtimeManager,
  threadId,
  content,
  model,
  turnId,
  onEvent,
  onText,
}: StreamRuntimeChatOptions): Promise<StreamRuntimeChatResult> {
  logDesktop(
    "runtime-bridge",
    "send_message:start",
    {
      turnId,
      threadId,
      model,
      length: content.length,
    },
    "debug",
  );

  const response = await fetch(
    `${runtimeManager.getControlPlaneHttpUrl()}/turn`,
    {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      threadId,
      model,
      content,
      env: {
        DESKTOP_ANTHROPIC_MODEL: model,
      },
    }),
    },
  );

  if (!response.ok || !response.body) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      errorText.trim() ||
        `Control plane returned HTTP ${response.status}.`,
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const state: PendingTurnState = {
    streamedText: "",
    finalAssistantText: "",
    latestAssistantText: "",
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }

      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }

      let event: ControlPlaneEvent;
      try {
        event = JSON.parse(line) as ControlPlaneEvent;
      } catch {
        throw new Error("Control plane returned invalid JSON.");
      }

      if (event.type === "error") {
        const error = new Error(
          event.error || event.message || "Control plane failed.",
        );
        logDesktop("runtime-bridge", "http_stream:event_error", {
          turnId,
          threadId,
          model,
          error,
        });
        throw error;
      }

      if (
        event.type === "assistant_text" &&
        typeof event.text === "string" &&
        !state.streamedText
      ) {
        pushAssistantText(state, event.text, turnId, threadId, onText);
        continue;
      }

      if (event.type !== "sdk_event" || !event.event) {
        continue;
      }

      const sdkEvent = event.event;
      logDesktop(
        "runtime-bridge",
        "http_stream:sdk_event",
        {
          turnId,
          threadId,
          model,
          eventType: sdkEvent.type,
          subtype: "subtype" in sdkEvent ? sdkEvent.subtype : undefined,
          streamType:
            sdkEvent.type === "stream_event" ? sdkEvent.event?.type : undefined,
          deltaType:
            sdkEvent.type === "stream_event"
              ? sdkEvent.event?.delta?.type
              : undefined,
        },
        "debug",
      );

      onEvent?.(sdkEvent);

      if (
        sdkEvent.type === "stream_event" &&
        sdkEvent.event?.type === "content_block_delta" &&
        sdkEvent.event.delta?.type === "text_delta" &&
        typeof sdkEvent.event.delta.text === "string"
      ) {
        state.streamedText += sdkEvent.event.delta.text;
        onText(sdkEvent.event.delta.text);
        continue;
      }

      if (sdkEvent.type === "assistant") {
        const nextAssistantText = extractAssistantText(
          sdkEvent.message?.content,
        );
        if (nextAssistantText) {
          pushAssistantText(state, nextAssistantText, turnId, threadId, onText);
        }
        continue;
      }

      if (sdkEvent.type === "result") {
        const resultEvent = sdkEvent as ResultLikeEvent;
        if (sdkEvent.subtype && sdkEvent.subtype !== "success") {
          const errorMessage = [
            `Claude SDK execution failed (${sdkEvent.subtype}).`,
            ...(Array.isArray(resultEvent.errors) ? resultEvent.errors : []),
          ]
            .filter(Boolean)
            .join(" ");
          throw new Error(errorMessage);
        }

        if (
          typeof resultEvent.result === "string" &&
          resultEvent.result.trim() &&
          !state.finalAssistantText
        ) {
          state.finalAssistantText = resultEvent.result;
        }

        const finalText = state.finalAssistantText || state.streamedText;
        logDesktop(
          "runtime-bridge",
          "send_message:success",
          {
            turnId,
            threadId,
            model,
            finalTextLength: finalText.length,
          },
          "debug",
        );
        return {
          finalText,
          model,
        };
      }
    }
  }

  throw new Error(
    "Control plane stream ended before the Claude SDK reported a result.",
  );
}
