import type { UIMessage } from "ai";

export const CHAT_RENDER_WINDOW_MAX_MESSAGES = 50;
export const CHAT_RENDER_WINDOW_MAX_BYTES = 4 * 1024 * 1024;

export interface ChatRenderHistoryPage {
  messages: UIMessage[];
  nextCursor: string | null;
  hasMore: boolean;
}

export type ResidentRenderHistoryUpdate =
  | { kind: "initial"; evicted: UIMessage[] }
  | { kind: "rollover"; evicted: UIMessage[] }
  | { kind: "replacement"; evicted: UIMessage[] };

export function shouldHydrateRenderHistoryCursor(
  generation: number,
  previousProp: string | null,
  nextProp: string | null,
): boolean {
  return generation === 0 && previousProp !== nextProp;
}

export function isCurrentRenderHistoryGeneration(
  requestGeneration: number,
  currentGeneration: number,
): boolean {
  return requestGeneration === currentGeneration;
}

export function prependOlderRenderMessages(
  current: UIMessage[],
  older: UIMessage[],
): UIMessage[] {
  if (older.length === 0) return current;

  const currentIds = new Set(current.map((message) => message.id));
  const seenOlderIds = new Set<string>();
  const uniqueOlder = older.filter((message) => {
    if (currentIds.has(message.id) || seenOlderIds.has(message.id)) return false;
    seenOlderIds.add(message.id);
    return true;
  });

  return uniqueOlder.length === 0 ? current : [...uniqueOlder, ...current];
}

export function findEvictedRenderMessages(
  previousResident: UIMessage[],
  nextResident: UIMessage[],
): UIMessage[] {
  const update = classifyResidentRenderHistoryUpdate(
    previousResident,
    nextResident,
  );
  return update.kind === "rollover" ? update.evicted : [];
}

export function classifyResidentRenderHistoryUpdate(
  previousResident: UIMessage[],
  nextResident: UIMessage[],
): ResidentRenderHistoryUpdate {
  if (previousResident.length === 0) return { kind: "initial", evicted: [] };
  if (nextResident.length === 0) return { kind: "replacement", evicted: [] };

  const nextFirstId = nextResident[0].id;
  const overlapStart = previousResident.findIndex(
    (message) => message.id === nextFirstId,
  );
  if (overlapStart < 0) return { kind: "replacement", evicted: [] };

  const previousSuffix = previousResident.slice(overlapStart);
  if (
    nextResident.length < previousSuffix.length ||
    previousSuffix.some(
      (message, index) => message.id !== nextResident[index]?.id,
    )
  ) {
    return { kind: "replacement", evicted: [] };
  }
  return {
    kind: "rollover",
    evicted: previousResident.slice(0, overlapStart),
  };
}

export function appendEvictedRenderMessages(
  current: UIMessage[],
  evicted: UIMessage[],
): UIMessage[] {
  if (evicted.length === 0) return current;

  const seen = new Set(current.map((message) => message.id));
  const uniqueEvicted = evicted.filter((message) => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
  return uniqueEvicted.length === 0 ? current : [...current, ...uniqueEvicted];
}
