import { randomUUID } from "node:crypto";
import { DesktopStore } from "./store";
import { RuntimeManager } from "./runtime";
import {
  requireDesktopProvider,
  getProviderOptions,
} from "./providers";
import { streamRuntimeChat } from "./runtime-control-plane";
import { logDesktop } from "./log";
import {
  applyRuntimeEventToMessages,
  desktopMessageToUiMessage,
  extractTextContent,
  uiMessagesToDesktopMessages,
} from "../shared/message-state";
import type {
  DesktopClientEvent,
  DesktopRuntimeStatus,
  DesktopServerEvent,
  DesktopSnapshot,
} from "../shared/protocol";
import type { SDKEvent } from "../../src/lib/streaming";
import type { Message } from "../../src/types";

type Listener = (event: DesktopServerEvent) => void;

function isClaudeRuntimeEvent(event: unknown): event is SDKEvent {
  return Boolean(
    event &&
      typeof event === "object" &&
      typeof (event as { type?: unknown }).type === "string",
  );
}

export class DesktopService {
  private readonly store = new DesktopStore();
  private readonly runtimeManager = new RuntimeManager();
  private readonly activeThreads = new Set<string>();
  private readonly listeners = new Set<Listener>();
  private runtimeStatus = this.runtimeManager.getCachedStatus();
  private runtimeStartupPromise: Promise<void> | null = null;

  constructor() {
    const provider = this.getCurrentProvider();
    const model = this.getCurrentModel(provider);
    logDesktop("service", "init", {
      provider: provider.id,
      model,
      authSource: provider.getAuthState().source,
    });
    if (provider.transport === "runtime-control-plane") {
      void this.ensureRuntimeRunning("startup", provider, model);
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.runtimeManager.dispose();
    this.listeners.clear();
    this.activeThreads.clear();
  }

  emitSnapshot(listener?: Listener): void {
    const event: DesktopServerEvent = {
      type: "snapshot",
      snapshot: this.getSnapshot(),
    };
    if (listener) {
      listener(event);
      return;
    }
    this.broadcast(event);
  }

  getSnapshot(): DesktopSnapshot {
    const provider = this.getCurrentProvider();
    const model = this.getCurrentModel(provider);
    return this.store.buildSnapshot(
      this.getRuntimeStatus(provider),
      provider.id,
      getProviderOptions(),
      model,
      provider.getAvailableModels(),
      provider.getAuthState(),
    );
  }

  private getCurrentProvider() {
    return requireDesktopProvider(this.store.getProvider());
  }

  private getCurrentModel(provider = this.getCurrentProvider()): string {
    return provider.normalizeModel(this.store.getModel(provider.id));
  }

  private getRuntimeStatus(
    provider = this.getCurrentProvider(),
  ): DesktopRuntimeStatus {
    return this.runtimeStatus;
  }

  handleClientEvent(event: DesktopClientEvent): void {
    switch (event.type) {
      case "create_thread": {
        this.store.createThread(event.title, this.store.getProvider());
        this.emitSnapshot();
        return;
      }
      case "select_thread": {
        this.store.setActiveThread(event.threadId);
        this.emitSnapshot();
        const provider = this.getCurrentProvider();
        if (provider.transport === "runtime-control-plane") {
          void this.ensureRuntimeRunning(
            "startup",
            provider,
            this.getCurrentModel(provider),
          );
        }
        return;
      }
      case "set_provider": {
        const provider = requireDesktopProvider(event.provider).id;
        const activeThreadId = this.store.getActiveThreadId();
        const activeThread =
          activeThreadId ? this.store.getThread(activeThreadId) : null;
        if (!activeThread) {
          this.store.setProvider(provider);
        } else if (
          activeThread.provider === provider ||
          !this.store.threadHasHarnessState(activeThread.id)
        ) {
          this.store.setThreadProvider(activeThread.id, provider);
        } else {
          this.store.setProvider(provider);
          this.store.createThread(undefined, provider);
        }
        this.emitSnapshot();
        const nextProvider = this.getCurrentProvider();
        if (nextProvider.transport === "runtime-control-plane") {
          void this.ensureRuntimeRunning(
            "startup",
            nextProvider,
            this.getCurrentModel(nextProvider),
          );
        }
        return;
      }
      case "set_model": {
        const provider = this.getCurrentProvider();
        this.store.setModel(provider.normalizeModel(event.model), provider.id);
        this.emitSnapshot();
        return;
      }
      case "send_message": {
        void this.handleSendMessage(event.threadId, event.content);
        return;
      }
      case "ping": {
        this.broadcast({
          type: "pong",
          now: Date.now(),
        });
        return;
      }
      default: {
        const neverEvent: never = event;
        throw new Error(`Unhandled event: ${JSON.stringify(neverEvent)}`);
      }
    }
  }

  private broadcast(event: DesktopServerEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private async ensureRuntimeRunning(
    reason: "startup" | "send_message",
    provider = this.getCurrentProvider(),
    model = this.getCurrentModel(provider),
  ): Promise<void> {
    if (this.runtimeStartupPromise) {
      await this.runtimeStartupPromise;
      return;
    }

    this.runtimeStatus = {
      ...this.runtimeStatus,
      state: "starting",
      detail:
        reason === "startup"
          ? "Starting the local runtime automatically."
          : "Starting the local runtime for this message.",
      helperPath:
        this.runtimeStatus.helperPath ?? this.runtimeManager.getHelperPath(),
    };
    this.emitSnapshot();

    this.runtimeStartupPromise = (async () => {
      logDesktop("service", "runtime:start", {
        reason,
        provider: provider.id,
        model,
      });
      try {
        this.runtimeStatus =
          await this.runtimeManager.ensureControlPlaneRuntime(
          provider,
          model,
          (status) => {
            this.runtimeStatus = status;
            this.emitSnapshot();
          },
        );
        if (this.runtimeStatus.state !== "running") {
          throw new Error(this.runtimeStatus.detail);
        }
        logDesktop("service", "runtime:ready", {
          reason,
          provider: provider.id,
          state: this.runtimeStatus.state,
          detail: this.runtimeStatus.detail,
        });
      } catch (error) {
        logDesktop("service", "runtime:error", {
          reason,
          provider: provider.id,
          error,
        });
        this.runtimeStatus = {
          state: "error",
          detail: error instanceof Error ? error.message : String(error),
          helperPath: this.runtimeManager.getHelperPath(),
        };
      } finally {
        this.emitSnapshot();
        this.runtimeStartupPromise = null;
      }
    })();

    await this.runtimeStartupPromise;
  }

  private appendErrorMessage(threadId: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    const assistant = this.store.appendMessage(
      threadId,
      "assistant",
      `Error: ${detail}`,
      "error",
    );
    this.emitSnapshot();
    this.broadcast({
      type: "error",
      threadId,
      message: extractTextContent(assistant.content),
    });
  }

  private async handleSendMessage(
    threadId: string,
    content: string,
  ): Promise<void> {
    logDesktop("service", "send_message:received", {
      threadId,
      length: content.length,
      active: this.activeThreads.has(threadId),
    });
    if (this.activeThreads.has(threadId)) {
      this.broadcast({
        type: "error",
        threadId,
        message: "A response is already streaming for this thread.",
      });
      return;
    }

    const trimmed = content.trim();
    if (!trimmed) {
      this.broadcast({
        type: "error",
        threadId,
        message: "Message content cannot be empty.",
      });
      return;
    }

    this.activeThreads.add(threadId);
    const turnId = randomUUID();
    let assistantId: string | null = null;
    const provider = requireDesktopProvider(
      this.store.getThreadProvider(threadId),
    );
    const model = this.getCurrentModel(provider);
    const providerSessionId = this.store.getProviderSessionId(threadId, provider.id);

    try {
      this.store.appendMessage(threadId, "user", trimmed, "done");
      const assistant = this.store.appendMessage(
        threadId,
        "assistant",
        "",
        "streaming",
      );
      assistantId = assistant.id;
      logDesktop("service", "send_message:accepted", {
        turnId,
        threadId,
        provider: provider.id,
        assistantId,
        model,
      });
      this.emitSnapshot();

      let persistedThreadMessages: Message[] = this.store
        .getThreadMessages(threadId)
        .map(desktopMessageToUiMessage);
      const streamingMessageIds: Record<string, string | null> = {
        [threadId]: assistant.id,
      };

      await this.ensureRuntimeRunning("send_message", provider, model);
      const runtimeStatus = this.getRuntimeStatus(provider);

      logDesktop("service", "send_message:runtime_ready", {
        turnId,
        threadId,
        provider: provider.id,
        state: runtimeStatus.state,
        detail: runtimeStatus.detail,
      });
      this.emitSnapshot();

      const result = await streamRuntimeChat({
        runtimeManager: this.runtimeManager,
        provider,
        threadId,
        content: trimmed,
        model,
        turnId,
        sessionId: providerSessionId,
        onSessionId: (sessionId) => {
          this.store.setProviderSessionId(threadId, provider.id, sessionId);
        },
        onEvent: (event) => {
          this.broadcast({
            type: "runtime_event",
            threadId,
            provider: provider.id,
            event,
          });

          if (provider.id === "claude" && isClaudeRuntimeEvent(event)) {
            logDesktop(
              "service",
              "send_message:sdk_event",
              {
                turnId,
                threadId,
                eventType: event.type,
                subtype: "subtype" in event ? event.subtype : undefined,
                streamType:
                  event.type === "stream_event" ? event.event?.type : undefined,
                deltaType:
                  event.type === "stream_event"
                    ? event.event?.delta?.type
                    : undefined,
              },
              "debug",
            );
          }

          persistedThreadMessages = applyRuntimeEventToMessages(
            persistedThreadMessages,
            threadId,
            provider.id,
            event,
            streamingMessageIds,
          );
          this.store.replaceThreadMessages(
            threadId,
            uiMessagesToDesktopMessages(
              persistedThreadMessages,
              this.store.getThreadMessages(threadId),
            ),
          );
        },
      });

      const latestAssistant = this.store
        .getThreadMessages(threadId)
        .find((message) => message.id === assistant.id);
      const persistedAssistantText = latestAssistant
        ? extractTextContent(latestAssistant.content).trim()
        : "";
      this.store.finalizeMessage(
        threadId,
        assistant.id,
        "done",
        provider.id === "claude" &&
          result.finalText.trim() &&
          result.finalText.trim() !== persistedAssistantText
          ? result.finalText
          : undefined,
      );
      logDesktop("service", "send_message:completed", {
        turnId,
        threadId,
        provider: provider.id,
        assistantId,
        finalTextLength: result.finalText.length,
        model: result.model,
      });
      this.emitSnapshot();
    } catch (error) {
      logDesktop("service", "send_message:error", {
        turnId,
        threadId,
        provider: provider.id,
        assistantId,
        error,
      });
      if (assistantId) {
        const detail = error instanceof Error ? error.message : String(error);
        this.store.finalizeMessage(
          threadId,
          assistantId,
          "error",
          `Error: ${detail}`,
        );
        this.emitSnapshot();
        this.broadcast({
          type: "error",
          threadId,
          message: detail,
        });
      } else {
        this.appendErrorMessage(threadId, error);
      }
    } finally {
      this.activeThreads.delete(threadId);
      logDesktop("service", "send_message:finished", {
        turnId,
        threadId,
      });
    }
  }
}
