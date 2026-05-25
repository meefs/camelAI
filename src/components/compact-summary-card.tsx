'use client';

import { useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { ContentBlock } from '@/types';
import { MarkdownRenderer } from '@/components/markdown-renderer';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

interface CompactSummaryCardProps {
  content: string | ContentBlock[];
  workspaceId?: string;
}

export function CompactSummaryCard({ content, workspaceId }: CompactSummaryCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const displayContent = useMemo(
    () =>
      typeof content === 'string'
        ? content
        : content
            .map((block) => (block.type === 'text' ? block.text : ''))
            .filter(Boolean)
            .join('\n'),
    [content],
  );

  return (
    <Collapsible
      open={isExpanded}
      onOpenChange={setIsExpanded}
      data-testid="compact-summary"
      className="compact-summary mt-1 mb-4"
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          aria-label={
            isExpanded
              ? 'Hide compacted context summary'
              : 'Show compacted context summary'
          }
          className={cn(
            'tool-call group/toolcall flex w-full items-center gap-2 rounded px-2 py-1 -mx-2',
            'cursor-pointer text-left text-sm text-muted-foreground transition-colors duration-150',
            'hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50',
          )}
        >
          <span className="tool-call__dot h-1.5 w-1.5 shrink-0 rounded-full bg-green-500" />
          <span className="tool-call__text min-w-0 flex-1 truncate">
            Compacted conversation
          </span>
          <ChevronRight
            className={cn(
              'tool-call__chevron h-4 w-4 text-muted-foreground/50 opacity-0 transition-all duration-150',
              'group-hover/toolcall:opacity-100',
              isExpanded && 'rotate-90 opacity-100',
            )}
            aria-hidden="true"
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent
        className={cn(
          'group/details overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up',
          'motion-reduce:animate-none',
        )}
      >
        <div className="ml-1 mt-1 border-l border-border/50 pl-4 text-xs text-muted-foreground/80">
          <div className="mt-2">
            <div className="mb-1 text-[0.7rem] text-muted-foreground/60">
              Output
            </div>
            <div className="mt-2 max-h-80 overflow-auto rounded bg-muted/30 p-2 text-xs text-muted-foreground/80">
              <MarkdownRenderer
                content={displayContent}
                workspaceId={workspaceId}
              />
            </div>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
