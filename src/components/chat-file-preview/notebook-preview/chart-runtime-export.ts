'use client';

import { ensurePlotlyLoaded, ensureVegaLibrariesLoaded } from './chart-runtime-loader';
import { buildThemedPlotlyFigure, buildThemedSpec } from './chart-runtime-theme';
import type {
  PdfImageAsset,
  PlotlyWindow,
  VegaLiteWindow,
  VegaView,
} from './chart-runtime-types';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const OFFSCREEN_EXPORT_WIDTH = 1100;
const OFFSCREEN_EXPORT_SCALE = 2;
const DEFAULT_EXPORT_HEIGHT = 620;

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
  setTimeout(() => URL.revokeObjectURL(url), 0);
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
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
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
  if (!clone.getAttribute('viewBox')) clone.setAttribute('viewBox', `0 0 ${width} ${height}`);
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
  if (!Plotly?.newPlot || !Plotly?.toImage) throw new Error('Plotly is unavailable.');

  const { root, container } = createOffscreenRenderRoot();
  const plot = document.createElement('div');
  Object.assign(plot.style, { width: '100%', minWidth: '0', minHeight: '320px' });
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
  const embed = (window as VegaLiteWindow).vegaEmbed;
  if (typeof embed !== 'function') throw new Error('Vega-Embed is unavailable.');

  const { root, container } = createOffscreenRenderRoot();
  let view: VegaView | null = null;

  try {
    await nextAnimationFrame();
    const result = await embed(container, buildThemedSpec(spec, 'light', false), {
      actions: false,
      renderer: 'svg',
    });
    view = result?.view ?? null;
    await view?.runAsync?.();
    await nextAnimationFrame();

    const svg = getChartSvg(container);
    if (!svg) throw new Error('Vega-Lite export could not find an SVG node.');

    const { width, height } = getSvgExportDimensions(svg);
    const blob = await svgToPngBlob(svg, OFFSCREEN_EXPORT_SCALE);
    if (!blob) throw new Error('Vega-Lite PNG export failed.');
    return { src: await blobToDataUrl(blob), width, height };
  } finally {
    view?.finalize?.();
    root.remove();
  }
}
