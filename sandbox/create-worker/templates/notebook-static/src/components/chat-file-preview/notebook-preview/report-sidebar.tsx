'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import type { TocEntry } from './types';

interface ReportSidebarProps {
  entries: TocEntry[];
}

export function ReportSidebar({ entries }: ReportSidebarProps) {
  const [activeId, setActiveId] = useState<string | null>(entries[0]?.id ?? null);
  const observerRef = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    setActiveId(entries[0]?.id ?? null);
  }, [entries]);

  useEffect(() => {
    const headingElements = entries
      .map((entry) => document.getElementById(entry.id))
      .filter((element): element is HTMLElement => Boolean(element));

    if (headingElements.length === 0) return;

    const rootCandidate = headingElements[0].closest('[data-notebook-scroll-root="true"]');
    const root = rootCandidate instanceof HTMLElement ? rootCandidate : null;

    observerRef.current = new IntersectionObserver(
      (intersectionEntries) => {
        for (const entry of intersectionEntries) {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id);
            return;
          }
        }
      },
      { root, rootMargin: '-80px 0px -70% 0px', threshold: 0 }
    );

    headingElements.forEach((element) => observerRef.current?.observe(element));

    return () => observerRef.current?.disconnect();
  }, [entries]);

  if (entries.length === 0) return null;

  return (
    <nav className="report-sidebar sticky top-4 hidden w-44 shrink-0 self-start pt-2 @3xl:block">
      <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground/50">
        Contents
      </p>
      <ul className="space-y-1.5">
        {entries.map((entry) => {
          const isActive = activeId === entry.id;
          return (
            <li key={entry.id}>
              <button
                type="button"
                onClick={() => {
                  const element = document.getElementById(entry.id);
                  element?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }}
                className={cn(
                  'relative block w-full truncate text-left text-[13px] leading-snug transition-colors',
                  entry.level === 3 ? 'pl-6' : 'pl-3',
                  isActive ? 'font-semibold text-foreground' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {isActive ? (
                  <span className="absolute inset-y-0 left-0 w-0.5 rounded-full bg-primary" aria-hidden />
                ) : null}
                {entry.text}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
