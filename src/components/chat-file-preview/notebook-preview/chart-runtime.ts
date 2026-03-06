'use client';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const OFFSCREEN_EXPORT_WIDTH = 1100;
const OFFSCREEN_EXPORT_SCALE = 2;
const DEFAULT_EXPORT_HEIGHT = 620;

export const PLOTLY_CDN_URL = 'https://cdn.plot.ly/plotly-2.35.2.min.js';
export const VEGA_CDN_URL = 'https://cdn.jsdelivr.net/npm/vega@6';
export const VEGA_LITE_CDN_URL = 'https://cdn.jsdelivr.net/npm/vega-lite@6';
export const VEGA_EMBED_CDN_URL = 'https://cdn.jsdelivr.net/npm/vega-embed@7';

export type ThemeMode = 'light' | 'dark';

export interface PlotlyApi {
  newPlot: (
    root: HTMLElement,
    data: unknown[],
    layout?: Record<string, unknown>,
    config?: Record<string, unknown>
  ) => Promise<unknown>;
  purge?: (root: HTMLElement) => void;
  toImage?: (
    root: HTMLElement,
    options?: Record<string, unknown>
  ) => Promise<string>;
  Plots?: {
    resize?: (root: HTMLElement) => Promise<unknown> | void;
  };
}

export interface PlotlyWindow extends Window {
  Plotly?: PlotlyApi;
}

export interface VegaLiteWindow extends Window {
  vega?: unknown;
  vegaLite?: unknown;
  vegaEmbed?: (
    element: HTMLElement,
    spec: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => Promise<VegaEmbedResult>;
}

export interface VegaView {
  resize: () => VegaView | void;
  runAsync?: () => Promise<unknown>;
  finalize?: () => void;
}

export interface VegaEmbedResult {
  view?: VegaView;
}

export interface PdfImageAsset {
  src: string;
  width: number;
  height: number;
}

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

export async function ensurePlotlyLoaded(): Promise<void> {
  if (typeof window === 'undefined') return;

  if ((window as PlotlyWindow).Plotly) {
    return;
  }

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
  if (runtime.vega && runtime.vegaLite && runtime.vegaEmbed) {
    return;
  }

  if (!vegaLibrariesLoadPromise) {
    vegaLibrariesLoadPromise = (async () => {
      await loadScript(VEGA_CDN_URL, () => Boolean((window as VegaLiteWindow).vega));
      await loadScript(VEGA_LITE_CDN_URL, () => Boolean((window as VegaLiteWindow).vegaLite));
      await loadScript(VEGA_EMBED_CDN_URL, () => Boolean((window as VegaLiteWindow).vegaEmbed));
    })().catch((error) => {
      vegaLibrariesLoadPromise = null;
      throw error;
    });
  }

  await vegaLibrariesLoadPromise;
}

export function getCurrentTheme(): ThemeMode {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
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

export function buildThemedPlotlyFigure(
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

export function buildThemedSpec(
  sourceSpec: Record<string, unknown>,
  theme: ThemeMode,
  fillContainer: boolean
): Record<string, unknown> {
  const nextSpec = cloneValue(sourceSpec);
  const dark = theme === 'dark';

  if (nextSpec.background == null) {
    nextSpec.background = 'transparent';
  }

  nextSpec.width = 'container';

  if (fillContainer) {
    nextSpec.height = 'container';
  } else {
    const sourceWidth = typeof sourceSpec.width === 'number' ? sourceSpec.width : null;
    const sourceHeight = typeof sourceSpec.height === 'number' ? sourceSpec.height : null;
    if (sourceWidth !== null && sourceHeight !== null && sourceWidth === sourceHeight) {
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

export function hasArcMark(spec: Record<string, unknown>): boolean {
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

export function sanitizeFilename(title: string): string {
  const safe = title
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');

  return safe.slice(0, 80) || 'chart';
}

export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

export function dataUrlToBlob(dataUrl: string): Blob | null {
  const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/);
  if (!match) return null;

  const mimeType = match[1] || 'application/octet-stream';
  const isBase64 = match[2] === ';base64';
  const dataPart = match[3] ?? '';

  try {
    if (isBase64) {
      const binary = atob(dataPart);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      return new Blob([bytes], { type: mimeType });
    }

    return new Blob([decodeURIComponent(dataPart)], { type: mimeType });
  } catch {
    return null;
  }
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read blob.'));
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
        return;
      }
      reject(new Error('Unexpected FileReader result.'));
    };
    reader.readAsDataURL(blob);
  });
}

export function getChartSvg(container: HTMLElement): SVGSVGElement | null {
  const svgElement = container.querySelector('svg');
  return svgElement instanceof SVGSVGElement ? svgElement : null;
}

export function getSvgExportDimensions(svg: SVGSVGElement): { width: number; height: number } {
  const rect = svg.getBoundingClientRect();
  const widthAttr = Number.parseFloat(svg.getAttribute('width') ?? '');
  const heightAttr = Number.parseFloat(svg.getAttribute('height') ?? '');
  const viewBox = svg.viewBox.baseVal;
  const width = Math.max(
    1,
    Math.round(
      rect.width || widthAttr || (viewBox && Number.isFinite(viewBox.width) ? viewBox.width : 0) || 800
    )
  );
  const height = Math.max(
    1,
    Math.round(
      rect.height || heightAttr || (viewBox && Number.isFinite(viewBox.height) ? viewBox.height : 0) || 500
    )
  );

  return { width, height };
}

export function cloneSvgForExport(svg: SVGSVGElement): SVGSVGElement {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', SVG_NS);
  clone.setAttribute('xmlns:xlink', XLINK_NS);

  const { width, height } = getSvgExportDimensions(svg);
  if (!clone.getAttribute('viewBox')) {
    clone.setAttribute('viewBox', `0 0 ${width} ${height}`);
  }
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));

  return clone;
}

export async function svgToPngBlob(svg: SVGSVGElement, scale = 2): Promise<Blob | null> {
  const { width, height } = getSvgExportDimensions(svg);
  const svgString = new XMLSerializer().serializeToString(cloneSvgForExport(svg));
  const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
  const svgUrl = URL.createObjectURL(svgBlob);

  try {
    const image = new Image();
    const loaded = new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('Failed to load SVG for PNG export.'));
    });
    image.src = svgUrl;
    await loaded;

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));

    const context = canvas.getContext('2d');
    if (!context) return null;

    context.scale(scale, scale);
    context.drawImage(image, 0, 0, width, height);

    return await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => resolve(blob), 'image/png');
    });
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

async function nextAnimationFrame(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function createOffscreenRenderRoot(width = OFFSCREEN_EXPORT_WIDTH): {
  root: HTMLDivElement;
  container: HTMLDivElement;
} {
  const root = document.createElement('div');
  root.setAttribute('data-chiridion-notebook-offscreen-export', 'true');
  Object.assign(root.style, {
    position: 'fixed',
    left: '-20000px',
    top: '0',
    width: `${width}px`,
    padding: '24px',
    opacity: '0',
    pointerEvents: 'none',
    background: '#ffffff',
    zIndex: '-1',
  });

  const container = document.createElement('div');
  Object.assign(container.style, {
    width: '100%',
    minWidth: '0',
    background: '#ffffff',
  });

  root.appendChild(container);
  document.body.appendChild(root);

  return { root, container };
}

export async function renderPlotlyPngForPdf(
  payload: Record<string, unknown>
): Promise<PdfImageAsset> {
  if (typeof document === 'undefined') {
    throw new Error('Plotly PDF export requires a browser environment.');
  }

  await ensurePlotlyLoaded();
  const Plotly = (window as PlotlyWindow).Plotly;
  if (!Plotly?.newPlot || !Plotly?.toImage) {
    throw new Error('Plotly is unavailable.');
  }

  const { root, container } = createOffscreenRenderRoot();
  const plot = document.createElement('div');
  Object.assign(plot.style, {
    width: '100%',
    minWidth: '0',
    minHeight: '320px',
  });
  container.appendChild(plot);

  try {
    const themed = buildThemedPlotlyFigure(payload, 'light', false, false);
    await Plotly.newPlot(plot, themed.traces, themed.layout, themed.config);
    await nextAnimationFrame();

    const plotRoot = plot.querySelector('.js-plotly-plot');
    const exportRoot = plotRoot instanceof HTMLElement ? plotRoot : plot;
    const rect = exportRoot.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width || OFFSCREEN_EXPORT_WIDTH));
    const height = Math.max(1, Math.round(rect.height || DEFAULT_EXPORT_HEIGHT));

    const src = await Plotly.toImage(exportRoot, {
      format: 'png',
      width,
      height,
      scale: OFFSCREEN_EXPORT_SCALE,
    });
    if (!src.startsWith('data:')) {
      throw new Error('Plotly PNG export did not return a data URL.');
    }

    return { src, width, height };
  } finally {
    Plotly.purge?.(plot);
    root.remove();
  }
}

export async function renderVegaLitePngForPdf(
  spec: Record<string, unknown>
): Promise<PdfImageAsset> {
  if (typeof document === 'undefined') {
    throw new Error('Vega-Lite PDF export requires a browser environment.');
  }

  await ensureVegaLibrariesLoaded();
  const runtime = window as VegaLiteWindow;
  const embed = runtime.vegaEmbed;
  if (typeof embed !== 'function') {
    throw new Error('Vega-Embed is unavailable.');
  }

  const { root, container } = createOffscreenRenderRoot();
  let view: VegaView | null = null;

  try {
    const themedSpec = buildThemedSpec(spec, 'light', false);
    await nextAnimationFrame();
    const result = await embed(container, themedSpec, {
      actions: false,
      renderer: 'svg',
    });
    view = result?.view ?? null;
    await view?.runAsync?.();
    await nextAnimationFrame();

    const svg = getChartSvg(container);
    if (!svg) {
      throw new Error('Vega-Lite export could not find an SVG node.');
    }

    const { width, height } = getSvgExportDimensions(svg);
    const blob = await svgToPngBlob(svg, OFFSCREEN_EXPORT_SCALE);
    if (!blob) {
      throw new Error('Vega-Lite PNG export failed.');
    }

    const src = await blobToDataUrl(blob);
    return { src, width, height };
  } finally {
    view?.finalize?.();
    root.remove();
  }
}
