'use client';

import type { RefObject } from 'react';

type ChartKind = 'vegalite' | 'plotly';

interface PlotlyExportApi {
  toImage?: (
    root: HTMLElement,
    options?: Record<string, unknown>
  ) => Promise<string>;
}

interface PlotlyWindow extends Window {
  Plotly?: PlotlyExportApi;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function sanitizeFilename(title: string): string {
  const safe = title
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');

  return safe.slice(0, 80) || 'chart';
}

function triggerBlobDownload(blob: Blob, filename: string): void {
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

function dataUrlToBlob(dataUrl: string): Blob | null {
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

function getChartSvg(container: HTMLElement): SVGSVGElement | null {
  const svgElement = container.querySelector('svg');
  return svgElement instanceof SVGSVGElement ? svgElement : null;
}

function getSvgExportDimensions(svg: SVGSVGElement): { width: number; height: number } {
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

function cloneSvgForExport(svg: SVGSVGElement): SVGSVGElement {
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

async function svgToPngBlob(svg: SVGSVGElement, scale = 2): Promise<Blob | null> {
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

async function exportPlotlyAsPng(
  container: HTMLElement,
  filename: string
): Promise<boolean> {
  const plotRoot = container.querySelector('.js-plotly-plot');
  if (!(plotRoot instanceof HTMLElement)) return false;

  const plotly = (window as PlotlyWindow).Plotly;
  if (!plotly?.toImage) return false;

  const rect = plotRoot.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width || 800));
  const height = Math.max(1, Math.round(rect.height || 500));

  try {
    const dataUrl = await plotly.toImage(plotRoot, {
      format: 'png',
      width,
      height,
      scale: 2,
    });
    if (!dataUrl.startsWith('data:')) {
      return false;
    }

    const blob = dataUrlToBlob(dataUrl);
    if (!blob) return false;
    triggerBlobDownload(blob, filename);
    return true;
  } catch {
    return false;
  }
}

function escapeCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function objectsToCsv(rows: Record<string, unknown>[]): string {
  const keys: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!keys.includes(key)) {
        keys.push(key);
      }
    }
  }

  const header = keys.map((key) => escapeCell(key)).join(',');
  const body = rows.map((row) => (
    keys.map((key) => escapeCell(String(row[key] ?? ''))).join(',')
  ));

  return [header, ...body].join('\r\n');
}

function getRowsFromValues(values: unknown[]): Record<string, unknown>[] | null {
  if (values.length === 0) return null;
  const rows = values
    .map((value) => asRecord(value))
    .filter((value): value is Record<string, unknown> => Boolean(value));
  return rows.length > 0 ? rows : null;
}

function extractVegaData(spec: Record<string, unknown>): Record<string, unknown>[] | null {
  const specData = asRecord(spec.data);
  if (specData && Array.isArray(specData.values)) {
    const rows = getRowsFromValues(specData.values);
    if (rows) return rows;
  }

  if (Array.isArray(spec.datasets)) {
    for (const dataset of spec.datasets) {
      if (Array.isArray(dataset)) {
        const rows = getRowsFromValues(dataset);
        if (rows) return rows;
      }
    }
  }

  const datasets = asRecord(spec.datasets);
  if (datasets) {
    for (const dataset of Object.values(datasets)) {
      if (!Array.isArray(dataset)) continue;
      const rows = getRowsFromValues(dataset);
      if (rows) return rows;
    }
  }

  if (Array.isArray(spec.layer)) {
    for (const layer of spec.layer) {
      const layerRecord = asRecord(layer);
      if (!layerRecord) continue;
      const layerData = asRecord(layerRecord.data);
      if (!layerData || !Array.isArray(layerData.values)) continue;
      const rows = getRowsFromValues(layerData.values);
      if (rows) return rows;
    }
  }

  return null;
}

function extractPlotlyData(payload: Record<string, unknown>): Record<string, unknown>[] | null {
  const figure = asRecord(payload.figure);
  const rawTraces =
    Array.isArray(payload.data)
      ? payload.data
      : Array.isArray(figure?.data)
        ? figure.data
        : [];

  const traces = rawTraces
    .map((trace) => asRecord(trace))
    .filter((trace): trace is Record<string, unknown> => Boolean(trace));
  if (traces.length === 0) return null;

  const rows: Record<string, unknown>[] = [];

  traces.forEach((trace, traceIndex) => {
    const traceName = typeof trace.name === 'string' && trace.name.trim().length > 0
      ? trace.name
      : `trace_${traceIndex + 1}`;
    const x = Array.isArray(trace.x) ? trace.x : [];
    const y = Array.isArray(trace.y) ? trace.y : [];
    const labels = Array.isArray(trace.labels) ? trace.labels : [];
    const values = Array.isArray(trace.values) ? trace.values : [];

    if (x.length > 0 || y.length > 0) {
      const rowCount = Math.max(x.length, y.length);
      for (let i = 0; i < rowCount; i += 1) {
        rows.push({
          trace: traceName,
          x: x[i] ?? i,
          y: y[i] ?? '',
        });
      }
      return;
    }

    if (labels.length > 0 || values.length > 0) {
      const rowCount = Math.max(labels.length, values.length);
      for (let i = 0; i < rowCount; i += 1) {
        rows.push({
          trace: traceName,
          label: labels[i] ?? '',
          value: values[i] ?? '',
        });
      }
    }
  });

  return rows.length > 0 ? rows : null;
}

function getRowsForCsv(kind: ChartKind, spec: Record<string, unknown>): Record<string, unknown>[] | null {
  if (kind === 'vegalite') {
    return extractVegaData(spec);
  }
  return extractPlotlyData(spec);
}

export function hasExtractableData(kind: ChartKind, spec: Record<string, unknown>): boolean {
  return getRowsForCsv(kind, spec) !== null;
}

export function exportAsSvg(
  _kind: ChartKind,
  containerRef: RefObject<HTMLDivElement | null>,
  title: string
): void {
  const container = containerRef.current;
  if (!container) return;

  const svgElement = getChartSvg(container);
  if (!svgElement) return;

  const svgString = new XMLSerializer().serializeToString(cloneSvgForExport(svgElement));
  triggerBlobDownload(
    new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' }),
    `${sanitizeFilename(title)}.svg`
  );
}

export async function exportAsPng(
  kind: ChartKind,
  containerRef: RefObject<HTMLDivElement | null>,
  title: string
): Promise<void> {
  const container = containerRef.current;
  if (!container) return;

  const filename = `${sanitizeFilename(title)}.png`;
  if (kind === 'plotly') {
    const exportedByPlotly = await exportPlotlyAsPng(container, filename);
    if (exportedByPlotly) return;
  }

  const svgElement = getChartSvg(container);
  if (!svgElement) return;

  const pngBlob = await svgToPngBlob(svgElement, 2);
  if (!pngBlob) return;
  triggerBlobDownload(pngBlob, filename);
}

export function exportDataAsCsv(
  kind: ChartKind,
  spec: Record<string, unknown>,
  title: string
): void {
  const rows = getRowsForCsv(kind, spec);
  if (!rows || rows.length === 0) return;

  const csv = objectsToCsv(rows);
  triggerBlobDownload(
    new Blob([csv], { type: 'text/csv;charset=utf-8;' }),
    `${sanitizeFilename(title)}.csv`
  );
}
