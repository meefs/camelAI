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

interface ContentFeatures {
  blockCount: number;
  structuredCount: number;
  textLength: number;
  toolUseIds: Set<string>;
  toolResultIds: Set<string>;
}

function collectContentFeatures(content: Message["content"]): ContentFeatures {
  const features: ContentFeatures = {
    blockCount: 0,
    structuredCount: 0,
    textLength: contentText(content).length,
    toolUseIds: new Set(),
    toolResultIds: new Set(),
  };

  if (!Array.isArray(content)) {
    return features;
  }

  features.blockCount = content.length;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text") continue;
    features.structuredCount += 1;
    if (block.type === "tool_use" && block.id) {
      features.toolUseIds.add(block.id);
    } else if (block.type === "tool_result" && block.tool_use_id) {
      features.toolResultIds.add(block.tool_use_id);
    }
  }

  return features;
}

function hasIdsMissingFrom(
  candidateIds: Set<string>,
  targetIds: Set<string>,
): boolean {
  for (const id of candidateIds) {
    if (!targetIds.has(id)) return true;
  }
  return false;
}

function shouldPreferLocalContent(server: Message, local: Message): boolean {
  if (server.role !== local.role) return false;

  const serverFeatures = collectContentFeatures(server.content);
  const localFeatures = collectContentFeatures(local.content);

  if (
    serverFeatures.blockCount === 0 &&
    serverFeatures.textLength === 0 &&
    (localFeatures.blockCount > 0 || localFeatures.textLength > 0)
  ) {
    return true;
  }
  if (
    hasIdsMissingFrom(localFeatures.toolUseIds, serverFeatures.toolUseIds) ||
    hasIdsMissingFrom(localFeatures.toolResultIds, serverFeatures.toolResultIds)
  ) {
    return true;
  }
  if (localFeatures.structuredCount > serverFeatures.structuredCount) {
    return true;
  }
  if (
    localFeatures.textLength > serverFeatures.textLength &&
    (local.isStreaming || serverFeatures.textLength === 0)
  ) {
    return true;
  }

  return false;
}

function mergeServerLocalMessage(server: Message, local: Message): Message {
  const preferLocalContent = shouldPreferLocalContent(server, local);
  return {
    ...server,
    content: preferLocalContent ? local.content : server.content,
    isStreaming: preferLocalContent
      ? Boolean(local.isStreaming || server.isStreaming)
      : server.isStreaming,
    _blockOffset: preferLocalContent ? local._blockOffset : server._blockOffset,
    isMeta: server.isMeta || local.isMeta,
    forkEntryId: server.forkEntryId ?? local.forkEntryId,
    sourceToolUseID: server.sourceToolUseID ?? local.sourceToolUseID,
  };
}

function messageIdentityKeys(message: Message): string[] {
  return [message.id, message.forkEntryId]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
}

function findLocalMessageForServerMessage(
  serverMessage: Message,
  localMessages: Message[],
  consumedLocalIds: Set<string>,
): Message | null {
  const serverKeys = new Set(messageIdentityKeys(serverMessage));
  if (serverKeys.size === 0) return null;

  for (const localMessage of localMessages) {
    if (consumedLocalIds.has(localMessage.id)) continue;
    if (localMessage.role !== serverMessage.role) continue;
    if (messageIdentityKeys(localMessage).some((key) => serverKeys.has(key))) {
      return localMessage;
    }
  }

  return null;
}

function findPriorUser(message: Message, messages: Message[]): Message | null {
  let prior: Message | null = null;
  const messageIndex = messages.findIndex((candidate) => candidate.id === message.id);
  for (const candidate of messages) {
    if (candidate.id === message.id) continue;
    if (candidate.role !== "user") continue;
    const candidateIndex = messages.findIndex(
      (entry) => entry.id === candidate.id,
    );
    const candidateAppearsBeforeMessage =
      messageIndex >= 0 && candidateIndex >= 0 && candidateIndex < messageIndex;
    if (!candidateAppearsBeforeMessage && candidate.created_at > message.created_at) {
      continue;
    }
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
  const serverIds = new Set(serverMessages.map((message) => message.id));
  const serverUser = matchedServerUsersByLocalId.get(localUser.id) ??
    (serverIds.has(localUser.id) && localUser.role === "user" ? localUser : null);
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
  const consumedLocalIds = new Set<string>();
  const mergedServerMessages = serverMessages.map((serverMessage) => {
    const localMessage = findLocalMessageForServerMessage(
      serverMessage,
      localMessages,
      consumedLocalIds,
    );
    if (!localMessage) return serverMessage;
    consumedLocalIds.add(localMessage.id);
    return mergeServerLocalMessage(serverMessage, localMessage);
  });
  const serverIds = new Set(mergedServerMessages.map((msg) => msg.id));
  const consumedServerUserIds = new Set<string>();
  const matchedServerUsersByLocalId = new Map<string, Message>();

  for (const msg of [...localMessages].sort((a, b) => a.created_at - b.created_at)) {
    if (serverIds.has(msg.id) || msg.role !== "user") continue;
    const serverUser = findMatchingServerUserForLocalUser(
      msg,
      mergedServerMessages,
      consumedServerUserIds,
    );
    if (!serverUser) continue;
    consumedServerUserIds.add(serverUser.id);
    matchedServerUsersByLocalId.set(msg.id, serverUser);
  }

  const localSortTimestamp = (message: Message): number => {
    if (message.role !== "assistant") return message.created_at;
    const localUser = findPriorUser(message, localMessages);
    if (!localUser) return message.created_at;
    const serverUser = matchedServerUsersByLocalId.get(localUser.id);
    if (!serverUser || serverUser.created_at < message.created_at) {
      return message.created_at;
    }
    return serverUser.created_at + 1;
  };

  const unsyncedLocalMessages = localMessages.filter((msg) => {
    if (consumedLocalIds.has(msg.id)) return false;
    if (serverIds.has(msg.id)) return false;
    if (msg.role === "user" && matchedServerUsersByLocalId.has(msg.id)) {
      return false;
    }
    if (
      msg.role === "assistant" &&
      hasServerAssistantForLocalTurn(
        msg,
        localMessages,
        mergedServerMessages,
        matchedServerUsersByLocalId,
      )
    ) {
      return false;
    }
    return true;
  });
  if (unsyncedLocalMessages.length === 0) {
    return mergedServerMessages;
  }
  return [...mergedServerMessages, ...unsyncedLocalMessages].sort(
    (a, b) => localSortTimestamp(a) - localSortTimestamp(b),
  );
}
