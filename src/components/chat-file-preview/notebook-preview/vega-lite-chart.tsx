'use client';

import { cn } from '@/lib/utils';
import { useEffect, useRef, useState } from 'react';
import { PlotlyPlaceholder } from './plotly-placeholder';
import {
  buildThemedSpec,
  ensureVegaLibrariesLoaded,
  getCurrentTheme,
  hasArcMark,
  type ThemeMode,
  type VegaLiteWindow,
  type VegaView,
} from './chart-runtime';

export {
  VEGA_CDN_URL,
  VEGA_EMBED_CDN_URL,
  VEGA_LITE_CDN_URL,
} from './chart-runtime';

interface VegaLiteChartProps {
  spec: Record<string, unknown>;
  title: string;
  fillContainer?: boolean;
}

export function VegaLiteChart({ spec, title, fillContainer = false }: VegaLiteChartProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<VegaView | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const resizeRafRef = useRef<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemeMode>(() => getCurrentTheme());
  const isArcChart = hasArcMark(spec);
  const containerMinHeight = fillContainer ? null : (isArcChart ? 380 : 320);

  const scheduleViewResize = () => {
    if (resizeRafRef.current !== null) {
      cancelAnimationFrame(resizeRafRef.current);
      resizeRafRef.current = null;
    }
    resizeRafRef.current = requestAnimationFrame(() => {
      resizeRafRef.current = null;
      const view = viewRef.current;
      if (!view) return;
      try {
        view.resize();
        void view.runAsync?.();
      } catch {
        // Ignore transient resize errors while container is relayouting.
      }
    });
  };

  useEffect(() => {
    if (typeof document === 'undefined') return;

    const root = document.documentElement;
    const syncTheme = () => setTheme(root.classList.contains('dark') ? 'dark' : 'light');
    syncTheme();

    const observer = new MutationObserver(syncTheme);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;

    const renderChart = async () => {
      setError(null);
      setIsLoading(true);

      try {
        await ensureVegaLibrariesLoaded();
        if (cancelled) return;

        const runtime = window as VegaLiteWindow;
        const embed = runtime.vegaEmbed;
        if (typeof embed !== 'function') {
          throw new Error('Vega-Embed is unavailable.');
        }

        const container = containerRef.current;
        if (!container) return;

        container.innerHTML = '';
        const themedSpec = buildThemedSpec(spec, theme, fillContainer);
        // Wait one frame so flex/layout sizing resolves before embed reads container width.
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const result = await embed(container, themedSpec, {
          actions: false,
          renderer: 'svg',
        });
        viewRef.current = result?.view ?? null;

        // Trigger post-mount resize in case the panel finished layout after embed.
        requestAnimationFrame(() => {
          scheduleViewResize();
        });

        // vega-embed adds wrapper divs; flatten visual chrome so it feels inline/native.
        for (const element of Array.from(container.querySelectorAll('div'))) {
          const node = element as HTMLDivElement;
          node.style.background = 'transparent';
          node.style.width = '100%';
          node.style.minWidth = '0';
        }
        for (const svg of Array.from(container.querySelectorAll('svg'))) {
          svg.style.background = 'transparent';
          svg.style.display = 'block';
          svg.style.maxWidth = '100%';
          svg.style.height = 'auto';
          svg.style.width = '100%';
        }

        if (!cancelled) {
          setIsLoading(false);
        }
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Failed to render Vega-Lite chart.';
        setError(message);
        setIsLoading(false);
      }
    };

    void renderChart();

    return () => {
      cancelled = true;
      if (resizeRafRef.current !== null) {
        cancelAnimationFrame(resizeRafRef.current);
        resizeRafRef.current = null;
      }
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      viewRef.current?.finalize?.();
      viewRef.current = null;
    };
  }, [fillContainer, spec, theme]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (typeof ResizeObserver === 'undefined') return;

    resizeObserverRef.current?.disconnect();
    const observer = new ResizeObserver(() => {
      scheduleViewResize();
    });
    observer.observe(root);
    resizeObserverRef.current = observer;

    return () => {
      observer.disconnect();
      if (resizeObserverRef.current === observer) {
        resizeObserverRef.current = null;
      }
    };
  }, [fillContainer, spec, theme]);

  return (
    <div
      ref={rootRef}
      className={cn(
        'relative w-full min-w-0',
        fillContainer && 'mx-auto h-full max-w-[1800px]'
      )}
    >
      {isLoading ? (
        <div className="absolute inset-0">
          <PlotlyPlaceholder />
        </div>
      ) : null}
      <div
        ref={containerRef}
        aria-label={title}
        style={fillContainer
          ? { width: '100%', height: '100%' }
          : { width: '100%', minHeight: containerMinHeight ?? undefined }}
        className={cn(
          'w-full min-w-0 overflow-hidden',
          fillContainer
            ? isLoading ? 'h-full opacity-0' : 'h-full opacity-100'
            : isLoading ? 'opacity-0' : 'opacity-100'
        )}
      />
      {error ? (
        <pre className="overflow-auto rounded border border-red-200 bg-red-50 p-3 font-mono text-xs whitespace-pre-wrap text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
          {error}
        </pre>
      ) : null}
    </div>
  );
}
