import { randomUUID } from "node:crypto";
import { DesktopStore } from "./store";
import { RuntimeManager } from "./runtime";
import {
  getClaudeAuthState,
  getDefaultConfiguredModel,
  normalizeDesktopModel,
} from "./anthropic";
import { streamRuntimeChat } from "./runtime-control-plane";
import { logDesktop } from "./log";
import {
  applySdkEventToMessages,
  desktopMessageToUiMessage,
  extractTextContent,
  uiMessagesToDesktopMessages,
} from "../shared/message-state";
import type {
  DesktopClientEvent,
  DesktopServerEvent,
  DesktopSnapshot,
} from "../shared/protocol";
import type { Message } from "../../src/types";

type Listener = (event: DesktopServerEvent) => void;

export class DesktopService {
  private readonly store = new DesktopStore();
  private readonly runtimeManager = new RuntimeManager();
  private readonly activeThreads = new Set<string>();
  private readonly listeners = new Set<Listener>();
  private runtimeStatus = this.runtimeManager.getCachedStatus();
  private runtimeStartupPromise: Promise<void> | null = null;

  constructor() {
    logDesktop("service", "init", {
      model: this.store.getModel(),
      authSource: getClaudeAuthState().authSource,
    });
    void this.ensureRuntimeRunning("startup");
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
    return this.store.buildSnapshot(
      this.runtimeStatus,
      this.store.getModel(),
      getClaudeAuthState(),
    );
  }

  handleClientEvent(event: DesktopClientEvent): void {
    switch (event.type) {
      case "create_thread": {
        this.store.createThread(event.title);
        this.emitSnapshot();
        return;
      }
      case "set_model": {
        this.store.setModel(normalizeDesktopModel(event.model));
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
    model = this.store.getModel(),
  ): Promise<void> {
    if (this.runtimeStartupPromise) {
      await this.runtimeStartupPromise;
      return;
    }

    if (this.runtimeStatus.state === "running") {
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
        model,
      });
      try {
        this.runtimeStatus =
          await this.runtimeManager.ensureControlPlaneRuntime(
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
          state: this.runtimeStatus.state,
          detail: this.runtimeStatus.detail,
        });
      } catch (error) {
        logDesktop("service", "runtime:error", {
          reason,
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
    const model = this.store.getModel() ?? getDefaultConfiguredModel();

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

      await this.ensureRuntimeRunning("send_message", model);

      logDesktop("service", "send_message:runtime_ready", {
        turnId,
        threadId,
        state: this.runtimeStatus.state,
        detail: this.runtimeStatus.detail,
      });
      this.emitSnapshot();

      const result = await streamRuntimeChat({
        runtimeManager: this.runtimeManager,
        threadId,
        content: trimmed,
        model,
        turnId,
        onEvent: (event) => {
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
          persistedThreadMessages = applySdkEventToMessages(
            persistedThreadMessages,
            threadId,
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
          this.broadcast({
            type: "sdk_event",
            threadId,
            event,
          });
        },
        onText: (delta) => {
          logDesktop(
            "service",
            "send_message:assistant_delta",
            {
              turnId,
              threadId,
              deltaLength: delta.length,
            },
            "debug",
          );
          this.broadcast({
            type: "assistant_delta",
            threadId,
            messageId: assistant.id,
            delta,
          });
        },
      });

      const latestAssistant = this.store
        .getThreadMessages(threadId)
        .find((message) => message.id === assistant.id);
      const hasPersistedContent = latestAssistant
        ? extractTextContent(latestAssistant.content).trim().length > 0
        : false;
      this.store.finalizeMessage(
        threadId,
        assistant.id,
        "done",
        hasPersistedContent ? undefined : result.finalText,
      );
      logDesktop("service", "send_message:completed", {
        turnId,
        threadId,
        assistantId,
        finalTextLength: result.finalText.length,
        model: result.model,
      });
      this.emitSnapshot();
    } catch (error) {
      logDesktop("service", "send_message:error", {
        turnId,
        threadId,
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
