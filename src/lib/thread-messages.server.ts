import type { Message } from '@/types';

const DUPLICATE_WINDOW_MS = 15_000;

function isMessage(value: unknown): value is Message {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as { id?: unknown }).id === 'string' &&
      typeof (value as { thread_id?: unknown }).thread_id === 'string' &&
      (((value as { role?: unknown }).role === 'user') || ((value as { role?: unknown }).role === 'assistant')) &&
      typeof (value as { created_at?: unknown }).created_at === 'number'
  );
}

export function coerceMessages(value: unknown): Message[] {
  return Array.isArray(value) ? value.filter(isMessage) : [];
}

function buildMessageSignature(message: Message): string {
  return JSON.stringify({
    role: message.role,
    content: message.content,
    isMeta: Boolean(message.isMeta),
    sourceToolUseID: message.sourceToolUseID ?? null,
    isCompactSummary: Boolean(message.isCompactSummary),
  });
}

function messageRichness(message: Message): number {
  const contentScore = Array.isArray(message.content)
    ? JSON.stringify(message.content).length + message.content.length * 100
    : String(message.content ?? '').length;

  return (
    contentScore +
    (message.isMeta ? 10 : 0) +
    (message.sourceToolUseID ? 10 : 0) +
    (message.isCompactSummary ? 10 : 0) +
    (message.isStreaming ? 1 : 0)
  );
}

function mergeDuplicateMessages(left: Message, right: Message): Message {
  const leftScore = messageRichness(left);
  const rightScore = messageRichness(right);
  const preferred = rightScore > leftScore ? right : left;
  const other = preferred === left ? right : left;

  return {
    ...preferred,
    created_at: Math.min(left.created_at, right.created_at),
    isMeta: preferred.isMeta || other.isMeta,
    sourceToolUseID: preferred.sourceToolUseID ?? other.sourceToolUseID,
    isCompactSummary: preferred.isCompactSummary || other.isCompactSummary,
    isStreaming: preferred.isStreaming || other.isStreaming,
  };
}

function findDuplicateIndex(messages: Message[], candidate: Message): number {
  const signature = buildMessageSignature(candidate);

  for (let index = 0; index < messages.length; index += 1) {
    const existing = messages[index];
    if (existing.id === candidate.id) {
      return index;
    }
    if (existing.role !== candidate.role) {
      continue;
    }
    if (buildMessageSignature(existing) !== signature) {
      continue;
    }
    if (Math.abs(existing.created_at - candidate.created_at) > DUPLICATE_WINDOW_MS) {
      continue;
    }
    return index;
  }

  return -1;
}

export function mergeThreadMessages(
  legacyMessages: Message[] | null | undefined,
  persistedMessages: Message[] | null | undefined,
): Message[] {
  const merged = coerceMessages(legacyMessages).map((message) => ({ ...message }));

  for (const persistedMessage of coerceMessages(persistedMessages)) {
    const duplicateIndex = findDuplicateIndex(merged, persistedMessage);
    if (duplicateIndex === -1) {
      merged.push({ ...persistedMessage });
      continue;
    }
    merged[duplicateIndex] = mergeDuplicateMessages(merged[duplicateIndex]!, persistedMessage);
  }

  return merged
    .map((message, index) => ({ message, index }))
    .sort((left, right) => (
      left.message.created_at - right.message.created_at ||
      left.index - right.index
    ))
    .map(({ message }) => message);
}

export async function readMessagesFromResponse(response: Response): Promise<Message[]> {
  const payload = await response.json() as { success?: unknown; messages?: unknown };
  if (payload.success !== true) {
    return [];
  }
  return coerceMessages(payload.messages);
}
