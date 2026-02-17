import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  exportDataAsCsv,
  hasSvgExportSupport,
} from '@/components/chat-file-preview/notebook-preview/chart-export-utils';

async function readBlobText(blob: Blob): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read blob.'));
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.readAsText(blob);
  });
}

describe('chart export utils', () => {
  let exportedBlob: Blob | null = null;

  beforeEach(() => {
    exportedBlob = null;

    if (typeof URL.createObjectURL !== 'function') {
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        writable: true,
        value: () => 'blob:mock-url',
      });
    }

    if (typeof URL.revokeObjectURL !== 'function') {
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        writable: true,
        value: () => {},
      });
    }

    vi.spyOn(URL, 'createObjectURL').mockImplementation((value: Blob | MediaSource) => {
      if (value instanceof Blob) {
        exportedBlob = value;
      }
      return 'blob:mock-url';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses top-level data.name to choose the Vega dataset for CSV export', async () => {
    exportDataAsCsv(
      'vegalite',
      {
        data: { name: 'sales_rows' },
        datasets: {
          unrelated_rows: [{ wrong: 'skip-me' }],
          sales_rows: [
            { month: 'Jan', total: 10 },
            { month: 'Feb', total: 15 },
          ],
        },
      },
      'Monthly sales'
    );

    expect(exportedBlob).not.toBeNull();
    const csv = await readBlobText(exportedBlob!);

    expect(csv).toContain('month,total');
    expect(csv).toContain('Jan,10');
    expect(csv).toContain('Feb,15');
    expect(csv).not.toContain('skip-me');
    expect(csv).not.toContain('wrong');
  });

  it('uses layer-level data.name to choose the Vega dataset for CSV export', async () => {
    exportDataAsCsv(
      'vegalite',
      {
        layer: [
          {
            mark: 'line',
            data: { name: 'layer_rows' },
          },
        ],
        datasets: {
          first_rows: [{ value: 'not-selected' }],
          layer_rows: [{ value: 42 }],
        },
      },
      'Layered chart'
    );

    expect(exportedBlob).not.toBeNull();
    const csv = await readBlobText(exportedBlob!);

    expect(csv).toContain('value');
    expect(csv).toContain('42');
    expect(csv).not.toContain('not-selected');
  });

  it('flags plotly svg export support based on trace types', () => {
    expect(hasSvgExportSupport('vegalite', {})).toBe(true);
    expect(hasSvgExportSupport('plotly', { data: [{ type: 'scatter' }] })).toBe(true);
    expect(hasSvgExportSupport('plotly', { data: [{ type: 'scattergl' }] })).toBe(false);
    expect(hasSvgExportSupport('plotly', { data: [{ type: 'surface' }] })).toBe(false);
    expect(
      hasSvgExportSupport('plotly', {
        data: [{ type: 'scatter' }, { type: 'scattergl' }],
      })
    ).toBe(false);
  });
});
