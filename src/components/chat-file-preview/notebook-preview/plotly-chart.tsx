'use client';

import { cn } from '@/lib/utils';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PlotlyPlaceholder } from './plotly-placeholder';

const PLOTLY_CDN_URL = 'https://cdn.plot.ly/plotly-2.35.2.min.js';

interface PlotlyApi {
  newPlot: (
    root: HTMLElement,
    data: unknown[],
    layout?: Record<string, unknown>,
    config?: Record<string, unknown>
  ) => Promise<unknown>;
  purge?: (root: HTMLElement) => void;
  Plots?: {
    resize?: (root: HTMLElement) => Promise<unknown> | void;
  };
}

interface PlotlyWindow extends Window {
  Plotly?: PlotlyApi;
}

type ThemeMode = 'light' | 'dark';

interface PlotlyChartProps {
  payload: Record<string, unknown>;
  title: string;
  showModeBar?: boolean;
  fillContainer?: boolean;
}

let plotlyLoadPromise: Promise<void> | null = null;

function getCurrentTheme(): ThemeMode {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

function getTaggedScript(src: string): HTMLScriptElement | null {
  const scripts = Array.from(document.querySelectorAll('script'));
  for (const script of scripts) {
    if (script.dataset.chiridionNotebookScript === src) {
      return script;
    }
  }
  return null;
}

function loadScript(src: string, globalCheck: () => boolean): Promise<void> {
  if (globalCheck()) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const onLoad = () => {
      if (globalCheck()) {
        resolve();
        return;
      }
      reject(new Error(`Loaded ${src}, but expected global was not available.`));
    };

    const onError = () => reject(new Error(`Failed to load ${src}.`));

    const existing = getTaggedScript(src);
    if (existing) {
      if (existing.dataset.loaded === 'true' || globalCheck()) {
        onLoad();
        return;
      }
      const isLoading = existing.dataset.loading === 'true';
      const hasFailed = existing.dataset.failed === 'true';
      if (isLoading && !hasFailed) {
        existing.addEventListener('load', onLoad, { once: true });
        existing.addEventListener('error', onError, { once: true });
        return;
      }

      existing.remove();
    }

    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.referrerPolicy = 'no-referrer';
    script.dataset.chiridionNotebookScript = src;
    script.dataset.loading = 'true';
    script.dataset.failed = 'false';
    script.addEventListener(
      'load',
      () => {
        script.dataset.loaded = 'true';
        script.dataset.loading = 'false';
        script.dataset.failed = 'false';
        onLoad();
      },
      { once: true }
    );
    script.addEventListener(
      'error',
      () => {
        script.dataset.loading = 'false';
        script.dataset.failed = 'true';
        onError();
      },
      { once: true }
    );

    document.head.appendChild(script);
  });
}

async function ensurePlotlyLoaded(): Promise<void> {
  if (typeof window === 'undefined') return;

  if ((window as PlotlyWindow).Plotly) {
    return;
  }

  if (!plotlyLoadPromise) {
    plotlyLoadPromise = loadScript(PLOTLY_CDN_URL, () => Boolean((window as PlotlyWindow).Plotly))
      .catch((error) => {
        plotlyLoadPromise = null;
        throw error;
      });
  }

  await plotlyLoadPromise;
}

function cloneValue<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function patchAxisTheme(
  axisInput: unknown,
  axisColor: string,
  textColor: string,
  gridColor: string
): Record<string, unknown> {
  const axis = asRecord(axisInput);
  const nextAxis = { ...axis };
  if (nextAxis.color == null) nextAxis.color = axisColor;
  if (nextAxis.gridcolor == null) nextAxis.gridcolor = gridColor;
  if (nextAxis.linecolor == null) nextAxis.linecolor = gridColor;
  if (nextAxis.zerolinecolor == null) nextAxis.zerolinecolor = gridColor;

  const tickfont = asRecord(nextAxis.tickfont);
  if (tickfont.color == null) tickfont.color = axisColor;
  nextAxis.tickfont = tickfont;

  const titlefont = asRecord(nextAxis.titlefont);
  if (titlefont.color == null) titlefont.color = textColor;
  nextAxis.titlefont = titlefont;

  return nextAxis;
}

function buildThemedPlotlyFigure(
  sourcePayload: Record<string, unknown>,
  theme: ThemeMode,
  showModeBar: boolean,
  fillContainer: boolean
): {
  traces: unknown[];
  layout: Record<string, unknown>;
  config: Record<string, unknown>;
} {
  const payload = cloneValue(sourcePayload);
  const payloadFigure = asRecord(payload.figure);

  const tracesSource = Array.isArray(payload.data)
    ? payload.data
    : Array.isArray(payloadFigure.data)
      ? payloadFigure.data
      : [];
  const traces = cloneValue(tracesSource);

  const baseLayout = Array.isArray(payload.data)
    ? asRecord(payload.layout)
    : asRecord(payloadFigure.layout);
  const baseConfig = asRecord(payload.config);
  const layout = cloneValue(baseLayout);
  const config = cloneValue(baseConfig);

  const dark = theme === 'dark';
  const axisColor = dark ? '#a1a1aa' : '#475569';
  const textColor = dark ? '#e4e4e7' : '#1f2937';
  const gridColor = dark ? 'rgba(113,113,122,0.35)' : 'rgba(148,163,184,0.35)';

  if (layout.width != null) {
    delete layout.width;
  }

  if (fillContainer) {
    delete layout.height;
  } else if (typeof layout.height === 'number' && Number.isFinite(layout.height)) {
    layout.height = Math.max(240, Math.min(900, layout.height));
  }

  layout.autosize = true;
  layout.paper_bgcolor = 'rgba(0,0,0,0)';
  layout.plot_bgcolor = 'rgba(0,0,0,0)';

  const font = asRecord(layout.font);
  if (font.color == null) font.color = textColor;
  layout.font = font;

  for (const key of Object.keys(layout)) {
    if (/^[xy]axis\d*$/.test(key)) {
      layout[key] = patchAxisTheme(layout[key], axisColor, textColor, gridColor);
    }
  }

  if (!Object.keys(layout).some((key) => /^[xy]axis\d*$/.test(key))) {
    layout.xaxis = patchAxisTheme(layout.xaxis, axisColor, textColor, gridColor);
    layout.yaxis = patchAxisTheme(layout.yaxis, axisColor, textColor, gridColor);
  }

  const legend = asRecord(layout.legend);
  if (legend.bgcolor == null) legend.bgcolor = 'rgba(0,0,0,0)';
  if (legend.bordercolor == null) legend.bordercolor = 'rgba(0,0,0,0)';
  const legendFont = asRecord(legend.font);
  if (legendFont.color == null) legendFont.color = textColor;
  legend.font = legendFont;
  layout.legend = legend;

  if (typeof layout.title === 'string') {
    layout.title = {
      text: layout.title,
      font: { color: textColor },
    };
  } else {
    const title = asRecord(layout.title);
    const titleFont = asRecord(title.font);
    if (titleFont.color == null) titleFont.color = textColor;
    layout.title = { ...title, font: titleFont };
  }

  // Subtitles/callouts are often represented as annotations in plotly layouts.
  if (Array.isArray(layout.annotations)) {
    layout.annotations = layout.annotations.map((annotation) => {
      const next = { ...asRecord(annotation) };
      const annotationFont = asRecord(next.font);
      if (annotationFont.color == null) annotationFont.color = textColor;
      next.font = annotationFont;
      return next;
    });
  }

  const nextConfig: Record<string, unknown> = {
    responsive: true,
    displaylogo: false,
    ...config,
    displayModeBar: showModeBar,
  };

  if (showModeBar) {
    const existingButtonsToRemove = Array.isArray(nextConfig.modeBarButtonsToRemove)
      ? nextConfig.modeBarButtonsToRemove
      : [];
    nextConfig.modeBarButtonsToRemove = Array.from(new Set([
      ...existingButtonsToRemove,
      'sendDataToCloud',
      'toggleSpikelines',
    ]));
  }

  return {
    traces,
    layout,
    config: nextConfig,
  };
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
