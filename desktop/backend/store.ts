import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type {
  DesktopAuthState,
  DesktopMessage,
  DesktopModel,
  DesktopModelOption,
  DesktopProvider,
  DesktopProviderOption,
  DesktopRuntimeStatus,
  DesktopSnapshot,
  DesktopThread,
} from '../shared/protocol';
import type { ContentBlock } from '../../src/types';
import { extractTextContent } from '../shared/message-state';
import {
  getDefaultProvider,
  requireDesktopProvider,
} from './providers';

interface PersistedState {
  activeThreadId: string | null;
  provider: DesktopProvider;
  modelsByProvider: Partial<Record<DesktopProvider, DesktopModel>>;
  providerStateByThread?: Partial<
    Record<
      string,
      Partial<
        Record<
          DesktopProvider,
          {
            sessionId?: string | null;
          }
        >
      >
    >
  >;
  threads: DesktopThread[];
  messagesByThread: Record<string, DesktopMessage[]>;
}

type PersistedDesktopThread = Omit<DesktopThread, 'provider'> & {
  provider?: DesktopProvider;
};

const DEFAULT_THREAD_TITLE = 'New thread';
const backendDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(backendDirectory, '..');
const DEFAULT_DATA_DIR = resolve(desktopDirectory, '.local');

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function now(): number {
  return Date.now();
}

function deriveThreadTitle(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (!normalized) return DEFAULT_THREAD_TITLE;
  return normalized.slice(0, 60);
}

function previewText(content: string | ContentBlock[]): string | null {
  const text = extractTextContent(content).replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 140) : null;
}

export class DesktopStore {
  private readonly statePath: string;
  private state: PersistedState;

  constructor(dataDir = process.env.DESKTOP_DATA_DIR || DEFAULT_DATA_DIR) {
    ensureDir(dataDir);
    this.statePath = resolve(dataDir, 'state.json');
    this.state = this.load();
    if (this.state.threads.length === 0) {
      const thread = this.createThread('Local workspace');
      this.state.activeThreadId = thread.id;
      this.persist();
    }
  }

  private load(): PersistedState {
    try {
      const raw = readFileSync(this.statePath, 'utf8');
      const parsed = JSON.parse(raw) as PersistedState & {
        model?: DesktopModel;
        threads?: PersistedDesktopThread[];
      };
      const providerAdapter = requireDesktopProvider(
        parsed.provider ?? getDefaultProvider(),
      );
      const fallbackProvider = providerAdapter.id;
      const legacyModel =
        parsed.model && typeof parsed.model === 'string'
          ? providerAdapter.normalizeModel(parsed.model)
          : undefined;
      const modelsByProvider = parsed.modelsByProvider ?? {};
      const persistedProviderModel = modelsByProvider[fallbackProvider];
      const providerStateByThread = parsed.providerStateByThread ?? {};
      const inferThreadProvider = (
        thread: PersistedDesktopThread,
      ): DesktopProvider => {
        if (thread.provider) {
          return requireDesktopProvider(thread.provider).id;
        }

        const threadProviderState = providerStateByThread[thread.id] ?? {};
        const providersWithSessions = Object.entries(threadProviderState)
          .filter((entry): entry is [DesktopProvider, { sessionId?: string | null }] =>
            Boolean(entry[1]?.sessionId),
          )
          .map(([providerId]) => requireDesktopProvider(providerId).id);

        if (providersWithSessions.length === 1) {
          return providersWithSessions[0];
        }

        return fallbackProvider;
      };
      const threads = Array.isArray(parsed.threads)
        ? parsed.threads.map((thread) => ({
            ...thread,
            provider: inferThreadProvider(thread),
          }))
        : [];
      const activeThreadId = parsed.activeThreadId ?? null;
      const activeThreadProvider =
        (activeThreadId
          ? threads.find((thread) => thread.id === activeThreadId)?.provider
          : null) ?? fallbackProvider;
      return {
        activeThreadId,
        provider: activeThreadProvider,
        modelsByProvider: {
          ...modelsByProvider,
          [activeThreadProvider]: requireDesktopProvider(activeThreadProvider).normalizeModel(
            modelsByProvider[activeThreadProvider] ??
              persistedProviderModel ??
              legacyModel ??
              requireDesktopProvider(activeThreadProvider).getDefaultModel(),
          ),
        },
        providerStateByThread,
        threads,
        messagesByThread: parsed.messagesByThread ?? {},
      };
    } catch {
      const provider = getDefaultProvider();
      return {
        activeThreadId: null,
        provider,
        modelsByProvider: {
          [provider]: requireDesktopProvider(provider).getDefaultModel(),
        },
        providerStateByThread: {},
        threads: [],
        messagesByThread: {},
      };
    }
  }

  private persist(): void {
    ensureDir(dirname(this.statePath));
    writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
  }

  private sortThreads(): void {
    this.state.threads.sort((left, right) => right.updatedAt - left.updatedAt);
  }

  listThreads(): DesktopThread[] {
    this.sortThreads();
    return [...this.state.threads];
  }

  getActiveThreadId(): string | null {
    return this.state.activeThreadId;
  }

  getProvider(): DesktopProvider {
    return this.state.provider;
  }

  setProvider(provider: DesktopProvider): void {
    const normalizedProvider = requireDesktopProvider(provider).id;
    this.state.provider = normalizedProvider;
    this.ensureProviderModel(normalizedProvider);
    this.persist();
  }

  private ensureProviderModel(provider: DesktopProvider): void {
    if (!this.state.modelsByProvider[provider]) {
      this.state.modelsByProvider[provider] =
        requireDesktopProvider(provider).getDefaultModel();
    }
  }

  getModel(provider = this.state.provider): DesktopModel {
    const adapter = requireDesktopProvider(provider);
    return adapter.normalizeModel(
      this.state.modelsByProvider[provider] ?? adapter.getDefaultModel(),
    );
  }

  setModel(model: DesktopModel, provider = this.state.provider): void {
    this.state.modelsByProvider[provider] = requireDesktopProvider(provider).normalizeModel(model);
    this.persist();
  }

  getProviderSessionId(
    threadId: string,
    provider = this.state.provider,
  ): string | null {
    return this.state.providerStateByThread?.[threadId]?.[provider]?.sessionId ?? null;
  }

  setProviderSessionId(
    threadId: string,
    provider: DesktopProvider,
    sessionId: string | null,
  ): void {
    const current = this.state.providerStateByThread ?? {};
    const threadState = current[threadId] ?? {};
    this.state.providerStateByThread = {
      ...current,
      [threadId]: {
        ...threadState,
        [provider]: {
          ...threadState[provider],
          sessionId,
        },
      },
    };
    this.persist();
  }

  getMessagesByThread(): Record<string, DesktopMessage[]> {
    return Object.fromEntries(
      Object.entries(this.state.messagesByThread).map(([threadId, messages]) => [
        threadId,
        messages.map((message) => ({ ...message })),
      ])
    );
  }

  getThread(threadId: string): DesktopThread | null {
    return this.state.threads.find((thread) => thread.id === threadId) ?? null;
  }

  getThreadProvider(threadId: string): DesktopProvider {
    return this.getThread(threadId)?.provider ?? this.state.provider;
  }

  setActiveThread(threadId: string): void {
    const thread = this.getThread(threadId);
    if (!thread) {
      throw new Error(`Thread ${threadId} does not exist`);
    }

    this.state.activeThreadId = threadId;
    this.state.provider = thread.provider;
    this.ensureProviderModel(thread.provider);
    this.persist();
  }

  setThreadProvider(threadId: string, provider: DesktopProvider): void {
    const thread = this.getThread(threadId);
    if (!thread) {
      throw new Error(`Thread ${threadId} does not exist`);
    }

    const normalizedProvider = requireDesktopProvider(provider).id;
    thread.provider = normalizedProvider;
    this.ensureProviderModel(normalizedProvider);
    if (this.state.activeThreadId === threadId) {
      this.state.provider = normalizedProvider;
    }
    this.persist();
  }

  threadHasHarnessState(threadId: string): boolean {
    if ((this.state.messagesByThread[threadId] ?? []).length > 0) {
      return true;
    }

    return Object.values(this.state.providerStateByThread?.[threadId] ?? {}).some(
      (entry) => Boolean(entry?.sessionId),
    );
  }

  getThreadMessages(threadId: string): DesktopMessage[] {
    return (this.state.messagesByThread[threadId] ?? []).map((message) => ({ ...message }));
  }

  createThread(
    title = DEFAULT_THREAD_TITLE,
    provider = this.state.provider,
  ): DesktopThread {
    const normalizedProvider = requireDesktopProvider(provider).id;
    const thread: DesktopThread = {
      id: randomUUID(),
      provider: normalizedProvider,
      title: title.trim() || DEFAULT_THREAD_TITLE,
      createdAt: now(),
      updatedAt: now(),
      lastMessagePreview: null,
    };
    this.state.threads.unshift(thread);
    this.state.messagesByThread[thread.id] = [];
    this.state.providerStateByThread = {
      ...(this.state.providerStateByThread ?? {}),
      [thread.id]: {},
    };
    this.state.activeThreadId = thread.id;
    this.state.provider = normalizedProvider;
    this.ensureProviderModel(normalizedProvider);
    this.persist();
    return thread;
  }

  appendMessage(
    threadId: string,
    role: DesktopMessage['role'],
    content: DesktopMessage['content'],
    status: DesktopMessage['status'],
    extras: Pick<DesktopMessage, 'isMeta' | 'sourceToolUseID'> = {}
  ): DesktopMessage {
    const thread = this.getThread(threadId);
    if (!thread) {
      throw new Error(`Thread ${threadId} does not exist`);
    }

    const message: DesktopMessage = {
      id: randomUUID(),
      threadId,
      role,
      content,
      createdAt: now(),
      status,
      isMeta: extras.isMeta,
      sourceToolUseID: extras.sourceToolUseID,
    };
    const nextMessages = this.state.messagesByThread[threadId] ?? [];
    nextMessages.push(message);
    this.state.messagesByThread[threadId] = nextMessages;

    thread.updatedAt = now();
    thread.lastMessagePreview = previewText(content) || thread.lastMessagePreview;

    if (role === 'user' && typeof content === 'string' && thread.title === DEFAULT_THREAD_TITLE) {
      thread.title = deriveThreadTitle(content);
    }

    this.sortThreads();
    this.persist();
    return message;
  }

  appendToMessage(threadId: string, messageId: string, delta: string): DesktopMessage {
    const messages = this.state.messagesByThread[threadId];
    if (!messages) {
      throw new Error(`Thread ${threadId} has no messages`);
    }
    const message = messages.find((entry) => entry.id === messageId);
    if (!message) {
      throw new Error(`Message ${messageId} does not exist`);
    }
    message.content = `${extractTextContent(message.content)}${delta}`;
    message.status = 'streaming';
    const thread = this.getThread(threadId);
    if (thread) {
      thread.updatedAt = now();
      thread.lastMessagePreview = previewText(message.content) || thread.lastMessagePreview;
      this.sortThreads();
    }
    this.persist();
    return message;
  }

  finalizeMessage(
    threadId: string,
    messageId: string,
    status: DesktopMessage['status'],
    content?: DesktopMessage['content']
  ): DesktopMessage {
    const messages = this.state.messagesByThread[threadId];
    if (!messages) {
      throw new Error(`Thread ${threadId} has no messages`);
    }
    const message = messages.find((entry) => entry.id === messageId);
    if (!message) {
      throw new Error(`Message ${messageId} does not exist`);
    }
    if (typeof content === 'string') {
      message.content = content;
    } else if (Array.isArray(content)) {
      message.content = content;
    }
    message.status = status;
    const thread = this.getThread(threadId);
    if (thread) {
      thread.updatedAt = now();
      thread.lastMessagePreview = previewText(message.content) || thread.lastMessagePreview;
      this.sortThreads();
    }
    this.persist();
    return message;
  }

  replaceThreadMessages(threadId: string, messages: DesktopMessage[]): void {
    const thread = this.getThread(threadId);
    if (!thread) {
      throw new Error(`Thread ${threadId} does not exist`);
    }

    this.state.messagesByThread[threadId] = messages.map((message) => ({ ...message }));
    thread.updatedAt = now();

    const lastMessage = messages[messages.length - 1];
    thread.lastMessagePreview = lastMessage
      ? previewText(lastMessage.content) || thread.lastMessagePreview
      : thread.lastMessagePreview;

    this.sortThreads();
    this.persist();
  }

  buildSnapshot(
    runtimeStatus: DesktopRuntimeStatus,
    provider: DesktopProvider,
    availableProviders: DesktopProviderOption[],
    model: DesktopModel,
    availableModels: DesktopModelOption[],
    auth: DesktopAuthState,
  ): DesktopSnapshot {
    return {
      activeThreadId: this.state.activeThreadId,
      threads: this.listThreads(),
      messagesByThread: this.getMessagesByThread(),
      provider,
      availableProviders,
      model,
      availableModels,
      auth,
      runtimeStatus,
    };
  }
}
