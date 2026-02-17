'use client';

import { useCallback, useEffect, useRef } from 'react';

type NotebookViewMode = 'report' | 'notebook';

export function usePdfExport(
  currentMode: NotebookViewMode | undefined,
  setMode: ((mode: NotebookViewMode) => void) | undefined
) {
  const isPrintingRef = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => cleanupRef.current?.();
  }, []);

  return useCallback(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }
    if (isPrintingRef.current) return;

    isPrintingRef.current = true;
    const html = document.documentElement;
    const body = document.body;
    const previousMode = currentMode;
    const wasDark = html.classList.contains('dark');
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

    const restore = () => {
      body.classList.remove('chiridion-printing-report');
      if (wasDark) {
        html.classList.add('dark');
      }
      if (previousMode === 'notebook') {
        setMode?.('notebook');
      }
      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
      window.removeEventListener('afterprint', restore);
      cleanupRef.current = null;
      isPrintingRef.current = false;
    };

    cleanupRef.current = restore;

    if (currentMode === 'notebook') {
      setMode?.('report');
    }

    const waitForReportDom = async () => {
      for (let i = 0; i < 20; i += 1) {
        if (document.querySelector('.notebook-report')) return;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    };

    void (async () => {
      try {
        await waitForReportDom();
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });

        if (wasDark) {
          html.classList.remove('dark');
        }
        body.classList.add('chiridion-printing-report');

        await new Promise<void>((resolve) => {
          setTimeout(resolve, wasDark ? 250 : 0);
        });

        window.addEventListener('afterprint', restore, { once: true });
        fallbackTimer = setTimeout(restore, 3000);
        window.print();
      } catch {
        restore();
      }
    })();
  }, [currentMode, setMode]);
}
