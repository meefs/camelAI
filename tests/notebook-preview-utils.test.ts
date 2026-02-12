import { describe, expect, it } from 'vitest';
import type { NotebookCell, NotebookOutput } from '@/components/chat-file-preview/notebook-preview/types';
import {
  extractTocEntries,
  getOutputRender,
} from '@/components/chat-file-preview/notebook-preview/utils';

describe('notebook preview utils', () => {
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
  });
});
