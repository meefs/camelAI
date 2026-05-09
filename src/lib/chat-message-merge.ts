import type { Message } from "@/types";

function messageKeys(message: Message): string[] {
  return [message.id, message.clientMessageId]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
}

function serverHasMessage(serverKeys: Set<string>, message: Message): boolean {
  return messageKeys(message).some((key) => serverKeys.has(key));
}

/**
 * Server history is authoritative. The only client messages allowed to sit on
 * top are explicit pending user sends that have not been accepted yet.
 */
export function mergeServerAndLocalMessages(
  serverMessages: Message[],
  pendingMessages: Message[],
): Message[] {
  if (pendingMessages.length === 0) {
    return serverMessages;
  }

  const serverKeys = new Set(serverMessages.flatMap(messageKeys));
  const pending = pendingMessages.filter(
    (message) =>
      message.role === "user" && !serverHasMessage(serverKeys, message),
  );

  if (pending.length === 0) {
    return serverMessages;
  }

  return [...serverMessages, ...pending];
}
