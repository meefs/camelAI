'use client';

import type { RefObject } from 'react';
import {
  cloneSvgForExport,
  dataUrlToBlob,
  getChartSvg,
  sanitizeFilename,
  svgToPngBlob,
  triggerBlobDownload,
  type PlotlyWindow,
} from './chart-runtime';

type ChartKind = 'vegalite' | 'plotly';
const PLOTLY_NON_SVG_TRACE_TYPES = new Set([
  'scatter3d',
  'surface',
  'mesh3d',
  'cone',
  'streamtube',
  'volume',
  'isosurface',
  'splom',
  'pointcloud',
  'parcoords',
  'scattermapbox',
  'densitymapbox',
  'choroplethmapbox',
  'scattermap',
  'densitymap',
  'choroplethmap',
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
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

async function exportPlotlyAsSvg(
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
      format: 'svg',
      width,
      height,
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

function hasRecordValues(values: unknown[]): boolean {
  for (const value of values) {
    if (asRecord(value)) {
      return true;
    }
  }
  return false;
}

function walkVegaDataNodes(
  node: unknown,
  onDataNode: (dataNode: Record<string, unknown>) => boolean
): boolean {
  const stack: unknown[] = [node];
  const visited = new Set<Record<string, unknown>>();

  while (stack.length > 0) {
    const current = stack.pop();
    const record = asRecord(current);
    if (!record || visited.has(record)) continue;
    visited.add(record);

    for (const [key, value] of Object.entries(record)) {
      if (key === 'datasets' || key === 'values') {
        continue;
      }

      if (key === 'data') {
        if (Array.isArray(value)) {
          for (const item of value) {
            const dataNode = asRecord(item);
            if (dataNode && onDataNode(dataNode)) {
              return true;
            }
          }
        } else {
          const dataNode = asRecord(value);
          if (dataNode && onDataNode(dataNode)) {
            return true;
          }
        }
        continue;
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          stack.push(item);
        }
        continue;
      }

      const child = asRecord(value);
      if (child) {
        stack.push(child);
      }
    }
  }

  return false;
}

function extractInlineVegaData(spec: Record<string, unknown>): Record<string, unknown>[] | null {
  let extractedRows: Record<string, unknown>[] | null = null;

  walkVegaDataNodes(spec, (dataNode) => {
    if (!Array.isArray(dataNode.values)) {
      return false;
    }

    const rows = getRowsFromValues(dataNode.values);
    if (!rows) {
      return false;
    }

    extractedRows = rows;
    return true;
  });

  return extractedRows;
}

function collectReferencedVegaDatasetNames(spec: Record<string, unknown>): string[] {
  const names: string[] = [];
  const seenNames = new Set<string>();

  walkVegaDataNodes(spec, (dataNode) => {
    if (typeof dataNode.name !== 'string') {
      return false;
    }

    const name = dataNode.name.trim();
    if (name.length === 0 || seenNames.has(name)) {
      return false;
    }

    seenNames.add(name);
    names.push(name);
    return false;
  });

  return names;
}

function hasVegaDataCandidate(spec: Record<string, unknown>): boolean {
  const hasInlineData = walkVegaDataNodes(spec, (dataNode) => (
    Array.isArray(dataNode.values) && hasRecordValues(dataNode.values)
  ));
  if (hasInlineData) return true;

  if (Array.isArray(spec.datasets)) {
    for (const dataset of spec.datasets) {
      if (Array.isArray(dataset) && hasRecordValues(dataset)) {
        return true;
      }
    }
  }

  const datasets = asRecord(spec.datasets);
  if (!datasets) return false;

  const referencedDatasetNames = collectReferencedVegaDatasetNames(spec);
  for (const datasetName of referencedDatasetNames) {
    const dataset = datasets[datasetName];
    if (!Array.isArray(dataset)) continue;
    if (hasRecordValues(dataset)) {
      return true;
    }
  }

  for (const dataset of Object.values(datasets)) {
    if (!Array.isArray(dataset)) continue;
    if (hasRecordValues(dataset)) {
      return true;
    }
  }

  return false;
}

function extractVegaData(spec: Record<string, unknown>): Record<string, unknown>[] | null {
  const inlineRows = extractInlineVegaData(spec);
  if (inlineRows) return inlineRows;

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
    const referencedDatasetNames = collectReferencedVegaDatasetNames(spec);
    for (const datasetName of referencedDatasetNames) {
      const dataset = datasets[datasetName];
      if (!Array.isArray(dataset)) continue;
      const rows = getRowsFromValues(dataset);
      if (rows) return rows;
    }

    for (const dataset of Object.values(datasets)) {
      if (!Array.isArray(dataset)) continue;
      const rows = getRowsFromValues(dataset);
      if (rows) return rows;
    }
  }

  return null;
}

function getPlotlyTraces(payload: Record<string, unknown>): Record<string, unknown>[] {
  const figure = asRecord(payload.figure);
  const rawTraces =
    Array.isArray(payload.data)
      ? payload.data
      : Array.isArray(figure?.data)
        ? figure.data
        : [];

  return rawTraces
    .map((trace) => asRecord(trace))
    .filter((trace): trace is Record<string, unknown> => Boolean(trace));
}

function isPlotlyTraceSvgCapable(trace: Record<string, unknown>): boolean {
  const traceType = typeof trace.type === 'string' ? trace.type.trim().toLowerCase() : 'scatter';
  if (traceType.endsWith('gl')) {
    return false;
  }
  return !PLOTLY_NON_SVG_TRACE_TYPES.has(traceType);
}

function extractPlotlyData(payload: Record<string, unknown>): Record<string, unknown>[] | null {
  const traces = getPlotlyTraces(payload);
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

function hasPlotlyDataCandidate(spec: Record<string, unknown>): boolean {
  const traces = getPlotlyTraces(spec);
  if (traces.length === 0) return false;

  return traces.some((trace) => (
    (Array.isArray(trace.x) && trace.x.length > 0)
    || (Array.isArray(trace.y) && trace.y.length > 0)
    || (Array.isArray(trace.labels) && trace.labels.length > 0)
    || (Array.isArray(trace.values) && trace.values.length > 0)
  ));
}

export function hasExtractableData(kind: ChartKind, spec: Record<string, unknown>): boolean {
  if (kind === 'vegalite') {
    return hasVegaDataCandidate(spec);
  }
  return hasPlotlyDataCandidate(spec);
}

export function hasSvgExportSupport(kind: ChartKind, spec: Record<string, unknown>): boolean {
  if (kind !== 'plotly') {
    return true;
  }

  const traces = getPlotlyTraces(spec);
  if (traces.length === 0) {
    return false;
  }

  return traces.every((trace) => isPlotlyTraceSvgCapable(trace));
}

export async function exportAsSvg(
  kind: ChartKind,
  containerRef: RefObject<HTMLDivElement | null>,
  title: string
): Promise<void> {
  const container = containerRef.current;
  if (!container) return;

  const filename = `${sanitizeFilename(title)}.svg`;
  if (kind === 'plotly') {
    await exportPlotlyAsSvg(container, filename);
    return;
  }

  const svgElement = getChartSvg(container);
  if (!svgElement) return;

  const svgString = new XMLSerializer().serializeToString(cloneSvgForExport(svgElement));
  triggerBlobDownload(
    new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' }),
    filename
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
