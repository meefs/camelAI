'use client';

import { cn } from '@/lib/utils';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PlotlyPlaceholder } from './plotly-placeholder';
import {
  buildThemedPlotlyFigure,
  ensurePlotlyLoaded,
  getCurrentTheme,
  type PlotlyWindow,
  type ThemeMode,
} from './chart-runtime';

export { PLOTLY_CDN_URL } from './chart-runtime';

interface PlotlyChartProps {
  payload: Record<string, unknown>;
  title: string;
  showModeBar?: boolean;
  fillContainer?: boolean;
}

export function PlotlyChart({
  payload,
  title,
  showModeBar = false,
  fillContainer = false,
}: PlotlyChartProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const resizeRafRef = useRef<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemeMode>(() => getCurrentTheme());

  const scheduleResize = useCallback(() => {
    if (resizeRafRef.current !== null) {
      cancelAnimationFrame(resizeRafRef.current);
      resizeRafRef.current = null;
    }

    resizeRafRef.current = requestAnimationFrame(() => {
      resizeRafRef.current = null;
      const plot = plotRef.current;
      if (!plot) return;
      const Plotly = (window as PlotlyWindow).Plotly;
      if (!Plotly?.Plots?.resize) return;
      Promise.resolve(Plotly.Plots.resize(plot)).catch(() => {});
    });
  }, []);

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

    const renderPlot = async () => {
      setError(null);
      setIsLoading(true);

      try {
        await ensurePlotlyLoaded();
        if (cancelled) return;

        const plot = plotRef.current;
        if (!plot) return;

        const Plotly = (window as PlotlyWindow).Plotly;
        if (!Plotly?.newPlot) {
          throw new Error('Plotly is unavailable.');
        }

        const themed = buildThemedPlotlyFigure(payload, theme, showModeBar, fillContainer);
        plot.innerHTML = '';
        await Plotly.newPlot(plot, themed.traces, themed.layout, themed.config);

        plot.style.background = 'transparent';
        plot.style.width = '100%';
        plot.style.minWidth = '0';

        for (const element of Array.from(
          plot.querySelectorAll('.js-plotly-plot, .plot-container, .svg-container')
        )) {
          const node = element as HTMLElement;
          node.style.background = 'transparent';
          node.style.width = '100%';
          node.style.minWidth = '0';
        }

        for (const svg of Array.from(plot.querySelectorAll('svg'))) {
          svg.style.background = 'transparent';
          svg.style.display = 'block';
          svg.style.maxWidth = '100%';
        }

        requestAnimationFrame(() => {
          scheduleResize();
        });

        if (!cancelled) {
          setIsLoading(false);
        }
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Failed to render Plotly chart.';
        setError(message);
        setIsLoading(false);
      }
    };

    void renderPlot();

    return () => {
      cancelled = true;
      if (resizeRafRef.current !== null) {
        cancelAnimationFrame(resizeRafRef.current);
        resizeRafRef.current = null;
      }

      const plot = plotRef.current;
      const Plotly = (window as PlotlyWindow).Plotly;
      if (plot && Plotly?.purge) {
        Plotly.purge(plot);
      }
    };
  }, [fillContainer, payload, scheduleResize, showModeBar, theme]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (typeof ResizeObserver === 'undefined') return;

    resizeObserverRef.current?.disconnect();
    const observer = new ResizeObserver(() => {
      scheduleResize();
    });
    observer.observe(root);
    resizeObserverRef.current = observer;

    return () => {
      observer.disconnect();
      if (resizeObserverRef.current === observer) {
        resizeObserverRef.current = null;
      }
    };
  }, [scheduleResize]);

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
        ref={plotRef}
        aria-label={title}
        style={fillContainer ? { width: '100%', height: '100%' } : { width: '100%', minHeight: 280 }}
        className={cn(
          'w-full min-w-0 overflow-hidden',
          fillContainer
            ? isLoading ? 'h-full opacity-0' : 'h-full opacity-100'
            : isLoading ? 'min-h-[280px] opacity-0' : 'opacity-100'
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
