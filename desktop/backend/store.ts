import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type {
  DesktopMessage,
  DesktopModel,
  DesktopRuntimeStatus,
  DesktopSnapshot,
  DesktopThread,
} from '../shared/protocol';
import type { ContentBlock } from '../../src/types';
import { extractTextContent } from '../shared/message-state';
import { getDefaultConfiguredModel } from './anthropic';

interface PersistedState {
  activeThreadId: string | null;
  model: DesktopModel;
  threads: DesktopThread[];
  messagesByThread: Record<string, DesktopMessage[]>;
}

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
      const parsed = JSON.parse(raw) as PersistedState;
      return {
        activeThreadId: parsed.activeThreadId ?? null,
        model: parsed.model === 'opus' || parsed.model === 'sonnet' ? parsed.model : getDefaultConfiguredModel(),
        threads: Array.isArray(parsed.threads) ? parsed.threads : [],
        messagesByThread: parsed.messagesByThread ?? {},
      };
    } catch {
      return {
        activeThreadId: null,
        model: getDefaultConfiguredModel(),
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

  getModel(): DesktopModel {
    return this.state.model;
  }

  setModel(model: DesktopModel): void {
    this.state.model = model;
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

  getThreadMessages(threadId: string): DesktopMessage[] {
    return (this.state.messagesByThread[threadId] ?? []).map((message) => ({ ...message }));
  }

  createThread(title = DEFAULT_THREAD_TITLE): DesktopThread {
    const thread: DesktopThread = {
      id: randomUUID(),
      title: title.trim() || DEFAULT_THREAD_TITLE,
      createdAt: now(),
      updatedAt: now(),
      lastMessagePreview: null,
    };
    this.state.threads.unshift(thread);
    this.state.messagesByThread[thread.id] = [];
    this.state.activeThreadId = thread.id;
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
    model: DesktopModel,
    auth: {
      hasClaudeAuth: boolean;
      authSource: DesktopSnapshot['authSource'];
    }
  ): DesktopSnapshot {
    return {
      activeThreadId: this.state.activeThreadId,
      threads: this.listThreads(),
      messagesByThread: this.getMessagesByThread(),
      model,
      hasClaudeAuth: auth.hasClaudeAuth,
      authSource: auth.authSource,
      runtimeStatus,
    };
  }
}
