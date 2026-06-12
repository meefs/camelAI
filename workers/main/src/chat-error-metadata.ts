export const CHAT_ERROR_MESSAGE_LIMIT = 300;
export const CHAT_ERROR_MODEL_HISTORY_LIMIT = 12;

export interface ChatErrorMetadataInput {
  threadId: string;
  orgId: string;
  workspaceId: string;
  userId?: string | null;
  message: string;
  source?: string | null;
  errorKind?: string | null;
  status?: number | null;
  provider?: string | null;
  model?: string | null;
  createdAt?: number | null;
}

export interface ChatErrorEventPayload {
  id: string;
  fingerprint: string;
  thread_id: string;
  org_id: string;
  workspace_id: string;
  user_id: string | null;
  created_at: number;
  source: string;
  error_kind: string | null;
  status: number | null;
  provider: string | null;
  model: string | null;
  message_normalized: string;
  message_sample: string;
}

export function truncateChatMetadata(value: unknown, limit = CHAT_ERROR_MESSAGE_LIMIT): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length > limit ? normalized.slice(0, limit) : normalized;
}

export function normalizeChatErrorSource(value: unknown): string {
  const source = typeof value === "string" ? value.trim().toLowerCase() : "";
  return source.replace(/[^a-z0-9_-]+/g, "_").slice(0, 64) || "chat_event";
}

export function normalizeChatErrorStatus(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const status = Math.trunc(value);
    return status >= 100 && status <= 599 ? status : null;
  }
  if (typeof value === "string" && /^\d{3}$/.test(value.trim())) {
    return normalizeChatErrorStatus(Number(value.trim()));
  }
  return null;
}

export function normalizeChatErrorKind(value: unknown, message?: string, status?: number | null): string | null {
  const explicit = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (explicit) return explicit.replace(/[^a-z0-9_-]+/g, "_").slice(0, 64);

  const text = message?.toLowerCase() ?? "";
  if (status === 401 || status === 403 || /\bauth(orization|entication)?\b/.test(text)) return "auth";
  if (status === 402 || /\bbilling\b|\bcredit\b|\bpayment\b/.test(text)) return "billing";
  if (status === 429 || /\brate limit\b|\bquota\b|\btoo many requests\b/.test(text)) return "rate_limit";
  if ((status !== null && status !== undefined && status >= 500) || /\bprovider\b|\bmodel\b|\bupstream\b/.test(text)) {
    return "provider";
  }
  if (/\bruntime\b|\bsandbox\b|\bcontainer\b|\bworker\b/.test(text)) return "runtime";
  return "unknown";
}

export function normalizeChatErrorMessage(message: string): string {
  const withoutStack = message
    .split(/\r?\n/)
    .filter((line) => !/^\s*at\s+\S+/.test(line))
    .join(" ");
  return withoutStack
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[1-5][A-Fa-f0-9]{3}-[89ABab][A-Fa-f0-9]{3}-[A-Fa-f0-9]{12}\b/g, "[uuid]")
    .replace(/\b(?:req|request|trace|span|run|thread|workspace|org|user)[_-]?id[:=]\s*['"]?[A-Za-z0-9._:-]{8,}['"]?/gi, "id=[id]")
    .replace(/\b[A-Fa-f0-9]{24,}\b/g, "[hex]")
    .replace(/\b[A-Za-z0-9+/]{48,}={0,2}\b/g, "[blob]")
    .replace(/:\d+:\d+\b/g, ":[line]:[col]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CHAT_ERROR_MESSAGE_LIMIT);
}

export function normalizeModelHistoryValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return null;
  return normalized.slice(0, 160);
}

export function parseModelHistory(value: unknown, fallbackModel?: unknown): string[] {
  const models: string[] = [];
  const add = (candidate: unknown) => {
    const normalized = normalizeModelHistoryValue(candidate);
    if (normalized && !models.includes(normalized) && models.length < CHAT_ERROR_MODEL_HISTORY_LIMIT) {
      models.push(normalized);
    }
  };

  if (Array.isArray(value)) {
    for (const item of value) add(item);
  } else if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) add(item);
      } else {
        add(value);
      }
    } catch {
      add(value);
    }
  }

  if (models.length === 0) add(fallbackModel);
  return models;
}

export function mergeModelHistory(existing: unknown, nextModel: unknown): string {
  const models = parseModelHistory(existing);
  const normalized = normalizeModelHistoryValue(nextModel);
  if (normalized && !models.includes(normalized)) {
    models.push(normalized);
  }
  return JSON.stringify(models.slice(0, CHAT_ERROR_MODEL_HISTORY_LIMIT));
}

export function createChatErrorFingerprint(input: {
  source: string;
  messageNormalized: string;
  errorKind?: string | null;
  status?: number | null;
  provider?: string | null;
  model?: string | null;
}): string {
  const raw = [
    input.source,
    input.errorKind ?? "",
    input.status ?? "",
    input.provider ?? "",
    input.model ?? "",
    input.messageNormalized,
  ].join("|");
  return `err_${fnv1a(raw)}`;
}

export function buildChatErrorEventPayload(input: ChatErrorMetadataInput): ChatErrorEventPayload {
  const createdAt = Number.isFinite(input.createdAt ?? NaN)
    ? Math.trunc(input.createdAt as number)
    : Date.now();
  const source = normalizeChatErrorSource(input.source);
  const status = normalizeChatErrorStatus(input.status);
  const messageSample = normalizeChatErrorMessage(input.message) || "Unknown chat error";
  const messageNormalized = messageSample;
  const errorKind = normalizeChatErrorKind(input.errorKind, messageNormalized, status);
  const provider = truncateChatMetadata(input.provider, 80);
  const model = truncateChatMetadata(input.model, 160);
  const fingerprint = createChatErrorFingerprint({
    source,
    messageNormalized,
    errorKind,
    status,
    provider,
    model,
  });

  return {
    id: `${input.threadId}:${createdAt}:${fingerprint}`,
    fingerprint,
    thread_id: input.threadId,
    org_id: input.orgId,
    workspace_id: input.workspaceId,
    user_id: truncateChatMetadata(input.userId, 160),
    created_at: createdAt,
    source,
    error_kind: errorKind,
    status,
    provider,
    model,
    message_normalized: messageNormalized,
    message_sample: messageSample,
  };
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
