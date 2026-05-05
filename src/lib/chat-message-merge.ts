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
  consumedServerUserIds = new Set<string>(),
): Message | null {
  const localText = turnText(localUser.content);
  if (!localText) return null;

  let best: Message | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const message of serverMessages) {
    if (message.role !== "user") continue;
    if (consumedServerUserIds.has(message.id)) continue;
    if (turnText(message.content) !== localText) continue;

    const offset = message.created_at - localUser.created_at;
    if (offset < -1000 || offset > 5 * 60 * 1000) continue;

    const distance = Math.abs(offset);
    if (distance < bestDistance) {
      best = message;
      bestDistance = distance;
    }
  }

  return best;
}

function hasServerAssistantForLocalTurn(
  localAssistant: Message,
  localMessages: Message[],
  serverMessages: Message[],
  matchedServerUsersByLocalId: Map<string, Message>,
): boolean {
  const localUser = findPriorUser(localAssistant, localMessages);
  if (!localUser) return false;
  const serverUser = matchedServerUsersByLocalId.get(localUser.id);
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
  const consumedServerUserIds = new Set<string>();
  const matchedServerUsersByLocalId = new Map<string, Message>();

  for (const msg of [...localMessages].sort((a, b) => a.created_at - b.created_at)) {
    if (serverIds.has(msg.id) || msg.role !== "user") continue;
    const serverUser = findMatchingServerUserForLocalUser(
      msg,
      serverMessages,
      consumedServerUserIds,
    );
    if (!serverUser) continue;
    consumedServerUserIds.add(serverUser.id);
    matchedServerUsersByLocalId.set(msg.id, serverUser);
  }

  const unsyncedLocalMessages = localMessages.filter((msg) => {
    if (serverIds.has(msg.id)) return false;
    if (msg.role === "user" && matchedServerUsersByLocalId.has(msg.id)) {
      return false;
    }
    if (
      msg.role === "assistant" &&
      hasServerAssistantForLocalTurn(
        msg,
        localMessages,
        serverMessages,
        matchedServerUsersByLocalId,
      )
    ) {
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
