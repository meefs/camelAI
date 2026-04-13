import type { Message } from '@/types';

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

function coerceMessages(value: unknown): Message[] {
  return Array.isArray(value) ? value.filter(isMessage) : [];
}

export async function readMessagesFromResponse(response: Response): Promise<Message[]> {
  const payload = await response.json() as { success?: unknown; messages?: unknown };
  if (payload.success !== true) {
    return [];
  }
  return coerceMessages(payload.messages);
}
