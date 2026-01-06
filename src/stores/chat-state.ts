/**
 * Simple module-level chat state
 *
 * Just a plain object + Map with a subscription mechanism for React re-renders.
 * No dependencies, no magic.
 */

import { useEffect, useState } from 'react';
import type { Message } from '@/types';
import { applyStreamingEventToMessage, type SDKEvent } from '@/lib/streaming';

// --- State ---
const messagesByThread = new Map<string, Message[]>();
const initializedThreads = new Set<string>(); // Tracks which threads have been loaded (even if empty)
const loadingByThread = new Map<string, boolean>(); // Loading state per thread
let pendingMessages: Message[] = [];
let streamingMessageId: string | null = null;

// --- Subscriptions ---
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// --- Actions ---

export function setMessages(threadId: string, messages: Message[]) {
  messagesByThread.set(threadId, messages);
  initializedThreads.add(threadId); // Mark as initialized even if empty
  notify();
}

export function isThreadInitialized(threadId: string): boolean {
  return initializedThreads.has(threadId);
}

export function addMessage(threadId: string, message: Message) {
  const current = messagesByThread.get(threadId) || [];
  messagesByThread.set(threadId, [...current, message]);
  notify();
}

export function updateMessage(
  threadId: string,
  messageId: string,
  updater: (msg: Message) => Message
) {
  const messages = messagesByThread.get(threadId) || [];
  messagesByThread.set(
    threadId,
    messages.map((msg) => (msg.id === messageId ? updater(msg) : msg))
  );
  notify();
}

export function getMessages(threadId: string): Message[] {
  return messagesByThread.get(threadId) || EMPTY_MESSAGES;
}

// --- Pending Messages ---

export function addPendingMessage(message: Message) {
  pendingMessages = [...pendingMessages, message];
  notify();
}

export function hasPendingMessagesForThread(threadId: string): boolean {
  return pendingMessages.some((m) => m.thread_id === threadId);
}

export function clearPendingMessagesForThread(threadId: string): Message[] {
  const forThread = pendingMessages.filter((m) => m.thread_id === threadId);
  pendingMessages = pendingMessages.filter((m) => m.thread_id !== threadId);
  notify();
  return forThread;
}

// --- Streaming ---

export function getStreamingMessageId(): string | null {
  return streamingMessageId;
}

export function setStreamingMessageId(id: string | null) {
  streamingMessageId = id;
  notify();
}

export function startStreamingMessage(threadId: string, messageId: string) {
  streamingMessageId = messageId;
  const message: Message = {
    id: messageId,
    thread_id: threadId,
    role: 'assistant',
    content: [],
    created_at: Date.now(),
    isStreaming: true,
  };
  const messages = messagesByThread.get(threadId) || [];
  if (!messages.some((m) => m.id === messageId)) {
    addMessage(threadId, message);
  } else {
    notify();
  }
}

export function applyStreamingEvent(threadId: string, event: SDKEvent) {
  if (!streamingMessageId) return;
  const messages = messagesByThread.get(threadId) || [];
  messagesByThread.set(
    threadId,
    messages.map((msg) =>
      msg.id === streamingMessageId
        ? applyStreamingEventToMessage(msg, event)
        : msg
    )
  );
  notify();
}

export function finishStreaming(threadId: string) {
  if (streamingMessageId) {
    updateMessage(threadId, streamingMessageId, (msg) => ({
      ...msg,
      isStreaming: false,
    }));
  }
  streamingMessageId = null;
  loadingByThread.set(threadId, false);
  notify();
}

// --- Loading (per-thread) ---

export function getLoading(threadId: string): boolean {
  return loadingByThread.get(threadId) ?? false;
}

export function setLoading(threadId: string, value: boolean) {
  loadingByThread.set(threadId, value);
  notify();
}

// --- React Hooks ---

// Stable empty array to avoid hydration issues
const EMPTY_MESSAGES: Message[] = [];

/**
 * Hook to subscribe to messages for a thread.
 * Re-renders when any state changes (simple, no selector optimization).
 */
export function useMessages(threadId: string | undefined): Message[] {
  const [, forceUpdate] = useState({});

  useEffect(() => {
    return subscribe(() => forceUpdate({}));
  }, []);

  if (!threadId) return EMPTY_MESSAGES;
  return messagesByThread.get(threadId) || EMPTY_MESSAGES;
}

/**
 * Hook to check if currently streaming.
 */
export function useIsStreaming(): boolean {
  const [, forceUpdate] = useState({});

  useEffect(() => {
    return subscribe(() => forceUpdate({}));
  }, []);

  return streamingMessageId !== null;
}

/**
 * Hook to get loading state for a thread.
 */
export function useLoading(threadId: string | undefined): boolean {
  const [, forceUpdate] = useState({});

  useEffect(() => {
    return subscribe(() => forceUpdate({}));
  }, []);

  if (!threadId) return false;
  return loadingByThread.get(threadId) ?? false;
}

/**
 * Hook to check if a thread has been initialized (loaded from server).
 * Used to distinguish "not loaded yet" from "loaded but empty".
 */
export function useIsThreadInitialized(threadId: string | undefined): boolean {
  const [, forceUpdate] = useState({});

  useEffect(() => {
    return subscribe(() => forceUpdate({}));
  }, []);

  if (!threadId) return false;
  return initializedThreads.has(threadId);
}
