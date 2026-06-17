import {
  FULL_TEXT_PREVIEW_BYTE_LIMIT,
  INITIAL_TEXT_PREVIEW_BYTE_LIMIT,
  MAX_TEXT_PREVIEW_LINES,
  PREVIEW_INITIAL_MAX_LINES,
} from '@/lib/file-preview-limits';

export interface TextPreviewResponse {
  text: string;
  truncated: boolean;
  truncatedBy?: 'lines' | 'bytes';
  totalLines: number | null;
  maxLines: number;
  contentType?: string;
  size?: number;
}

export class BinaryTextPreviewError extends Error {
  constructor(message = 'File is not text-previewable') {
    super(message);
    this.name = 'BinaryTextPreviewError';
  }
}

export class FullTextPreviewTooLargeError extends Error {
  constructor(message = 'File is too large to preview in full') {
    super(message);
    this.name = 'FullTextPreviewTooLargeError';
  }
}

export type TextPreviewMode = 'initial' | 'full';

const TEXT_PREVIEW_EXTENSIONS = new Set([
  'bash',
  'c',
  'cpp',
  'css',
  'csv',
  'go',
  'h',
  'hpp',
  'htm',
  'html',
  'java',
  'js',
  'json',
  'jsonl',
  'jsx',
  'log',
  'md',
  'py',
  'rs',
  'sh',
  'sql',
  'svg',
  'toml',
  'ts',
  'tsx',
  'tsv',
  'txt',
  'xml',
  'yaml',
  'yml',
  'zsh',
]);

const TEXTUAL_VENDOR_CONTENT_TYPES = new Set([
  'application/vnd.api+json',
  'application/vnd.github+json',
  'application/vnd.oai.openapi+json',
]);

function countNewlines(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) count += 1;
  }
  return count;
}

function findNthNewlineIndex(value: string, newlineCount: number): number {
  let seen = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 10) continue;
    seen += 1;
    if (seen === newlineCount) return index;
  }
  return -1;
}

function getPathExtension(path?: string): string {
  if (!path) return '';
  const filename = path.split(/[\\/]/).pop()?.trim() ?? '';
  const lastDot = filename.lastIndexOf('.');
  if (lastDot === -1 || lastDot === filename.length - 1) return '';
  return filename.slice(lastDot + 1).toLowerCase();
}

function isTextPreviewExtension(path?: string): boolean {
  const extension = getPathExtension(path);
  return extension ? TEXT_PREVIEW_EXTENSIONS.has(extension) : false;
}

function isClearlyBinaryContentType(contentType?: string, path?: string): boolean {
  if (!contentType) return false;
  const normalized = contentType.split(';')[0]?.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.startsWith('text/')) return false;
  if (
    normalized.endsWith('+json') ||
    normalized.endsWith('+xml') ||
    TEXTUAL_VENDOR_CONTENT_TYPES.has(normalized)
  ) {
    return false;
  }
  if (new Set([
    'application/json',
    'application/x-ndjson',
    'application/javascript',
    'application/typescript',
    'application/xml',
    'application/octet-stream',
    'image/svg+xml',
  ]).has(normalized)) {
    return false;
  }
  return (
    normalized.startsWith('image/') ||
    normalized.startsWith('audio/') ||
    normalized.startsWith('video/') ||
    normalized === 'application/pdf' ||
    normalized === 'application/zip' ||
    normalized === 'application/x-tar' ||
    normalized === 'application/gzip' ||
    (
      normalized.startsWith('application/vnd.') &&
      !isTextPreviewExtension(path)
    )
  );
}

function chunkLooksBinary(chunk: Uint8Array): boolean {
  let suspicious = 0;
  for (const byte of chunk) {
    if (byte === 0) return true;
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13 && byte !== 27) {
      suspicious += 1;
    }
  }
  return suspicious > Math.max(8, chunk.byteLength * 0.05);
}

export function normalizeTextPreviewMaxLines(raw: string | null): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return PREVIEW_INITIAL_MAX_LINES;
  return Math.max(1, Math.min(Math.floor(parsed), MAX_TEXT_PREVIEW_LINES));
}

export async function readTextPreviewFromStream(
  stream: ReadableStream<Uint8Array>,
  {
    mode,
    maxLines,
    contentType,
    path,
    size,
    fullByteLimit = FULL_TEXT_PREVIEW_BYTE_LIMIT,
  }: {
    mode: TextPreviewMode;
    maxLines: number;
    contentType?: string;
    path?: string;
    size?: number;
    fullByteLimit?: number;
  }
): Promise<TextPreviewResponse> {
  if (isClearlyBinaryContentType(contentType, path)) {
    await stream.cancel().catch(() => {});
    throw new BinaryTextPreviewError();
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let truncated = false;
  let truncatedBy: TextPreviewResponse['truncatedBy'];
  let cancelledEarly = false;
  let bytesRead = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      if (mode === 'full') {
        if (chunkLooksBinary(value)) {
          cancelledEarly = true;
          await reader.cancel().catch(() => {});
          throw new BinaryTextPreviewError();
        }
        bytesRead += value.byteLength;
        if (bytesRead > fullByteLimit) {
          cancelledEarly = true;
          await reader.cancel().catch(() => {});
          throw new FullTextPreviewTooLargeError();
        }
        text += decoder.decode(value, { stream: true });
      } else {
        const remainingByteBudget = INITIAL_TEXT_PREVIEW_BYTE_LIMIT - bytesRead;
        if (remainingByteBudget <= 0) {
          truncated = true;
          truncatedBy = 'bytes';
          cancelledEarly = true;
          await reader.cancel().catch(() => {});
          break;
        }
        const chunkCrossesByteLimit = value.byteLength > remainingByteBudget;
        const chunkToDecode = chunkCrossesByteLimit
          ? value.slice(0, remainingByteBudget)
          : value;
        if (chunkLooksBinary(chunkToDecode)) {
          cancelledEarly = true;
          await reader.cancel().catch(() => {});
          throw new BinaryTextPreviewError();
        }
        bytesRead += chunkToDecode.byteLength;
        text += decoder.decode(chunkToDecode, { stream: true });

        const cutoff = findNthNewlineIndex(text, maxLines);
        if (cutoff !== -1) {
          text = text.slice(0, cutoff);
          truncated = true;
          truncatedBy = 'lines';
          cancelledEarly = true;
          await reader.cancel().catch(() => {});
          break;
        }
        if (chunkCrossesByteLimit) {
          truncated = true;
          truncatedBy = 'bytes';
          cancelledEarly = true;
          await reader.cancel().catch(() => {});
          break;
        }
      }
    }

    if (!cancelledEarly) {
      text += decoder.decode();
    }
  } finally {
    reader.releaseLock();
  }

  return {
    text,
    truncated,
    ...(truncatedBy ? { truncatedBy } : {}),
    totalLines: truncated ? null : countNewlines(text) + 1,
    maxLines,
    contentType,
    size,
  };
}
