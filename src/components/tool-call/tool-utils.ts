import type { ContentBlock, ToolResultBlock } from '@/types';

function isContentBlock(value: unknown): value is ContentBlock {
  if (!value || typeof value !== 'object' || !('type' in value)) return false;
  const type = (value as { type?: string }).type;
  return type === 'text' || type === 'tool_use' || type === 'tool_result' || type === 'thinking';
}

function coerceContentBlocks(value: unknown): ContentBlock[] | null {
  if (Array.isArray(value) && value.every(isContentBlock)) return value;
  if (isContentBlock(value)) return [value];
  return null;
}

export function safeJsonStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function normalizeToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  const blocks = coerceContentBlocks(content);
  if (blocks) {
    return blocks
      .map(block => {
        if (block.type === 'text') return block.text;
        if (block.type === 'thinking') return `[Thinking]\n${block.thinking}`;
        if (block.type === 'tool_use') return `[Tool: ${block.name}]\n${safeJsonStringify(block.input)}`;
        if (block.type === 'tool_result') return `[Result]\n${normalizeToolResultContent(block.content)}`;
        return safeJsonStringify(block);
      })
      .filter(Boolean)
      .join('\n\n');
  }
  return safeJsonStringify(content);
}

export function getResultText(result?: ToolResultBlock): string {
  if (!result) return '';
  return normalizeToolResultContent(result.content);
}

export function getPreviewLines(text: string, maxLines: number): { preview: string; truncated: boolean } {
  if (!text) return { preview: '', truncated: false };
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) {
    return { preview: text, truncated: false };
  }
  const preview = [...lines.slice(0, maxLines), '...'].join('\n');
  return { preview, truncated: true };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}
