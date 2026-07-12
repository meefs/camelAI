// Provider-level transient-retry ladder for Pi model streams, extracted from
// chat-thread-do.ts. Wraps a stream factory and retries bounded transient
// provider errors as long as nothing has been forwarded downstream yet;
// terminal errors are synthesized into the outer stream. Holds no ChatThreadDO
// state — the only DO-owned concern (terminal-error logging with the current
// usage provider) comes in as a callback.
import {
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Model,
} from "@earendil-works/pi-ai";

const PI_PROVIDER_TRANSIENT_RETRY_ATTEMPTS = 2;
const PI_PROVIDER_TRANSIENT_RETRY_DELAY_MS = 300;

// Pure Pi provider stream-error helpers (formerly ./chat-thread-pi-provider-errors).
// These read only their arguments plus the module-local transient-error
// pattern list; they hold no ChatThreadDO state.

const PI_PROVIDER_TRANSIENT_ERROR_PATTERNS = [
  "network connection lost",
  "connection lost",
  "transient issue on remote node",
];

export function piProviderStreamErrorMessage(event: AssistantMessageEvent): string {
  if (event.type !== "error") return "";
  const message = event.error.errorMessage;
  return typeof message === "string" ? message.trim() : "";
}

export function isTransientPiProviderError(message: string): boolean {
  const lower = message.toLowerCase();
  return PI_PROVIDER_TRANSIENT_ERROR_PATTERNS.some((pattern) =>
    lower.includes(pattern),
  );
}

export function createPiProviderStreamErrorMessage(
  model: Model<any>,
  errorMessage: string,
  stopReason: "error" | "aborted",
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
}

export type PiProviderStreamTerminalStatus =
  | "retry_exhausted"
  | "after_forwarded_event"
  | "non_transient"
  | "aborted";

/**
 * Sleep that rejects with "Request was aborted" if the signal fires (or has
 * already fired). Shared by the provider ladder here and ChatThreadDO's
 * turn-level transient-retry backoff.
 */
export function abortableSleep(
  delayMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new Error("Request was aborted"));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error("Request was aborted"));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function streamPiModelWithTransientRetry(
  model: Model<any>,
  options: Parameters<typeof import("@earendil-works/pi-ai/compat").streamSimple>[2],
  createStream: () => AssistantMessageEventStream,
  onTerminalError: (
    message: string,
    status: PiProviderStreamTerminalStatus,
    attempt: number,
    forwardedEvent: boolean,
  ) => void,
): AssistantMessageEventStream {
  const outer = createAssistantMessageEventStream();

  void (async () => {
    let attempt = 0;
    while (true) {
      let forwardedEvent = false;
      let pendingStartEvent: AssistantMessageEvent | null = null;
      let retryErrorMessage = "";
      try {
        const inner = createStream();
        for await (const event of inner) {
          if (event.type === "start") {
            pendingStartEvent = event;
            continue;
          }
          const errorMessage = piProviderStreamErrorMessage(event);
          if (
            errorMessage &&
            !forwardedEvent &&
            !options?.signal?.aborted &&
            attempt < PI_PROVIDER_TRANSIENT_RETRY_ATTEMPTS &&
            isTransientPiProviderError(errorMessage)
          ) {
            retryErrorMessage = errorMessage;
            break;
          }
          if (errorMessage) {
            onTerminalError(
              errorMessage,
              options?.signal?.aborted
                ? "aborted"
                : forwardedEvent
                  ? "after_forwarded_event"
                  : attempt >= PI_PROVIDER_TRANSIENT_RETRY_ATTEMPTS
                    ? "retry_exhausted"
                    : "non_transient",
              attempt + 1,
              forwardedEvent,
            );
          }
          if (pendingStartEvent) {
            outer.push(pendingStartEvent);
            pendingStartEvent = null;
            forwardedEvent = true;
          }
          outer.push(event);
          forwardedEvent = true;
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (
          !forwardedEvent &&
          !options?.signal?.aborted &&
          attempt < PI_PROVIDER_TRANSIENT_RETRY_ATTEMPTS &&
          isTransientPiProviderError(errorMessage)
        ) {
          retryErrorMessage = errorMessage;
        } else {
          onTerminalError(
            errorMessage,
            options?.signal?.aborted
              ? "aborted"
              : forwardedEvent
                ? "after_forwarded_event"
                : attempt >= PI_PROVIDER_TRANSIENT_RETRY_ATTEMPTS
                  ? "retry_exhausted"
                  : "non_transient",
            attempt + 1,
            forwardedEvent,
          );
          outer.push({
            type: "error",
            reason: options?.signal?.aborted ? "aborted" : "error",
            error: createPiProviderStreamErrorMessage(
              model,
              errorMessage,
              options?.signal?.aborted ? "aborted" : "error",
            ),
          });
          outer.end();
          return;
        }
      }

      if (!retryErrorMessage) {
        outer.end();
        return;
      }

      attempt += 1;
      await abortableSleep(PI_PROVIDER_TRANSIENT_RETRY_DELAY_MS, options?.signal);
    }
  })().catch((error) => {
    outer.push({
      type: "error",
      reason: options?.signal?.aborted ? "aborted" : "error",
      error: createPiProviderStreamErrorMessage(
        model,
        error instanceof Error ? error.message : String(error),
        options?.signal?.aborted ? "aborted" : "error",
      ),
    });
    outer.end();
  });

  return outer;
}
