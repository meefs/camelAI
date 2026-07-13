'use client';

import type { PlotlyWindow, VegaLiteWindow } from './chart-runtime-types';

export const PLOTLY_CDN_URL = 'https://cdn.plot.ly/plotly-2.35.2.min.js';
export const VEGA_CDN_URL = 'https://cdn.jsdelivr.net/npm/vega@6';
export const VEGA_LITE_CDN_URL = 'https://cdn.jsdelivr.net/npm/vega-lite@6';
export const VEGA_EMBED_CDN_URL = 'https://cdn.jsdelivr.net/npm/vega-embed@7';

let plotlyLoadPromise: Promise<void> | null = null;
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
    script.async = false;
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

export async function ensurePlotlyLoaded(): Promise<void> {
  if (typeof window === 'undefined' || (window as PlotlyWindow).Plotly) return;

  if (!plotlyLoadPromise) {
    plotlyLoadPromise = loadScript(
      PLOTLY_CDN_URL,
      () => Boolean((window as PlotlyWindow).Plotly)
    ).catch((error) => {
      plotlyLoadPromise = null;
      throw error;
    });
  }

  await plotlyLoadPromise;
}

export async function ensureVegaLibrariesLoaded(): Promise<void> {
  if (typeof window === 'undefined') return;

  const runtime = window as VegaLiteWindow;
  if (runtime.vega && runtime.vegaLite && runtime.vegaEmbed) return;

  if (!vegaLibrariesLoadPromise) {
    vegaLibrariesLoadPromise = Promise.all([
      loadScript(VEGA_CDN_URL, () => Boolean((window as VegaLiteWindow).vega)),
      loadScript(VEGA_LITE_CDN_URL, () => Boolean((window as VegaLiteWindow).vegaLite)),
      loadScript(VEGA_EMBED_CDN_URL, () => Boolean((window as VegaLiteWindow).vegaEmbed)),
    ])
      .then(() => undefined)
      .catch((error) => {
        vegaLibrariesLoadPromise = null;
        throw error;
      });
  }

  await vegaLibrariesLoadPromise;
}
