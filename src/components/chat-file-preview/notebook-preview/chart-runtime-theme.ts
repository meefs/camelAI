'use client';

import type { ThemeMode } from './chart-runtime-types';

function cloneValue<T>(value: T): T {
  return structuredClone(value);
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
  const nextAxis = { ...asRecord(axisInput) };
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

export function getCurrentTheme(): ThemeMode {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
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
  const layout = cloneValue(baseLayout);
  const config = cloneValue(asRecord(payload.config));

  const dark = theme === 'dark';
  const axisColor = dark ? '#a1a1aa' : '#475569';
  const textColor = dark ? '#e4e4e7' : '#1f2937';
  const gridColor = dark ? 'rgba(113,113,122,0.35)' : 'rgba(148,163,184,0.35)';

  delete layout.width;
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

  const axisKeys = Object.keys(layout).filter((key) => /^[xy]axis\d*$/.test(key));
  if (axisKeys.length === 0) {
    layout.xaxis = patchAxisTheme(layout.xaxis, axisColor, textColor, gridColor);
    layout.yaxis = patchAxisTheme(layout.yaxis, axisColor, textColor, gridColor);
  } else {
    for (const key of axisKeys) {
      layout[key] = patchAxisTheme(layout[key], axisColor, textColor, gridColor);
    }
  }

  const legend = asRecord(layout.legend);
  if (legend.bgcolor == null) legend.bgcolor = 'rgba(0,0,0,0)';
  if (legend.bordercolor == null) legend.bordercolor = 'rgba(0,0,0,0)';
  const legendFont = asRecord(legend.font);
  if (legendFont.color == null) legendFont.color = textColor;
  legend.font = legendFont;
  layout.legend = legend;

  if (typeof layout.title === 'string') {
    layout.title = { text: layout.title, font: { color: textColor } };
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
    const existing = Array.isArray(nextConfig.modeBarButtonsToRemove)
      ? nextConfig.modeBarButtonsToRemove
      : [];
    nextConfig.modeBarButtonsToRemove = Array.from(
      new Set([...existing, 'sendDataToCloud', 'toggleSpikelines'])
    );
  }

  return { traces, layout, config: nextConfig };
}

export function buildThemedSpec(
  sourceSpec: Record<string, unknown>,
  theme: ThemeMode,
  fillContainer: boolean
): Record<string, unknown> {
  const nextSpec = cloneValue(sourceSpec);
  const dark = theme === 'dark';

  if (nextSpec.background == null) nextSpec.background = 'transparent';
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

  if (nextSpec.padding == null) nextSpec.padding = 0;
  nextSpec.autosize = {
    ...asRecord(nextSpec.autosize),
    type: 'fit',
    contains: 'padding',
    resize: true,
  };

  const existingConfig = asRecord(nextSpec.config);
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
    axis: { ...axisDefaults, ...asRecord(existingConfig.axis) },
    axisX: { ...axisDefaults, ...asRecord(existingConfig.axisX) },
    axisY: { ...axisDefaults, ...asRecord(existingConfig.axisY) },
    legend: {
      labelColor: dark ? '#e4e4e7' : '#1f2937',
      titleColor: dark ? '#e4e4e7' : '#1f2937',
      ...asRecord(existingConfig.legend),
    },
    view: {
      fill: 'transparent',
      stroke: null,
      ...asRecord(existingConfig.view),
    },
    title: {
      color: dark ? '#f4f4f5' : '#111827',
      subtitleColor: dark ? '#a1a1aa' : '#6b7280',
      ...asRecord(existingConfig.title),
    },
  };

  return nextSpec;
}

export function hasArcMark(spec: Record<string, unknown>): boolean {
  if (spec.mark === 'arc' || asRecord(spec.mark).type === 'arc') return true;
  if (!Array.isArray(spec.layer)) return false;
  return spec.layer.some((layer) => {
    const layerRecord = asRecord(layer);
    return layerRecord.mark === 'arc' || asRecord(layerRecord.mark).type === 'arc';
  });
}
