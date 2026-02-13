import { describe, expect, it } from 'vitest';
import type {
  NotebookCell,
  NotebookFile,
  NotebookOutput,
} from '@/components/chat-file-preview/notebook-preview/types';
import {
  extractTocEntries,
  getNotebookCells,
  getOutputRender,
} from '@/components/chat-file-preview/notebook-preview/utils';

describe('notebook preview utils', () => {
  describe('getNotebookCells', () => {
    it('returns an empty array when notebook.cells is not an array', () => {
      const malformedNotebook = {
        cells: { broken: true },
      } as unknown as NotebookFile;

      expect(getNotebookCells(malformedNotebook)).toEqual([]);
    });
  });

  describe('extractTocEntries', () => {
    it('ignores h2/h3 headings inside fenced markdown code blocks', () => {
      const cells: NotebookCell[] = [
        {
          cell_type: 'markdown',
          source: [
            '## Overview',
            '```python',
            '## Not a real heading',
            '### Also not a real heading',
            '```',
            '### Findings',
          ].join('\n'),
        },
        {
          cell_type: 'markdown',
          source: [
            '~~~sql',
            '## Still not a heading',
            '~~~',
            '## Conclusion',
          ].join('\n'),
        },
      ];

      const entries = extractTocEntries(cells, null);

      expect(entries).toEqual([
        { id: 'toc-0', text: 'Overview', level: 2, cellIndex: 0 },
        { id: 'toc-1', text: 'Findings', level: 3, cellIndex: 0 },
        { id: 'toc-2', text: 'Conclusion', level: 2, cellIndex: 1 },
      ]);
    });
  });

  describe('getOutputRender', () => {
    it('parses Vega specs from direct vegaEmbed(...) calls', () => {
      const output: NotebookOutput = {
        output_type: 'display_data',
        data: {
          'text/html': `
            <div id="chart"></div>
            <script>
              const spec = {
                "$schema": "https://vega.github.io/schema/vega-lite/v5.json",
                "mark": "bar",
                "data": { "values": [{ "x": "A", "y": 1 }] },
                "encoding": {
                  "x": { "field": "x", "type": "nominal" },
                  "y": { "field": "y", "type": "quantitative" }
                }
              };
              const embedOpt = { "mode": "vega-lite", "actions": false };
              vegaEmbed("#chart", spec, embedOpt).catch(console.error);
            </script>
          `,
        },
      };

      const render = getOutputRender(output);

      expect(render.kind).toBe('vegalite');
      if (render.kind !== 'vegalite') {
        throw new Error(`Expected vegalite output, got ${render.kind}`);
      }
      expect(render.spec.mark).toBe('bar');
    });

    it('keeps support for wrapped invocation patterns', () => {
      const output: NotebookOutput = {
        output_type: 'display_data',
        data: {
          'text/html': `
            <div id="chart"></div>
            <script>
              (function(spec, embedOpt) {
                vegaEmbed("#chart", spec, embedOpt).catch(console.error);
              })(
                {
                  "$schema": "https://vega.github.io/schema/vega-lite/v5.json",
                  "mark": "line"
                },
                { "mode": "vega-lite" }
              );
            </script>
          `,
        },
      };

      const render = getOutputRender(output);

      expect(render.kind).toBe('vegalite');
      if (render.kind !== 'vegalite') {
        throw new Error(`Expected vegalite output, got ${render.kind}`);
      }
      expect(render.spec.mark).toBe('line');
    });

    it('parses pandas-style html tables as native table output', () => {
      const output: NotebookOutput = {
        output_type: 'display_data',
        data: {
          'text/html': `
            <div>
              <style scoped>
                .dataframe tbody tr th:only-of-type { vertical-align: middle; }
              </style>
              <table border="1" class="dataframe">
                <thead>
                  <tr style="text-align: right;">
                    <th></th>
                    <th>First Name</th>
                    <th>Last Name</th>
                    <th>Score</th>
                  </tr>
                  <tr>
                    <th>Rank</th>
                    <th></th>
                    <th></th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th>1</th>
                    <td>Philippe</td>
                    <td>SALLE</td>
                    <td>16</td>
                  </tr>
                  <tr>
                    <th>2</th>
                    <td>Maryse</td>
                    <td>AULAGNON</td>
                    <td>12</td>
                  </tr>
                </tbody>
              </table>
            </div>
          `,
        },
      };

      const render = getOutputRender(output);

      expect(render.kind).toBe('table');
      if (render.kind !== 'table') {
        throw new Error(`Expected table output, got ${render.kind}`);
      }

      expect(render.table.headers).toEqual(['Rank', 'First Name', 'Last Name', 'Score']);
      expect(render.table.rows).toEqual([
        ['1', 'Philippe', 'SALLE', '16'],
        ['2', 'Maryse', 'AULAGNON', '12'],
      ]);
      expect(render.table.indexColumns).toBe(1);
      expect(render.table.caption).toBe('2 rows × 3 columns');
    });

    it('keeps pandas styler html in iframe-compatible html mode', () => {
      const output: NotebookOutput = {
        output_type: 'display_data',
        data: {
          'text/html': `
            <style type="text/css">
              #T_abcd1234_row0_col0 { background-color: #fef08a; }
            </style>
            <table id="T_abcd1234" class="Styler">
              <thead><tr><th>value</th></tr></thead>
              <tbody><tr><td>42</td></tr></tbody>
            </table>
          `,
        },
      };

      const render = getOutputRender(output);
      expect(render.kind).toBe('html');
    });

    it('falls back to html mode for span-based table layouts', () => {
      const output: NotebookOutput = {
        output_type: 'display_data',
        data: {
          'text/html': `
            <table>
              <thead>
                <tr><th colspan="2">Summary</th></tr>
                <tr><th>Metric</th><th>Value</th></tr>
              </thead>
              <tbody>
                <tr><td>Headcount</td><td>120</td></tr>
              </tbody>
            </table>
          `,
        },
      };

      const render = getOutputRender(output);
      expect(render.kind).toBe('html');
    });
  });
});
