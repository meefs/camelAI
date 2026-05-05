import type { ContentBlock, Message } from "@/types";

function contentText(content: Message["content"]): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const entry = block as ContentBlock;
      if (entry.type === "text") {
        return entry.text;
      }
      if (entry.type === "thinking") {
        return entry.thinking;
      }
      return "";
    })
    .join("\n")
    .trim();
}

function turnText(content: Message["content"]): string {
  return contentText(content).replace(/^\[[^\]]+\]:\s*/, "");
}

function findPriorUser(message: Message, messages: Message[]): Message | null {
  let prior: Message | null = null;
  for (const candidate of messages) {
    if (candidate.created_at > message.created_at) continue;
    if (candidate.role !== "user") continue;
    if (!prior || candidate.created_at > prior.created_at) {
      prior = candidate;
    }
  }
  return prior;
}

function findMatchingServerUserForLocalUser(
  localUser: Message,
  serverMessages: Message[],
): Message | null {
  const localText = turnText(localUser.content);
  if (!localText) return null;

  return (
    serverMessages.find(
      (message) =>
        message.role === "user" &&
        turnText(message.content) === localText &&
        Math.abs(message.created_at - localUser.created_at) <= 1000,
    ) ?? null
  );
}

function hasServerAssistantForLocalTurn(
  localAssistant: Message,
  localMessages: Message[],
  serverMessages: Message[],
): boolean {
  const localUser = findPriorUser(localAssistant, localMessages);
  if (!localUser) return false;
  const serverUser = findMatchingServerUserForLocalUser(localUser, serverMessages);
  if (!serverUser) return false;

  return serverMessages.some(
    (message) =>
      message.role === "assistant" &&
      message.created_at >= serverUser.created_at &&
      message.created_at <= localAssistant.created_at + 5 * 60 * 1000,
  );
}

export function mergeServerAndLocalMessages(
  serverMessages: Message[],
  localMessages: Message[],
): Message[] {
  const serverIds = new Set(serverMessages.map((msg) => msg.id));
  const unsyncedLocalMessages = localMessages.filter((msg) => {
    if (serverIds.has(msg.id)) return false;
    if (msg.role === "user" && findMatchingServerUserForLocalUser(msg, serverMessages)) {
      return false;
    }
    if (msg.role === "assistant" && hasServerAssistantForLocalTurn(msg, localMessages, serverMessages)) {
      return false;
    }
    return true;
  });
  if (unsyncedLocalMessages.length === 0) {
    return serverMessages;
  }
  return [...serverMessages, ...unsyncedLocalMessages].sort(
    (a, b) => a.created_at - b.created_at,
  );
}
