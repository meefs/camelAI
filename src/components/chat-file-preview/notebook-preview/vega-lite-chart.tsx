'use client';

import { cn } from '@/lib/utils';
import { useEffect, useRef, useState } from 'react';
import { PlotlyPlaceholder } from './plotly-placeholder';

const VEGA_CDN_URL = 'https://cdn.jsdelivr.net/npm/vega@6';
const VEGA_LITE_CDN_URL = 'https://cdn.jsdelivr.net/npm/vega-lite@6';
const VEGA_EMBED_CDN_URL = 'https://cdn.jsdelivr.net/npm/vega-embed@7';

interface VegaLiteWindow extends Window {
  vega?: unknown;
  vegaLite?: unknown;
  vegaEmbed?: (
    element: HTMLElement,
    spec: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => Promise<VegaEmbedResult>;
}

interface VegaView {
  resize: () => VegaView | void;
  runAsync?: () => Promise<unknown>;
  finalize?: () => void;
}

interface VegaEmbedResult {
  view?: VegaView;
}

let vegaLibrariesLoadPromise: Promise<void> | null = null;

function getTaggedScript(src: string): HTMLScriptElement | null {
  const scripts = Array.from(document.querySelectorAll('script'));
  for (const script of scripts) {
    if (script.dataset.chiridionNotebookScript === src) {
      return script;
    }
  }
  return null;
}

function loadScriptSequentially(
  src: string,
  globalCheck: () => boolean
): Promise<void> {
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

async function ensureVegaLibrariesLoaded(): Promise<void> {
  if (typeof window === 'undefined') return;

  const runtime = window as VegaLiteWindow;
  if (runtime.vega && runtime.vegaLite && runtime.vegaEmbed) {
    return;
  }

  if (!vegaLibrariesLoadPromise) {
    vegaLibrariesLoadPromise = (async () => {
      await loadScriptSequentially(VEGA_CDN_URL, () => Boolean((window as VegaLiteWindow).vega));
      await loadScriptSequentially(VEGA_LITE_CDN_URL, () => Boolean((window as VegaLiteWindow).vegaLite));
      await loadScriptSequentially(VEGA_EMBED_CDN_URL, () => Boolean((window as VegaLiteWindow).vegaEmbed));
    })().catch((error) => {
      vegaLibrariesLoadPromise = null;
      throw error;
    });
  }

  await vegaLibrariesLoadPromise;
}

interface VegaLiteChartProps {
  spec: Record<string, unknown>;
  title: string;
  fillContainer?: boolean;
}

type ThemeMode = 'light' | 'dark';

function getCurrentTheme(): ThemeMode {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

function cloneSpec<T>(value: T): T {
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

function buildThemedSpec(
  sourceSpec: Record<string, unknown>,
  theme: ThemeMode,
  fillContainer: boolean
): Record<string, unknown> {
  const nextSpec = cloneSpec(sourceSpec);
  const dark = theme === 'dark';

  if (nextSpec.background == null) {
    nextSpec.background = 'transparent';
  }

  // Force responsive sizing regardless of python-side fixed width.
  nextSpec.width = 'container';

  if (fillContainer) {
    nextSpec.height = 'container';
  } else {
    const sourceWidth = typeof sourceSpec.width === 'number' ? sourceSpec.width : null;
    const sourceHeight = typeof sourceSpec.height === 'number' ? sourceSpec.height : null;
    if (sourceWidth !== null && sourceHeight !== null && sourceWidth === sourceHeight) {
      // For square charts (donut/pie), remove fixed height when width becomes container.
      delete nextSpec.height;
    }
  }

  if (nextSpec.padding == null) {
    nextSpec.padding = 0;
  }

  const autosize = asRecord(nextSpec.autosize);
  nextSpec.autosize = {
    ...autosize,
    type: 'fit',
    contains: 'padding',
    resize: true,
  };

  const existingConfig = asRecord(nextSpec.config);
  const existingAxis = asRecord(existingConfig.axis);
  const existingAxisX = asRecord(existingConfig.axisX);
  const existingAxisY = asRecord(existingConfig.axisY);
  const existingLegend = asRecord(existingConfig.legend);
  const existingView = asRecord(existingConfig.view);
  const existingTitle = asRecord(existingConfig.title);

  const axisDefaults: Record<string, unknown> = dark
    ? {
        labelColor: '#a1a1aa',
        titleColor: '#e4e4e7',
        domainColor: 'rgba(161,161,170,0.4)',
        tickColor: 'rgba(161,161,170,0.5)',
        gridColor: 'rgba(113,113,122,0.35)',
      }
    : {
        labelColor: '#475569',
        titleColor: '#1f2937',
        domainColor: 'rgba(100,116,139,0.45)',
        tickColor: 'rgba(100,116,139,0.55)',
        gridColor: 'rgba(148,163,184,0.35)',
      };

  nextSpec.config = {
    ...existingConfig,
    axis: { ...axisDefaults, ...existingAxis },
    axisX: { ...axisDefaults, ...existingAxisX },
    axisY: { ...axisDefaults, ...existingAxisY },
    legend: {
      labelColor: dark ? '#e4e4e7' : '#1f2937',
      titleColor: dark ? '#e4e4e7' : '#1f2937',
      ...existingLegend,
    },
    view: {
      fill: 'transparent',
      stroke: null,
      ...existingView,
    },
    title: {
      color: dark ? '#f4f4f5' : '#111827',
      subtitleColor: dark ? '#a1a1aa' : '#6b7280',
      ...existingTitle,
    },
  };

  return nextSpec;
}

function hasArcMark(spec: Record<string, unknown>): boolean {
  if (spec.mark === 'arc') return true;

  const markRecord = asRecord(spec.mark);
  if (markRecord.type === 'arc') return true;

  if (!Array.isArray(spec.layer)) return false;
  return spec.layer.some((layer) => {
    const layerRecord = asRecord(layer);
    if (layerRecord.mark === 'arc') return true;
    const layerMark = asRecord(layerRecord.mark);
    return layerMark.type === 'arc';
  });
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
