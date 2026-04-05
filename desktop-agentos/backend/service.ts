import { randomUUID } from "node:crypto";
import { DesktopStore } from "./store";
import { logDesktop } from "../../desktop/backend/log";
import type {
  DesktopClientEvent,
  DesktopRuntimeStatus,
  DesktopServerEvent,
  DesktopSnapshot,
} from "../../desktop/shared/protocol";
import type { Message } from "../../src/types";
import {
  applyRuntimeEventToMessages,
  desktopMessageToUiMessage,
  extractTextContent,
  uiMessagesToDesktopMessages,
} from "../../desktop/shared/message-state";
import {
  getProviderOptions,
  requireDesktopProvider,
} from "./providers";
import { AgentOsRuntimeManager } from "./runtime";

type Listener = (event: DesktopServerEvent) => void;

export class DesktopService {
  private readonly store = new DesktopStore();
  private readonly runtimeManager = new AgentOsRuntimeManager();
  private readonly activeThreads = new Set<string>();
  private readonly listeners = new Set<Listener>();
  private runtimeStatus = this.runtimeManager.getCachedStatus();
  private runtimeStartupPromise: Promise<void> | null = null;

  constructor() {
    const provider = this.getCurrentProvider();
    const model = this.getCurrentModel(provider);
    logDesktop("agentos-service", "init", {
      provider: provider.id,
      model,
      authSource: provider.getAuthState(model).source,
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
    const provider = this.getCurrentProvider();
    const model = this.getCurrentModel(provider);
    return this.store.buildSnapshot(
      this.getRuntimeStatus(),
      provider.id,
      getProviderOptions(),
      model,
      provider.getAvailableModels(),
      provider.getAuthState(model),
    );
  }

  private getCurrentProvider() {
    return requireDesktopProvider(this.store.getProvider());
  }

  private getCurrentModel(provider = this.getCurrentProvider()): string {
    return provider.normalizeModel(this.store.getModel(provider.id));
  }

  private getRuntimeStatus(): DesktopRuntimeStatus {
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
        void this.ensureRuntimeRunning("startup");
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
        void this.ensureRuntimeRunning("startup");
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
          ? "Starting the local AgentOS runtime automatically."
          : "Starting the local AgentOS runtime for this message.",
      helperPath: null,
    };
    this.emitSnapshot();

    this.runtimeStartupPromise = (async () => {
      try {
        this.runtimeStatus = await this.runtimeManager.ensureRuntime((status) => {
          this.runtimeStatus = status;
          this.emitSnapshot();
        });
      } catch (error) {
        this.runtimeStatus = {
          state: "error",
          detail: error instanceof Error ? error.message : String(error),
          helperPath: null,
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
    const providerSessionId = this.store.getProviderSessionId(
      threadId,
      provider.id,
    );

    try {
      this.store.appendMessage(threadId, "user", trimmed, "done");
      const assistant = this.store.appendMessage(
        threadId,
        "assistant",
        "",
        "streaming",
      );
      assistantId = assistant.id;
      this.emitSnapshot();

      let persistedThreadMessages: Message[] = this.store
        .getThreadMessages(threadId)
        .map(desktopMessageToUiMessage);
      const streamingMessageIds: Record<string, string | null> = {
        [threadId]: assistant.id,
      };

      await this.ensureRuntimeRunning("send_message");

      const result = await this.runtimeManager.streamPrompt({
        provider,
        threadId,
        content: trimmed,
        model,
        sessionId: providerSessionId,
        onSessionId: (sessionId) => {
          this.store.setProviderSessionId(threadId, provider.id, sessionId);
        },
        onRuntimeEvent: (event) => {
          if (!assistantId) {
            return;
          }
          this.broadcast({
            type: "runtime_event",
            threadId,
            provider: provider.id,
            event,
          });

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
          this.emitSnapshot();
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
        result.finalText.trim() && persistedAssistantText.length === 0
          ? result.finalText
          : undefined,
      );

      logDesktop("agentos-service", "send_message:completed", {
        turnId,
        threadId,
        provider: provider.id,
        assistantId,
        finalTextLength: result.finalText.length,
        model: result.model,
      });
      this.emitSnapshot();
    } catch (error) {
      logDesktop("agentos-service", "send_message:error", {
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
    }
  }
}
