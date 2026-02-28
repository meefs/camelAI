'use client';

import type { ReactNode } from 'react';
import { useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

const MAX_COLLAPSED_HEIGHT = 300;
const MASK_FADE = 'linear-gradient(to bottom, black 85%, transparent 100%)';

interface CollapsibleUserMessageProps {
  children: ReactNode;
}

export function CollapsibleUserMessage({ children }: CollapsibleUserMessageProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

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
    <div className={cn('relative', isOverflowing && 'group/msg')}>
      <div
        ref={contentRef}
        className={cn(collapsed && 'overflow-hidden')}
        style={collapsed ? {
          maxHeight: MAX_COLLAPSED_HEIGHT,
          maskImage: MASK_FADE,
          WebkitMaskImage: MASK_FADE,
        } : undefined}
      >
        {children}
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
  );
}
