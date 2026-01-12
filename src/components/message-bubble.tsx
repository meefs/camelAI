'use client';

import { Copy, Check } from 'lucide-react';
import type { Message, ContentBlock, ToolResultBlock } from '@/types';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { MarkdownRenderer } from '@/components/markdown-renderer';
import { ThinkingBlock, ToolCall } from '@/components/tool-call';
import { LoadingDots } from '@/components/loading-dots';
import type { ReactNode } from 'react';

// Format timestamp to readable time (e.g., "12:25 PM")
function formatMessageTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function safeJsonStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function normalizeToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
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

// Convert content to string for copy functionality
export function contentToString(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .map(block => {
      if (block.type === 'text') return block.text;
      if (block.type === 'tool_use') return `[Tool: ${block.name}]\n${JSON.stringify(block.input, null, 2)}`;
      if (block.type === 'tool_result') return `[Result]\n${normalizeToolResultContent(block.content)}`;
      if (block.type === 'thinking') return `[Thinking]\n${block.thinking}`;
      return '';
    })
    .join('\n\n');
}

interface ContentBlockRendererProps {
  content: string | ContentBlock[];
  isStreaming?: boolean;
  skillSheets?: Map<string, string>;
}

function ContentBlockRenderer({ content, isStreaming = false, skillSheets }: ContentBlockRendererProps) {
  // String content - render as markdown
  if (typeof content === 'string') {
    return <MarkdownRenderer content={content} isStreaming={isStreaming} />;
  }

  // Empty content
  if (content.length === 0) {
    return null;
  }

  const toolResultsById = new Map<string, ToolResultBlock>();
  const toolUseIds = new Set<string>();
  content.forEach(block => {
    if (block.type === 'tool_result') {
      toolResultsById.set(block.tool_use_id, block);
    }
    if (block.type === 'tool_use') {
      toolUseIds.add(block.id);
    }
  });
  const items: Array<{ kind: 'tool' | 'other'; node: ReactNode; key: string }> = [];

  content.forEach((block, index) => {
    if (block.type === 'text') {
      items.push({
        kind: 'other',
        key: `text-${index}`,
        node: (
          <div className="max-w-none">
            <MarkdownRenderer content={block.text} isStreaming={isStreaming} />
          </div>
        ),
      });
      return;
    }

    if (block.type === 'thinking') {
      items.push({
        kind: 'other',
        key: `thinking-${index}`,
        node: <ThinkingBlock thinking={block.thinking} />,
      });
      return;
    }

    if (block.type === 'tool_use') {
      const result = toolResultsById.get(block.id);
      const skillSheet = skillSheets?.get(block.id);
      items.push({
        kind: 'tool',
        key: `tool-${block.id || index}`,
        node: <ToolCall tool={block} result={result} isStreaming={isStreaming} skillSheet={skillSheet} />,
      });
      return;
    }

    if (block.type === 'tool_result') {
      if (toolUseIds.has(block.tool_use_id)) return;
      items.push({
        kind: 'tool',
        key: `result-${block.tool_use_id || index}`,
        node: <ToolCall result={block} isStreaming={isStreaming} />,
      });
    }
  });

  const sections: ReactNode[] = [];
  let toolGroup: ReactNode[] = [];
  let toolGroupKey = '';

  items.forEach((item, index) => {
    if (item.kind === 'tool') {
      if (!toolGroup.length) toolGroupKey = `tools-${item.key}-${index}`;
      toolGroup.push(<div key={item.key}>{item.node}</div>);
      return;
    }

    if (toolGroup.length) {
      sections.push(
        <div key={toolGroupKey} className="space-y-1">
          {toolGroup}
        </div>
      );
      toolGroup = [];
    }

    sections.push(
      <div key={item.key}>{item.node}</div>
    );
  });

  if (toolGroup.length) {
    sections.push(
      <div key={toolGroupKey || 'tools-final'} className="space-y-1">
        {toolGroup}
      </div>
    );
  }

  return <div className="space-y-4">{sections}</div>;
}

interface MessageBubbleProps {
  message: Message;
  onCopy: (id: string, content: string) => void;
  copiedId: string | null;
  /** Whether to show the streaming loading indicator (only true for the last streaming message) */
  showStreamingIndicator?: boolean;
  skillSheets?: Map<string, string>;
}

export function MessageBubble({
  message,
  onCopy,
  copiedId,
  showStreamingIndicator = false,
  skillSheets,
}: MessageBubbleProps) {
  if (message.isMeta || message.sourceToolUseID) {
    return null;
  }

  const isCopied = copiedId === message.id;
  const isStreaming = message.isStreaming ?? false;
  const hasContent = typeof message.content === 'string'
    ? message.content.length > 0
    : message.content.length > 0;

  if (message.role === 'user') {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="max-w-[85%] px-4 py-3 rounded-3xl border border-border bg-muted/30 text-foreground">
          <ContentBlockRenderer content={message.content} skillSheets={skillSheets} />
        </div>
        {/* Hover action row */}
        <div
          className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
          role="group"
          aria-label="Message actions"
        >
          <span className="text-muted-foreground text-xs mr-1">
            {formatMessageTime(message.created_at)}
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                onClick={() => onCopy(message.id, contentToString(message.content))}
              >
                {isCopied ? <Check /> : <Copy />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {isCopied ? 'Copied!' : 'Copy message'}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    );
  }

  // Assistant message
  return (
    <div className="flex flex-col gap-1">
      <div className="max-w-none space-y-4">
        {hasContent && (
          <ContentBlockRenderer content={message.content} isStreaming={isStreaming} skillSheets={skillSheets} />
        )}
        {showStreamingIndicator && <LoadingDots />}
      </div>
      {/* Hover action row - only show when not streaming */}
      {!isStreaming && hasContent && (
        <div
          className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
          role="group"
          aria-label="Message actions"
        >
          <span className="text-muted-foreground text-xs mr-1">
            {formatMessageTime(message.created_at)}
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                onClick={() => onCopy(message.id, contentToString(message.content))}
              >
                {isCopied ? <Check /> : <Copy />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {isCopied ? 'Copied!' : 'Copy message'}
            </TooltipContent>
          </Tooltip>
        </div>
      )}
    </div>
  );
}
