'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { SpreadsheetSheet } from './types';

export function SheetTabBar({
  sheets,
  activeIndex,
  onActiveIndexChange,
}: {
  sheets: SpreadsheetSheet[];
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [scrollState, setScrollState] = useState({
    hasOverflow: false,
    canScrollBackward: false,
    canScrollForward: false,
  });

  const updateScrollState = useCallback(() => {
    const node = scrollerRef.current;
    if (!node) return;
    const maxScrollLeft = Math.max(0, node.scrollWidth - node.clientWidth);
    setScrollState({
      hasOverflow: maxScrollLeft > 1,
      canScrollBackward: node.scrollLeft > 1,
      canScrollForward: node.scrollLeft < maxScrollLeft - 1,
    });
  }, []);
  const updateScrollStateRef = useRef(updateScrollState);
  updateScrollStateRef.current = updateScrollState;

  useLayoutEffect(() => {
    const node = scrollerRef.current;
    if (!node) return;

    const handleScrollStateChange = () => updateScrollStateRef.current();
    const resizeObserver = new ResizeObserver(handleScrollStateChange);
    resizeObserver.observe(node);
    node.addEventListener('scroll', handleScrollStateChange, { passive: true });
    handleScrollStateChange();

    return () => {
      resizeObserver.disconnect();
      node.removeEventListener('scroll', handleScrollStateChange);
    };
  }, []);

  useLayoutEffect(() => {
    updateScrollState();
  }, [sheets, updateScrollState]);

  useEffect(() => {
    const activeTab = tabRefs.current[activeIndex];
    if (typeof activeTab?.scrollIntoView === 'function') {
      activeTab.scrollIntoView({
        block: 'nearest',
        inline: 'nearest',
      });
    }
    window.requestAnimationFrame(updateScrollState);
  }, [activeIndex, updateScrollState]);

  const scrollTabs = (direction: -1 | 1) => {
    scrollerRef.current?.scrollBy({
      left: direction * 200,
      behavior: 'smooth',
    });
  };

  const focusTab = (index: number) => {
    const nextIndex = Math.max(0, Math.min(sheets.length - 1, index));
    onActiveIndexChange(nextIndex);
    window.requestAnimationFrame(() => tabRefs.current[nextIndex]?.focus());
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      focusTab(activeIndex - 1);
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      focusTab(activeIndex + 1);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      focusTab(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      focusTab(sheets.length - 1);
    }
  };

  return (
    <div className="flex items-end gap-1 border-t border-border/70 bg-muted/60 px-2 pt-1">
      {scrollState.hasOverflow && (
        <div className="mb-1 flex shrink-0 items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Scroll sheets left"
            disabled={!scrollState.canScrollBackward}
            onClick={() => scrollTabs(-1)}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Scroll sheets right"
            disabled={!scrollState.canScrollForward}
            onClick={() => scrollTabs(1)}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      )}

      <div
        ref={scrollerRef}
        role="tablist"
        aria-label="Workbook sheets"
        className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden"
        onKeyDown={handleKeyDown}
      >
        <div className="flex w-max min-w-full items-end gap-1 border-b border-border">
          {sheets.map((sheet, index) => (
            <button
              key={sheet.name}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              type="button"
              role="tab"
              aria-selected={index === activeIndex}
              tabIndex={index === activeIndex ? 0 : -1}
              className={cn(
                'relative max-w-[160px] shrink-0 truncate rounded-t-md border px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                index === activeIndex
                  ? 'z-10 -mb-px border-border border-b-card bg-card text-foreground'
                  : 'border-transparent bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
              title={sheet.name}
              onClick={() => onActiveIndexChange(index)}
            >
              {sheet.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
