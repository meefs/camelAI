'use client';

import { useEffect, useRef, useState } from 'react';
import { PlotlyPlaceholder } from './plotly-placeholder';

const VEGA_CDN_URL = 'https://cdn.jsdelivr.net/npm/vega@5';
const VEGA_LITE_CDN_URL = 'https://cdn.jsdelivr.net/npm/vega-lite@5';
const VEGA_EMBED_CDN_URL = 'https://cdn.jsdelivr.net/npm/vega-embed@6';

interface VegaLiteWindow extends Window {
  vega?: unknown;
  vegaLite?: unknown;
  vegaEmbed?: (
    element: HTMLElement,
    spec: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => Promise<unknown>;
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
    const existing = getTaggedScript(src);

    const onLoad = () => {
      if (globalCheck()) {
        resolve();
        return;
      }
      reject(new Error(`Loaded ${src}, but expected global was not available.`));
    };

    const onError = () => reject(new Error(`Failed to load ${src}.`));

    if (existing) {
      if (existing.dataset.loaded === 'true' || globalCheck()) {
        onLoad();
        return;
      }
      existing.addEventListener('load', onLoad, { once: true });
      existing.addEventListener('error', onError, { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.referrerPolicy = 'no-referrer';
    script.dataset.chiridionNotebookScript = src;
    script.addEventListener(
      'load',
      () => {
        script.dataset.loaded = 'true';
        onLoad();
      },
      { once: true }
    );
    script.addEventListener('error', onError, { once: true });

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
}

export function VegaLiteChart({ spec, title }: VegaLiteChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
        await embed(container, spec, {
          actions: false,
          renderer: 'svg',
          mode: 'vega-lite',
        });

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
    };
  }, [spec]);

  return (
    <div className="relative">
      {isLoading ? (
        <div className="absolute inset-0">
          <PlotlyPlaceholder />
        </div>
      ) : null}
      <div className="min-h-[280px] w-full rounded border bg-background p-2">
        <div
          ref={containerRef}
          aria-label={title}
          className={isLoading ? 'opacity-0' : 'opacity-100'}
        />
        {error ? (
          <pre className="overflow-auto rounded border border-red-200 bg-red-50 p-3 font-mono text-xs whitespace-pre-wrap text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
            {error}
          </pre>
        ) : null}
      </div>
    </div>
  );
}
