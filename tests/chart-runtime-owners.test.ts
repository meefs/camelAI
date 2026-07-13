import { describe, expect, it } from 'vitest';

import {
  buildThemedPlotlyFigure,
  buildThemedSpec,
  hasArcMark,
  sanitizeFilename,
} from '@/components/chat-file-preview/notebook-preview/chart-runtime';

describe('chart runtime owners', () => {
  it('themes Plotly figures without mutating the source payload', () => {
    const source = {
      data: [{ x: [1], y: [2] }],
      layout: {
        width: 900,
        height: 1_200,
        title: 'Revenue',
        xaxis: { tickfont: { size: 12 } },
      },
      config: { modeBarButtonsToRemove: ['zoom2d'] },
    };

    const result = buildThemedPlotlyFigure(source, 'dark', true, false);

    expect(source.layout).toEqual({
      width: 900,
      height: 1_200,
      title: 'Revenue',
      xaxis: { tickfont: { size: 12 } },
    });
    expect(result.layout).toMatchObject({
      height: 900,
      autosize: true,
      title: { text: 'Revenue', font: { color: '#e4e4e7' } },
      xaxis: { tickfont: { size: 12, color: '#a1a1aa' } },
    });
    expect(result.layout).not.toHaveProperty('width');
    expect(result.config.modeBarButtonsToRemove).toEqual([
      'zoom2d',
      'sendDataToCloud',
      'toggleSpikelines',
    ]);
  });

  it('themes Vega-Lite specs and preserves explicit config overrides', () => {
    const source = {
      width: 300,
      height: 300,
      mark: 'bar',
      config: { axis: { labelColor: 'tomato' } },
    };

    const result = buildThemedSpec(source, 'light', false);

    expect(source).toEqual({
      width: 300,
      height: 300,
      mark: 'bar',
      config: { axis: { labelColor: 'tomato' } },
    });
    expect(result.width).toBe('container');
    expect(result).not.toHaveProperty('height');
    expect(result.config).toMatchObject({
      axis: { labelColor: 'tomato', titleColor: '#1f2937' },
      view: { fill: 'transparent', stroke: null },
    });
  });

  it('keeps mark detection and filename policy independent of renderers', () => {
    expect(hasArcMark({ layer: [{ mark: { type: 'arc' } }] })).toBe(true);
    expect(hasArcMark({ mark: 'line' })).toBe(false);
    expect(sanitizeFilename('  Quarterly Revenue / 2026  ')).toBe(
      'quarterly_revenue_2026'
    );
    expect(sanitizeFilename('💹')).toBe('chart');
  });
});
