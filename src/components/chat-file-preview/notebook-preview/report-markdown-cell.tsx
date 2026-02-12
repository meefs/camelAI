'use client';

import { useLayoutEffect, useRef } from 'react';
import { MarkdownRenderer } from '@/components/markdown-renderer';
import type { TocEntry } from './types';

interface ReportMarkdownCellProps {
  source: string;
  entries: TocEntry[];
}

export function ReportMarkdownCell({
  source,
  entries,
}: ReportMarkdownCellProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const headings = Array.from(container.querySelectorAll('h2, h3')) as HTMLElement[];
    headings.forEach((heading, index) => {
      const entry = entries[index];
      if (entry) {
        heading.id = entry.id;
      }
    });
  }, [entries, source]);

  return (
    <div ref={containerRef}>
      <MarkdownRenderer content={source} />
    </div>
  );
}
