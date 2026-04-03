import { randomUUID } from "node:crypto";
import { DesktopStore } from "./store";
import { VmManager } from "./vm";
import {
  getClaudeAuthState,
  getDefaultConfiguredModel,
  normalizeDesktopModel,
} from "./anthropic";
import { streamGuestChat } from "./guest-control-plane";
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
  private readonly vmManager = new VmManager();
  private readonly activeThreads = new Set<string>();
  private readonly listeners = new Set<Listener>();
  private vmStatus = this.vmManager.getCachedStatus();
  private vmStartupPromise: Promise<void> | null = null;

  constructor() {
    logDesktop("service", "init", {
      model: this.store.getModel(),
      authSource: getClaudeAuthState().authSource,
    });
    void this.ensureVmRunning("startup");
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.vmManager.dispose();
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
      this.vmStatus,
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

  private normalizeRuntimeProgressStatus(status: DesktopSnapshot["vmStatus"]): DesktopSnapshot["vmStatus"] {
    if (status.state === "stopped") {
      return {
        ...status,
        state: "starting",
      };
    }

    if (
      status.state === "running" &&
      /guest readiness has not been published yet/i.test(status.detail)
    ) {
      return {
        ...status,
        state: "starting",
      };
    }

    return status;
  }

  private async ensureVmRunning(
    reason: "startup" | "send_message",
    model = this.store.getModel(),
  ): Promise<void> {
    if (this.vmStartupPromise) {
      await this.vmStartupPromise;
      return;
    }

    if (this.vmStatus.state === "running") {
      return;
    }

    this.vmStatus = {
      ...this.vmStatus,
      state: "starting",
      detail:
        reason === "startup"
          ? "Starting the local runtime automatically."
          : "Starting the local runtime for this message.",
      helperPath: this.vmStatus.helperPath ?? this.vmManager.getHelperPath(),
    };
    this.emitSnapshot();

    this.vmStartupPromise = (async () => {
      logDesktop("service", "vm_runtime:start", {
        reason,
        model,
      });
      try {
        this.vmStatus = await this.vmManager.ensureGuestAgentRuntime(
          model,
          (status) => {
            this.vmStatus = this.normalizeRuntimeProgressStatus(status);
            this.emitSnapshot();
          },
        );
        if (this.vmStatus.state !== "running") {
          throw new Error(this.vmStatus.detail);
        }
        logDesktop("service", "vm_runtime:ready", {
          reason,
          state: this.vmStatus.state,
          detail: this.vmStatus.detail,
        });
      } catch (error) {
        logDesktop("service", "vm_runtime:error", {
          reason,
          error,
        });
        this.vmStatus = {
          state: "error",
          detail: error instanceof Error ? error.message : String(error),
          helperPath: this.vmManager.getHelperPath(),
        };
      } finally {
        this.emitSnapshot();
        this.vmStartupPromise = null;
      }
    })();

    await this.vmStartupPromise;
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

      await this.ensureVmRunning("send_message", model);

      logDesktop("service", "send_message:runtime_ready", {
        turnId,
        threadId,
        state: this.vmStatus.state,
        detail: this.vmStatus.detail,
      });
      this.emitSnapshot();

      const result = await streamGuestChat({
        vmManager: this.vmManager,
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
