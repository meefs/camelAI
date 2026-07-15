// Pure helpers, constants, and types for sanitizing, serializing, and
// truncating Pi messages and tool results for SQLite/R2 storage. Extracted from
// chat-thread-do.ts. This is a leaf module — no Durable Object state and no
// import cycles.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { stripPiUiMetadata } from "../../../src/lib/runtime-artifacts";

export const PI_PROVIDER_SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
]);

export function normalizePiImageMimeType(mimeType: string): string {
  const normalized = mimeType.trim().toLowerCase();
  return normalized === "image/jpg" ? "image/jpeg" : normalized;
}

export function piUnsupportedImageText(mimeType: unknown): string {
  const label =
    typeof mimeType === "string" && mimeType.trim()
      ? mimeType.trim()
      : "unknown MIME type";
  return `(image omitted: unsupported MIME type ${label})`;
}

export interface PiInlineImageDataStripResult {
  text: string;
  count: number;
  bytes: number;
}

/** Remove inline image data URLs for model routes that cannot inspect images. */
export function stripPiInlineImageDataUrls(text: string): PiInlineImageDataStripResult {
  let count = 0;
  let bytes = 0;
  const stripped = text.replace(
    /data:image\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*;base64,([A-Za-z0-9+/_=-]+)/gi,
    (_match, data: string) => {
      count += 1;
      const imageBytes = Math.floor((data.length * 3) / 4);
      bytes += imageBytes;
      return `[inline image omitted: ${imageBytes} bytes; active model cannot inspect images]`;
    },
  );
  return { text: stripped, count, bytes };
}

export const PI_SQLITE_STORAGE_SOFT_LIMIT_CHARS = 1_500_000;
export const PI_MAX_PERSISTED_IMAGE_DATA_CHARS = 512_000;
export const PI_MAX_PERSISTED_TEXT_CHARS = 200_000;
export const PI_R2_IMAGE_REF_METADATA_KEY = "chiridionR2Image";
export const PI_TOOL_RESULT_MAX_LINES = 2_000;
export const PI_TOOL_RESULT_MAX_BYTES = 50 * 1024;
export const PI_TOOL_RESULT_R2_REF_METADATA_KEY = "chiridionR2ToolResult";
// Tools whose oversized output is truncated from the head (keeping the most
// recent lines) rather than the tail. Empty now that the shell `bash` tool is
// gone; kept as an extension point for future streaming/log-style tools.
export const PI_TAIL_TRUNCATED_TOOL_NAMES = new Set<string>();

export interface PiR2ImageReference {
  key: string;
  mimeType: string;
  size: number;
  sha256: string;
  storedAt: number;
}

export interface PiR2ToolResultReference {
  path: string;
  size: number;
  sha256: string;
  storedAt: number;
}

export interface PiToolResultTruncation {
  truncated: true;
  truncatedBy: "lines" | "bytes";
  direction: "head" | "tail";
  totalLines: number;
  outputLines: number;
  totalBytes: number;
  outputBytes: number;
  maxLines: number;
  maxBytes: number;
  fullOutput?: PiR2ToolResultReference;
}

export interface PiSqlStorageStats {
  externalizedImages: number;
  omittedImages: number;
  truncatedStrings: number;
  omittedWholeMessage: boolean;
  originalChars: number;
  storedChars: number;
}

export interface PiSqlStorageSerialization {
  payload: string;
  stats: PiSqlStorageStats;
}

export function hasPiR2ImageReferenceMetadata(record: Record<string, unknown>): boolean {
  const metadata = record.metadata;
  if (!metadata || typeof metadata !== "object") return false;
  const ref = (metadata as Record<string, unknown>)[PI_R2_IMAGE_REF_METADATA_KEY];
  if (!ref || typeof ref !== "object") return false;
  const refRecord = ref as Record<string, unknown>;
  return (
    typeof refRecord.key === "string" &&
    refRecord.key.length > 0 &&
    typeof refRecord.mimeType === "string" &&
    refRecord.mimeType.length > 0 &&
    typeof refRecord.sha256 === "string" &&
    refRecord.sha256.length > 0
  );
}

export function piLargeImageStorageText(mimeType: unknown, dataChars: number): string {
  const label =
    typeof mimeType === "string" && mimeType.trim()
      ? mimeType.trim()
      : "unknown MIME type";
  return `(image data omitted from persisted transcript: ${label}, ${dataChars} base64 chars)`;
}

export function emptyPiSqlStorageStats(): PiSqlStorageStats {
  return {
    omittedImages: 0,
    externalizedImages: 0,
    truncatedStrings: 0,
    omittedWholeMessage: false,
    originalChars: 0,
    storedChars: 0,
  };
}

export function truncatePiStorageString(value: string, stats?: PiSqlStorageStats): string {
  if (value.length <= PI_MAX_PERSISTED_TEXT_CHARS) return value;
  const omitted = value.length - PI_MAX_PERSISTED_TEXT_CHARS;
  if (stats) stats.truncatedStrings += 1;
  return `${value.slice(0, PI_MAX_PERSISTED_TEXT_CHARS)}\n\n[...truncated ${omitted} characters for storage safety...]`;
}

export function sanitizePiProviderContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  let changed = false;
  const sanitized = content.map((part) => {
    if (!part || typeof part !== "object") return part;
    const item = part as Record<string, unknown>;
    if (item.type !== "image") return part;

    const mimeType = typeof item.mimeType === "string"
      ? normalizePiImageMimeType(item.mimeType)
      : "";
    const data = typeof item.data === "string" ? item.data : "";
    if (
      mimeType &&
      PI_PROVIDER_SUPPORTED_IMAGE_MIME_TYPES.has(mimeType) &&
      (data || hasPiR2ImageReferenceMetadata(item))
    ) {
      if (mimeType === item.mimeType) return part;
      changed = true;
      return { ...item, mimeType };
    }

    changed = true;
    return { type: "text", text: piUnsupportedImageText(item.mimeType) };
  });

  return changed ? sanitized : content;
}

export function sanitizePiProviderMessage(message: AgentMessage): AgentMessage {
  if (!message || typeof message !== "object") return message;
  const record = message as unknown as Record<string, unknown>;
  if (!Array.isArray(record.content)) return message;
  const content = sanitizePiProviderContent(record.content);
  if (content === record.content) return message;
  return { ...record, content } as unknown as AgentMessage;
}

export function sanitizePiModelMessage(message: AgentMessage): AgentMessage {
  return sanitizePiProviderMessage(stripPiUiMetadata(message));
}

export function sanitizePiProviderContentForSqlStorage(content: unknown, stats?: PiSqlStorageStats): unknown {
  const supported = sanitizePiProviderContent(content);
  if (!Array.isArray(supported)) return supported;
  let changed = supported !== content;
  const sanitized = supported.map((part) => {
    if (!part || typeof part !== "object") return part;
    const item = part as Record<string, unknown>;
    if (item.type === "image") {
      const data = typeof item.data === "string" ? item.data : "";
      if (data.length > PI_MAX_PERSISTED_IMAGE_DATA_CHARS) {
        if (stats) stats.omittedImages += 1;
        changed = true;
        return {
          type: "text",
          text: piLargeImageStorageText(item.mimeType, data.length),
        };
      }
    }
    return part;
  });
  return changed ? sanitized : content;
}

export function shrinkPiValueForSqlStorage(value: unknown, depth = 0, stats?: PiSqlStorageStats): unknown {
  if (typeof value === "string") return truncatePiStorageString(value, stats);
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (depth > 8) return "[nested value omitted for storage safety]";
  if (Array.isArray(value)) {
    return value.map((item) => shrinkPiValueForSqlStorage(item, depth + 1, stats));
  }
  const record = value as Record<string, unknown>;
  if (record.type === "image" && typeof record.data === "string") {
    if (record.data.length > PI_MAX_PERSISTED_IMAGE_DATA_CHARS) {
      if (stats) stats.omittedImages += 1;
      return {
        type: "text",
        text: piLargeImageStorageText(record.mimeType, record.data.length),
      };
    }
    return { ...record, data: record.data };
  }
  const next: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(record)) {
    next[key] = shrinkPiValueForSqlStorage(nested, depth + 1, stats);
  }
  return next;
}

export function preparePiMessageForSqlStorage(message: AgentMessage, stats?: PiSqlStorageStats): AgentMessage {
  if (!message || typeof message !== "object") return message;
  const providerSanitized = sanitizePiProviderMessage(message);
  const record = providerSanitized as unknown as Record<string, unknown>;
  const content = Array.isArray(record.content)
    ? sanitizePiProviderContentForSqlStorage(record.content, stats)
    : record.content;
  const next = content === record.content ? record : { ...record, content };
  return shrinkPiValueForSqlStorage(next, 0, stats) as AgentMessage;
}

export function serializePiMessageForSqlStorageDetailed(message: AgentMessage): PiSqlStorageSerialization {
  const stats = emptyPiSqlStorageStats();
  stats.originalChars = JSON.stringify(message).length;
  let prepared = preparePiMessageForSqlStorage(message, stats);
  let serialized = JSON.stringify(prepared);
  if (serialized.length <= PI_SQLITE_STORAGE_SOFT_LIMIT_CHARS) {
    stats.storedChars = serialized.length;
    return { payload: serialized, stats };
  }

  prepared = shrinkPiValueForSqlStorage(prepared, 4, stats) as AgentMessage;
  serialized = JSON.stringify(prepared);
  if (serialized.length <= PI_SQLITE_STORAGE_SOFT_LIMIT_CHARS) {
    stats.storedChars = serialized.length;
    return { payload: serialized, stats };
  }

  stats.omittedWholeMessage = true;
  const payload = JSON.stringify({
    role: (message as unknown as Record<string, unknown>).role ?? "user",
    content: `[message omitted from persisted transcript: serialized size ${serialized.length} chars exceeded storage safety limit]`,
    timestamp:
      typeof (message as unknown as Record<string, unknown>).timestamp === "number"
        ? (message as unknown as Record<string, unknown>).timestamp
        : Date.now(),
    metadata: { storageOmitted: true },
  });
  stats.storedChars = payload.length;
  return { payload, stats };
}

export function serializePiMessageForSqlStorage(message: AgentMessage): string {
  return serializePiMessageForSqlStorageDetailed(message).payload;
}
