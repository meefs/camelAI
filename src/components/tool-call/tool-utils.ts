import type { ContentBlock, ToolResultBlock } from '@/types';

/** True when the tool name represents a sub-agent invocation (Task or Agent). */
export function isSubAgentTool(name?: string): boolean {
  return name === 'Task' || name === 'Agent';
}

/**
 * Strips ANSI escape codes from a string.
 * Handles color codes, cursor movement, and other terminal control sequences.
 */
export function stripAnsi(str: string): string {
  // Match ANSI escape sequences: CSI (Control Sequence Introducer) and OSC (Operating System Command)
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(?:\x07|\x1b\\)/g, '');
}

function isContentBlock(value: unknown): value is ContentBlock {
  if (!value || typeof value !== 'object' || !('type' in value)) return false;
  const type = (value as { type?: string }).type;
  return (
    type === 'text' ||
    type === 'tool_use' ||
    type === 'tool_result' ||
    type === 'thinking' ||
    type === 'redacted_thinking' ||
    type === 'teammate_message' ||
    type === 'task_notification'
  );
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
        if (block.type === 'thinking') {
          const summaryText = Array.isArray(block.summaries) ? block.summaries.join('\n\n') : '';
          return summaryText
            ? `[Thinking Summary]\n${summaryText}\n\n[Thinking]\n${block.thinking}`
            : `[Thinking]\n${block.thinking}`;
        }
        if (block.type === 'redacted_thinking') return '[Thinking redacted]';
        if (block.type === 'tool_use') return `[Tool: ${block.name}]\n${safeJsonStringify(block.input)}`;
        if (block.type === 'tool_result') return `[Result]\n${normalizeToolResultContent(block.content)}`;
        if (block.type === 'teammate_message') return `[Update from ${block.teammateId}]\n${block.content}`;
        if (block.type === 'task_notification') return `[Task ${block.status}] ${block.summary}`;
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
