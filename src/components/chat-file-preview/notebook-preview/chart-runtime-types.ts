'use client';

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
