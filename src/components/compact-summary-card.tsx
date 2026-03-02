'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import type { ContentBlock } from '@/types';
import { MarkdownRenderer } from '@/components/markdown-renderer';
import { cn } from '@/lib/utils';

const MAX_COLLAPSED_HEIGHT = 300;
const MASK_FADE = 'linear-gradient(to bottom, black 85%, transparent 100%)';

interface CompactSummaryCardProps {
  content: string | ContentBlock[];
}

export function CompactSummaryCard({ content }: CompactSummaryCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  const displayContent = typeof content === 'string'
    ? content
    : content
        .map(b => (b.type === 'text' ? b.text : ''))
        .filter(Boolean)
        .join('\n');

  useLayoutEffect(() => {
    const element = contentRef.current;
    if (!element) return;

    const checkOverflow = () => {
      setIsOverflowing(element.scrollHeight > MAX_COLLAPSED_HEIGHT);
    };

    checkOverflow();

    const observer = new ResizeObserver(checkOverflow);
    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  const handleCollapse = () => {
    setIsExpanded(false);
    requestAnimationFrame(() => {
      contentRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  };

  const collapsed = isOverflowing && !isExpanded;

  return (
    <div className={cn(
      'compact-summary mt-1 mb-4 rounded-lg border border-border/50 bg-muted/10 px-4 py-3',
      isOverflowing && 'group/msg',
    )}>
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
            'text-sm text-muted-foreground/80',
            collapsed && 'overflow-hidden',
          )}
          style={collapsed ? {
            maxHeight: MAX_COLLAPSED_HEIGHT,
            maskImage: MASK_FADE,
            WebkitMaskImage: MASK_FADE,
          } : undefined}
        >
          <MarkdownRenderer content={displayContent} />
        </div>

        {isOverflowing && (
          <div className={cn(
            'absolute bottom-2 right-2 opacity-0 group-hover/msg:opacity-100 transition-opacity',
            isExpanded && 'relative bottom-auto right-auto mt-1 flex justify-end',
          )}>
            <button
              type="button"
              onClick={isExpanded ? handleCollapse : () => setIsExpanded(true)}
              className="rounded-md border border-border bg-background/80 px-4 py-1.5 text-sm text-foreground transition-colors hover:bg-accent backdrop-blur-sm"
            >
              {isExpanded ? 'Show less' : 'Show more'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
