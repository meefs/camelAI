'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { ContentBlock } from '@/types';
import { MarkdownRenderer } from '@/components/markdown-renderer';
import { cn } from '@/lib/utils';

const COLLAPSED_MAX_HEIGHT = 200;

interface CompactSummaryCardProps {
  content: string | ContentBlock[];
}

export function CompactSummaryCard({ content }: CompactSummaryCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);

  const displayContent = typeof content === 'string'
    ? content
    : content
        .map(b => (b.type === 'text' ? b.text : ''))
        .filter(Boolean)
        .join('\n');

  useEffect(() => {
    if (contentRef.current) {
      setIsOverflowing(contentRef.current.scrollHeight > COLLAPSED_MAX_HEIGHT);
    }
  }, [displayContent]);

  return (
    <div className="compact-summary mt-1 mb-4 rounded-lg border border-border/50 bg-muted/10 px-4 py-3">
      {/* Header */}
      <div className="mb-2">
        <span className="text-sm text-muted-foreground font-medium">
          Context compacted
        </span>
      </div>

      {/* Body */}
      <div className="relative">
        <div
          ref={contentRef}
          className={cn(
            'text-sm text-muted-foreground/80 overflow-hidden',
            !isExpanded && isOverflowing && 'max-h-[200px]',
          )}
        >
          <MarkdownRenderer content={displayContent} />
        </div>

        {/* Gradient fade overlay (collapsed + overflowing) */}
        {!isExpanded && isOverflowing && (
          <div className="absolute bottom-0 left-0 right-0 h-20 bg-gradient-to-t from-background to-transparent pointer-events-none" />
        )}
      </div>

      {/* Expand / collapse toggle */}
      {isOverflowing && (
        <div className="flex justify-end mt-1">
          <button
            type="button"
            onClick={() => setIsExpanded(prev => !prev)}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
          >
            {isExpanded ? 'Show less' : 'Show more'}
            <ChevronDown
              className={cn(
                'h-3 w-3 transition-transform',
                isExpanded && 'rotate-180',
              )}
            />
          </button>
        </div>
      )}
    </div>
  );
}
