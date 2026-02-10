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
import { useAuthData } from '@/hooks/use-auth-data';
import { FilePreviewChip, parseUploadRefs } from '@/components/chat-file-preview';
import { BugReportCard, parseBugReport } from '@/components/bug-report-preview';

// Format timestamp to readable time (e.g., "12:25 PM")
function formatMessageTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * Parse author attribution from message content.
 * Messages are prefixed with [Name (email)]: or [email]:
 * Returns { author, content } where author has { name, email, displayName }
 */
interface ParsedAuthor {
  name: string | null;
  email: string | null;
  displayName: string; // Name if available, otherwise email
}

interface ParsedMessage {
  author: ParsedAuthor | null;
  content: string;
}

const AUTHOR_PREFIX_WITH_EMAIL_REGEX = /^\[([^\]]+)\s+\(([^)]+)\)\]:\s*/;
const AUTHOR_PREFIX_SIMPLE_REGEX = /^\[([^\]]+)\]:\s*/;

/**
 * Strip Chiridion system message tags from content.
 * These tags are used internally to pass context to the AI but shouldn't
 * be shown verbosely to users.
 */
function stripSystemMessageTags(text: string): string {
  return text.replace(/<chiridion system message>[\s\S]*?<\/chiridion system message>/g, '').trim();
}

function parseMessageAuthor(rawContent: string): ParsedMessage {
  const content = stripSystemMessageTags(rawContent);
  // Match [Name (email)]: or [email]: at the start of the message
  // Pattern: [Name (email)]: or [Name]: or [email]:
  const matchWithEmail = content.match(AUTHOR_PREFIX_WITH_EMAIL_REGEX);
  if (matchWithEmail) {
    const name = matchWithEmail[1]?.trim() || null;
    const email = matchWithEmail[2]?.trim() || null;
    return {
      author: {
        name,
        email,
        displayName: name || email || 'Unknown',
      },
      content: content.slice(matchWithEmail[0].length),
    };
  }

  // Match [Name]: or [email]: (no parentheses)
  const matchSimple = content.match(AUTHOR_PREFIX_SIMPLE_REGEX);
  if (matchSimple) {
    const value = matchSimple[1]?.trim() || '';
    // Check if it looks like an email
    const isEmail = value.includes('@');
    return {
      author: {
        name: isEmail ? null : value,
        email: isEmail ? value : null,
        displayName: value || 'Unknown',
      },
      content: content.slice(matchSimple[0].length),
    };
  }

  return { author: null, content };
}

/**
 * Strip author prefix from ContentBlock array.
 * Returns { author, blocks } where blocks has the prefix removed from the first text block.
 */
function stripAuthorFromBlocks(blocks: ContentBlock[]): { author: ParsedAuthor | null; blocks: ContentBlock[] } {
  if (blocks.length === 0) {
    return { author: null, blocks };
  }

  // Find the first text block
  const firstTextIndex = blocks.findIndex(block => block.type === 'text');
  if (firstTextIndex === -1) {
    return { author: null, blocks };
  }

  const firstTextBlock = blocks[firstTextIndex];
  if (firstTextBlock.type !== 'text') {
    return { author: null, blocks };
  }

  // Parse author from the first text block
  const { author, content: strippedText } = parseMessageAuthor(firstTextBlock.text);

  if (!author) {
    return { author: null, blocks };
  }

  // Create new blocks array with stripped first text block
  const newBlocks = [...blocks];
  newBlocks[firstTextIndex] = { type: 'text', text: strippedText };

  return { author, blocks: newBlocks };
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

function encodePathSegments(path: string): string {
  return path
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');
}

/**
 * Check if content has any visible text after stripping system messages.
 * Returns false if the content is entirely system messages.
 */
function hasVisibleContent(content: string | ContentBlock[]): boolean {
  if (typeof content === 'string') {
    return stripSystemMessageTags(content).length > 0;
  }
  return content.some(block => {
    if (block.type === 'text') {
      return stripSystemMessageTags(block.text).length > 0;
    }
    // Other block types (tool_use, tool_result, thinking) are always visible
    return true;
  });
}

// Convert content to string for copy functionality
export function contentToString(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return stripSystemMessageTags(content);
  return content
    .map(block => {
      if (block.type === 'text') return stripSystemMessageTags(block.text);
      if (block.type === 'tool_use') return `[Tool: ${block.name}]\n${JSON.stringify(block.input, null, 2)}`;
      if (block.type === 'tool_result') return `[Result]\n${normalizeToolResultContent(block.content)}`;
      if (block.type === 'thinking') return `[Thinking]\n${block.thinking}`;
      return '';
    })
    .filter(Boolean)
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
    const displayContent = stripSystemMessageTags(content);
    if (!displayContent) return null;
    return <MarkdownRenderer content={displayContent} isStreaming={isStreaming} />;
  }

  // Empty content
  if (content.length === 0) {
    return null;
  }

  const toolResultsById = new Map<string, ToolResultBlock[]>();
  const toolUseIds = new Set<string>();
  content.forEach(block => {
    if (block.type === 'tool_result') {
      const existing = toolResultsById.get(block.tool_use_id) ?? [];
      existing.push(block);
      toolResultsById.set(block.tool_use_id, existing);
    }
    if (block.type === 'tool_use') {
      toolUseIds.add(block.id);
    }
  });
  const items: Array<{ kind: 'tool' | 'other'; node: ReactNode; key: string }> = [];

  content.forEach((block, index) => {
    if (block.type === 'text') {
      const displayText = stripSystemMessageTags(block.text);
      // Skip empty text blocks after stripping system messages
      if (!displayText) return;
      items.push({
        kind: 'other',
        key: `text-${index}`,
        node: (
          <div className="max-w-none">
            <MarkdownRenderer content={displayText} isStreaming={isStreaming} />
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
      const results = toolResultsById.get(block.id) ?? [];
      const latestResult = results[results.length - 1];
      const isTaskTool = block.name === 'Task';
      const skillSheet = skillSheets?.get(block.id);
      // Check if the agent received results after this tool call.
      // A subsequent text block means the agent continued with a response;
      // a subsequent tool_result means results arrived for this batch.
      // Sibling tool_use blocks are excluded — parallel calls are emitted
      // together before any results arrive, so they don't prove completion.
      // Note: any tool_result (not just ID-matched ones) is sufficient because
      // parallel results arrive atomically in a single SDK user event — if one
      // result exists, all results for the batch exist (possibly with mismatched
      // IDs, which is the bug this heuristic compensates for).
      const agentContinued = content.slice(index + 1).some(
        b => b.type === 'text' || b.type === 'tool_result'
      );
      items.push({
        kind: 'tool',
        key: `tool-${block.id || index}`,
        node: (
          <ToolCall
            tool={block}
            result={latestResult}
            results={isTaskTool ? results : undefined}
            isStreaming={isStreaming}
            skillSheet={skillSheet}
            progressCount={isTaskTool ? results.length : undefined}
            agentContinued={agentContinued}
          />
        ),
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
  hostname?: string;
  orgSlug?: string;
}

export function MessageBubble({
  message,
  onCopy,
  copiedId,
  showStreamingIndicator = false,
  skillSheets,
  hostname,
  orgSlug,
}: MessageBubbleProps) {
  if (message.isMeta || message.sourceToolUseID) {
    return null;
  }

  // Hide messages that are entirely system messages (no visible content after stripping)
  if (!hasVisibleContent(message.content)) {
    return null;
  }

  const { currentWorkspace } = useAuthData();
  const isCopied = copiedId === message.id;
  const isStreaming = message.isStreaming ?? false;
  const hasContent = typeof message.content === 'string'
    ? message.content.length > 0
    : message.content.length > 0;

  if (message.role === 'user') {
    // Parse author attribution from content and strip prefix for display
    let author: ParsedAuthor | null = null;
    let displayContent: string | ContentBlock[];

    if (typeof message.content === 'string') {
      const parsed = parseMessageAuthor(message.content);
      author = parsed.author;
      displayContent = parsed.content;
    } else {
      const stripped = stripAuthorFromBlocks(message.content);
      author = stripped.author;
      displayContent = stripped.blocks;
    }

    const rawText = typeof displayContent === 'string'
      ? displayContent
      : displayContent
        .map(block => (block.type === 'text' ? block.text : ''))
        .filter(Boolean)
        .join('\n');

    const bugReport = rawText ? parseBugReport(rawText) : null;

    const uploadInfo = typeof displayContent === 'string'
      ? parseUploadRefs(displayContent)
      : { refs: [] as ReturnType<typeof parseUploadRefs>['refs'], cleanContent: displayContent };

    const previewRefs = uploadInfo.refs;
    const cleanedContent = uploadInfo.cleanContent;
    const workspaceId = currentWorkspace?.id;

    const hasCleanContent = typeof cleanedContent === 'string'
      ? cleanedContent.length > 0
      : cleanedContent.length > 0;

    if (bugReport) {
      return (
        <div className="flex flex-col items-end gap-2">
          {previewRefs.length > 0 && workspaceId && (
            <div className="flex flex-wrap gap-2">
              {previewRefs.map(ref => (
                <FilePreviewChip
                  key={ref.mountPath}
                  filename={ref.originalName}
                  previewUrl={`/api/workspaces/${workspaceId}/uploads/${encodePathSegments(ref.filename)}`}
                />
              ))}
            </div>
          )}
          <BugReportCard
            appName={bugReport.appName}
            description={bugReport.description}
            timestamp={message.created_at}
            hostname={hostname}
            orgSlug={orgSlug}
          />
          <div
            className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
            role="group"
            aria-label="Message actions"
          >
            {author && (
              <span className="text-muted-foreground text-xs mr-1">
                Sent by {author.displayName} at{' '}
              </span>
            )}
            <span className="text-muted-foreground text-xs mr-1">
              {formatMessageTime(message.created_at)}
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground"
                  onClick={() => onCopy(message.id, bugReport.originalText)}
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

    return (
      <div className="flex flex-col items-end gap-2">
        {previewRefs.length > 0 && workspaceId && (
          <div className="flex flex-wrap gap-2">
            {previewRefs.map(ref => (
              <FilePreviewChip
                key={ref.mountPath}
                filename={ref.originalName}
                previewUrl={`/api/workspaces/${workspaceId}/uploads/${encodePathSegments(ref.filename)}`}
              />
            ))}
          </div>
        )}
        {hasCleanContent && (
          <div className="max-w-[85%] px-4 py-3 rounded-3xl border border-border bg-muted/30 text-foreground">
            <ContentBlockRenderer content={cleanedContent} skillSheets={skillSheets} />
          </div>
        )}
        {/* Hover action row */}
        <div
          className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
          role="group"
          aria-label="Message actions"
        >
          {author && (
            <span className="text-muted-foreground text-xs mr-1">
              Sent by {author.displayName} at 
            </span>
          )}
          <span className="text-muted-foreground text-xs mr-1">
            {formatMessageTime(message.created_at)}
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                onClick={() => onCopy(message.id, contentToString(cleanedContent))}
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
