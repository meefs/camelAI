export interface ChatDebugFlags {
  statusSocket: boolean;
  statusRevalidate: boolean;
  markViewed: boolean;
  historyLogs: boolean;
}

export const CHAT_DEBUG_STORAGE_KEY = "camelai.chatDebug";

const DEFAULT_CHAT_DEBUG_FLAGS: ChatDebugFlags = {
  statusSocket: true,
  statusRevalidate: true,
  markViewed: true,
  historyLogs: false,
};

const FLAG_ALIASES: Record<string, keyof ChatDebugFlags> = {
  status: "statusSocket",
  statussocket: "statusSocket",
  statusSocket: "statusSocket",
  statusrevalidate: "statusRevalidate",
  statusRevalidate: "statusRevalidate",
  revalidate: "statusRevalidate",
  markviewed: "markViewed",
  markViewed: "markViewed",
  viewed: "markViewed",
  history: "historyLogs",
  historylogs: "historyLogs",
  historyLogs: "historyLogs",
  logs: "historyLogs",
};

function normalizeFlagName(name: string): keyof ChatDebugFlags | null {
  const trimmed = name.trim();
  return FLAG_ALIASES[trimmed] ?? FLAG_ALIASES[trimmed.toLowerCase()] ?? null;
}

function parseBooleanFlag(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 0) return false;
    if (value === 1) return true;
    return null;
  }
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (["0", "false", "off", "no", "disabled"].includes(normalized)) {
    return false;
  }
  if (["1", "true", "on", "yes", "enabled"].includes(normalized)) {
    return true;
  }
  return null;
}

export function parseChatDebugFlags(
  raw: string | null | undefined,
  base: ChatDebugFlags = DEFAULT_CHAT_DEBUG_FLAGS,
): ChatDebugFlags {
  const flags = { ...base };
  if (!raw?.trim()) return flags;

  const applyFlag = (name: string, value: unknown) => {
    const key = normalizeFlagName(name);
    const parsedValue = parseBooleanFlag(value);
    if (!key || parsedValue === null) return;
    flags[key] = parsedValue;
  };

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [name, value] of Object.entries(parsed)) {
        applyFlag(name, value);
      }
      return flags;
    }
  } catch {
    // Fall through to compact string parsing.
  }

  for (const token of raw.split(/[,\s]+/)) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    const [name, value = "false"] = trimmed.split(/[:=]/, 2);
    applyFlag(name, value);
  }

  return flags;
}

function applySearchParamFlags(flags: ChatDebugFlags, search: string) {
  const params = new URLSearchParams(search);
  const compact = params.get("chatDebug") ?? params.get("chat_debug");
  let next = compact ? parseChatDebugFlags(compact, flags) : flags;

  for (const [name, value] of params) {
    const flagName =
      name.startsWith("chatDebug.")
        ? name.slice("chatDebug.".length)
        : name.startsWith("chat_debug_")
          ? name.slice("chat_debug_".length)
          : null;
    if (!flagName) continue;
    const key = normalizeFlagName(flagName);
    if (!key) continue;
    const parsedValue = parseBooleanFlag(value);
    if (parsedValue === null) continue;
    next = { ...next, [key]: parsedValue };
  }

  return next;
}

export function getChatDebugFlags(): ChatDebugFlags {
  if (typeof window === "undefined") return DEFAULT_CHAT_DEBUG_FLAGS;

  let flags = DEFAULT_CHAT_DEBUG_FLAGS;
  try {
    flags = parseChatDebugFlags(window.localStorage.getItem(CHAT_DEBUG_STORAGE_KEY));
  } catch {
    flags = DEFAULT_CHAT_DEBUG_FLAGS;
  }

  try {
    return applySearchParamFlags(flags, window.location.search);
  } catch {
    return flags;
  }
}
