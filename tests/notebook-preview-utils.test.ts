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
  hasVisualOutput,
  isIgnorableTextOutput,
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

  describe('isIgnorableTextOutput', () => {
    it('detects Altair transformer registry text output', () => {
      const output: NotebookOutput = {
        output_type: 'execute_result',
        data: {
          'text/plain': "DataTransformerRegistry.enable('default')",
        },
      };

      expect(isIgnorableTextOutput(output)).toBe(true);
    });

    it('detects matplotlib line-list text output', () => {
      const output: NotebookOutput = {
        output_type: 'execute_result',
        data: {
          'text/plain': '[<matplotlib.lines.Line2D at 0x12abc1230>]',
        },
      };

      expect(isIgnorableTextOutput(output)).toBe(true);
    });

    it('detects IPython display object fallbacks when only text/plain exists', () => {
      const output: NotebookOutput = {
        output_type: 'display_data',
        data: {
          'text/plain': '<IPython.core.display.Markdown object>',
        },
      };

      expect(isIgnorableTextOutput(output)).toBe(true);
    });

    it('keeps IPython display object fallbacks when real markdown exists', () => {
      const output: NotebookOutput = {
        output_type: 'display_data',
        data: {
          'text/markdown': '## Result',
          'text/plain': '<IPython.core.display.Markdown object>',
        },
      };

      expect(isIgnorableTextOutput(output)).toBe(false);
    });

    it('does not suppress stream outputs', () => {
      const output: NotebookOutput = {
        output_type: 'stream',
        text: '[<matplotlib.lines.Line2D at 0x12abc1230>]',
      };

      expect(isIgnorableTextOutput(output)).toBe(false);
    });

    it('does not suppress error outputs', () => {
      const output: NotebookOutput = {
        output_type: 'error',
        ename: 'ValueError',
        evalue: 'bad value',
      };

      expect(isIgnorableTextOutput(output)).toBe(false);
    });

    it('does not suppress outputs with application/json payloads', () => {
      const output: NotebookOutput = {
        output_type: 'display_data',
        data: {
          'application/json': {},
          'text/plain': '<IPython.core.display.JSON object>',
        },
      };

      expect(isIgnorableTextOutput(output)).toBe(false);
    });

    it('does not suppress normal plain text outputs', () => {
      const output: NotebookOutput = {
        output_type: 'execute_result',
        data: {
          'text/plain': 'ready',
        },
      };

      expect(isIgnorableTextOutput(output)).toBe(false);
    });

    it('does not suppress scalar outputs', () => {
      const output: NotebookOutput = {
        output_type: 'execute_result',
        data: {
          'text/plain': '42',
        },
      };

      expect(isIgnorableTextOutput(output)).toBe(false);
    });
  });

  describe('getOutputRender', () => {
    it('renders text/markdown before text/plain fallbacks', () => {
      const output: NotebookOutput = {
        output_type: 'display_data',
        data: {
          'text/markdown': '## Summary\n\n**Ready**',
          'text/plain': '<IPython.core.display.Markdown object>',
        },
      };

      const render = getOutputRender(output);

      expect(render.kind).toBe('markdown');
      if (render.kind !== 'markdown') {
        throw new Error(`Expected markdown output, got ${render.kind}`);
      }
      expect(render.markdown).toBe('## Summary\n\n**Ready**');
    });

    it('joins array-valued text/markdown output before rendering', () => {
      const output: NotebookOutput = {
        output_type: 'display_data',
        data: {
          'text/markdown': ['# A\n', 'Body'],
          'text/plain': '<IPython.core.display.Markdown object>',
        },
      };

      const render = getOutputRender(output);

      expect(render.kind).toBe('markdown');
      if (render.kind !== 'markdown') {
        throw new Error(`Expected markdown output, got ${render.kind}`);
      }
      expect(render.markdown).toBe('# A\nBody');
    });

    it('preserves semantic whitespace in text/markdown output', () => {
      const output: NotebookOutput = {
        output_type: 'display_data',
        data: {
          'text/markdown': '    print("ready")\n',
          'text/plain': '<IPython.core.display.Markdown object>',
        },
      };

      const render = getOutputRender(output);

      expect(render.kind).toBe('markdown');
      if (render.kind !== 'markdown') {
        throw new Error(`Expected markdown output, got ${render.kind}`);
      }
      expect(render.markdown).toBe('    print("ready")\n');
    });

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

    it('parses pandas tables with a trailing dimension <p> tag', () => {
      const output: NotebookOutput = {
        output_type: 'execute_result',
        data: {
          'text/html': [
            '<div>\n',
            '<style scoped>\n',
            '    .dataframe tbody tr th:only-of-type { vertical-align: middle; }\n',
            '    .dataframe tbody tr th { vertical-align: top; }\n',
            '    .dataframe thead th { text-align: right; }\n',
            '</style>\n',
            '<table border="1" class="dataframe">\n',
            '  <thead>\n',
            '    <tr style="text-align: right;">\n',
            '      <th></th>\n',
            '      <th>query_id</th>\n',
            '      <th>status</th>\n',
            '    </tr>\n',
            '  </thead>\n',
            '  <tbody>\n',
            '    <tr>\n',
            '      <th>0</th>\n',
            '      <td>5128764</td>\n',
            '      <td>VALID</td>\n',
            '    </tr>\n',
            '    <tr>\n',
            '      <th>1</th>\n',
            '      <td>5128760</td>\n',
            '      <td>VALID</td>\n',
            '    </tr>\n',
            '  </tbody>\n',
            '</table>\n',
            '<p>3122 rows × 11 columns</p>\n',
            '</div>',
          ],
        },
      };

      const render = getOutputRender(output);

      expect(render.kind).toBe('table');
      if (render.kind !== 'table') {
        throw new Error(`Expected table output, got ${render.kind}`);
      }

      expect(render.table.headers).toEqual(['', 'query_id', 'status']);
      expect(render.table.rows).toEqual([
        ['0', '5128764', 'VALID'],
        ['1', '5128760', 'VALID'],
      ]);
      expect(render.table.indexColumns).toBe(1);
      expect(render.table.sourceRowCount).toBe(3122);
    });

    it('preserves pandas ellipsis indicator rows and extracts source row count', () => {
      const output: NotebookOutput = {
        output_type: 'execute_result',
        data: {
          'text/html': [
            '<div>\n',
            '<style scoped>.dataframe { }</style>\n',
            '<table border="1" class="dataframe">\n',
            '  <thead><tr style="text-align: right;"><th></th><th>Name</th></tr></thead>\n',
            '  <tbody>\n',
            '    <tr><th>0</th><td>Alice</td></tr>\n',
            '    <tr><th>1</th><td>Bob</td></tr>\n',
            '    <tr><th>...</th><td>...</td></tr>\n',
            '    <tr><th>998</th><td>Yolanda</td></tr>\n',
            '    <tr><th>999</th><td>Zack</td></tr>\n',
            '  </tbody>\n',
            '</table>\n',
            '<p>1000 rows × 1 columns</p>\n',
            '</div>',
          ],
        },
      };

      const render = getOutputRender(output);

      expect(render.kind).toBe('table');
      if (render.kind !== 'table') {
        throw new Error(`Expected table output, got ${render.kind}`);
      }

      expect(render.table.rows).toEqual([
        ['0', 'Alice'],
        ['1', 'Bob'],
        ['...', '...'],
        ['998', 'Yolanda'],
        ['999', 'Zack'],
      ]);
      expect(render.table.sourceRowCount).toBe(1000);
    });

    it('parses rows across multiple tbody sections', () => {
      const output: NotebookOutput = {
        output_type: 'display_data',
        data: {
          'text/html': `
            <table>
              <thead>
                <tr><th>ID</th><th>Value</th></tr>
              </thead>
              <tbody>
                <tr><td>1</td><td>A</td></tr>
              </tbody>
              <tbody>
                <tr><td>2</td><td>B</td></tr>
                <tr><td>3</td><td>C</td></tr>
              </tbody>
            </table>
          `,
        },
      };

      const render = getOutputRender(output);

      expect(render.kind).toBe('table');
      if (render.kind !== 'table') {
        throw new Error(`Expected table output, got ${render.kind}`);
      }

      expect(render.table.headers).toEqual(['ID', 'Value']);
      expect(render.table.rows).toEqual([
        ['1', 'A'],
        ['2', 'B'],
        ['3', 'C'],
      ]);
      expect(render.table.caption).toBe('3 rows × 2 columns');
    });

    it('decodes standard named html entities in native tables', () => {
      const output: NotebookOutput = {
        output_type: 'display_data',
        data: {
          'text/html': `
            <table>
              <tr><th>Symbol</th><th>Note</th></tr>
              <tr><td>&euro;</td><td>&copy; 2026</td></tr>
            </table>
          `,
        },
      };

      const render = getOutputRender(output);

      expect(render.kind).toBe('table');
      if (render.kind !== 'table') {
        throw new Error(`Expected table output, got ${render.kind}`);
      }

      expect(render.table.headers).toEqual(['Symbol', 'Note']);
      expect(render.table.rows).toEqual([['€', '© 2026']]);
    });

    it('treats an all-th first row as headers when no thead is present', () => {
      const output: NotebookOutput = {
        output_type: 'display_data',
        data: {
          'text/html': `
            <table class="dataframe">
              <tr>
                <th></th>
                <th>Name</th>
                <th>Score</th>
              </tr>
              <tr>
                <th>0</th>
                <td>Alice</td>
                <td>10</td>
              </tr>
              <tr>
                <th>1</th>
                <td>Bob</td>
                <td>9</td>
              </tr>
            </table>
          `,
        },
      };

      const render = getOutputRender(output);

      expect(render.kind).toBe('table');
      if (render.kind !== 'table') {
        throw new Error(`Expected table output, got ${render.kind}`);
      }

      expect(render.table.headers).toEqual(['', 'Name', 'Score']);
      expect(render.table.rows).toEqual([
        ['0', 'Alice', '10'],
        ['1', 'Bob', '9'],
      ]);
      expect(render.table.indexColumns).toBe(1);
      expect(render.table.caption).toBe('2 rows × 2 columns');
    });

    it('parses large html tables without spread-based max width failures', () => {
      const rowCount = 140000;
      const rowsHtml = Array.from({ length: rowCount }, (_, index) => `<tr><td>${index}</td></tr>`).join('');
      const output: NotebookOutput = {
        output_type: 'display_data',
        data: {
          'text/html': `<table><tbody>${rowsHtml}</tbody></table>`,
        },
      };

      const render = getOutputRender(output);
      expect(render.kind).toBe('table');
      if (render.kind !== 'table') {
        throw new Error(`Expected table output, got ${render.kind}`);
      }

      expect(render.table.rows.length).toBe(rowCount);
      expect(render.table.caption).toBe('140000 rows × 1 column');
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

    it('falls back to html mode when table output includes surrounding prose', () => {
      const output: NotebookOutput = {
        output_type: 'display_data',
        data: {
          'text/html': `
            <div>
              <p>Summary of results:</p>
              <table>
                <tr><th>Metric</th><th>Value</th></tr>
                <tr><td>Accuracy</td><td>0.92</td></tr>
              </table>
            </div>
          `,
        },
      };

      const render = getOutputRender(output);
      expect(render.kind).toBe('html');
    });

    it('falls back to html mode when html output contains multiple tables', () => {
      const output: NotebookOutput = {
        output_type: 'display_data',
        data: {
          'text/html': `
            <table>
              <tr><th>A</th></tr>
              <tr><td>1</td></tr>
            </table>
            <table>
              <tr><th>B</th></tr>
              <tr><td>2</td></tr>
            </table>
          `,
        },
      };

      const render = getOutputRender(output);
      expect(render.kind).toBe('html');
    });

    it('falls back to html mode when table literals only appear inside script blocks', () => {
      const output: NotebookOutput = {
        output_type: 'display_data',
        data: {
          'text/html': `
            <div id="widget"></div>
            <script>
              const tpl = '<table><tr><td>Template</td></tr></table>';
              window.renderWidget?.(tpl);
            </script>
          `,
        },
      };

      const render = getOutputRender(output);
      expect(render.kind).toBe('html');
    });

    it('falls back to html mode when table literals only appear inside style blocks', () => {
      const output: NotebookOutput = {
        output_type: 'display_data',
        data: {
          'text/html': `
            <style>
              .preview::after { content: "<table><tr><td>Template</td></tr></table>"; }
            </style>
            <div class="preview">Done</div>
          `,
        },
      };

      const render = getOutputRender(output);
      expect(render.kind).toBe('html');
    });
  });

  describe('hasVisualOutput', () => {
    it('counts markdown-only display outputs as visual output', () => {
      expect(
        hasVisualOutput([
          {
            output_type: 'display_data',
            data: {
              'text/markdown': '## Result',
            },
          },
        ])
      ).toBe(true);
    });

    it('does not count empty markdown display outputs as visual output', () => {
      expect(
        hasVisualOutput([
          {
            output_type: 'display_data',
            data: {
              'text/markdown': ['   ', '\n'],
              'text/plain': '<IPython.core.display.Markdown object>',
            },
          },
        ])
      ).toBe(false);
    });
  });
});
