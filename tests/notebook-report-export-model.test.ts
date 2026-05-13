import { describe, expect, it } from 'vitest';
import {
  buildNotebookReportExportModel,
  removeHeaderContentFromTitleCell,
} from '@/components/chat-file-preview/notebook-preview/report-export-model';
import type { NotebookFile } from '@/components/chat-file-preview/notebook-preview/types';

describe('notebook report export model', () => {
  it('removes the header title and subtitle from the title cell body', () => {
    const source = [
      '# Quarterly Review',
      '',
      'Executive summary line.',
      '',
      '## Findings',
      'Revenue increased.',
    ].join('\n');

    expect(removeHeaderContentFromTitleCell(source)).toBe([
      '## Findings',
      'Revenue increased.',
    ].join('\n'));
  });

  it('uses report-mode visibility rules and keeps report body content', () => {
    const notebook: NotebookFile = {
      metadata: {
        language_info: {
          version: '3.12.1',
        },
      },
      cells: [
        {
          cell_type: 'markdown',
          source: [
            '# Quarterly Review',
            'Executive summary line.',
            '',
            '## Findings',
            'Revenue increased.',
          ].join('\n'),
        },
        {
          cell_type: 'code',
          source: [
            'import pandas as pd',
            'import numpy as np',
            'from pathlib import Path',
          ].join('\n'),
          outputs: [],
        },
        {
          cell_type: 'code',
          source: 'print("ready")',
          outputs: [
            {
              output_type: 'stream',
              text: 'ready\n',
            },
          ],
        },
      ],
    };

    const model = buildNotebookReportExportModel(notebook);

    expect(model.languageVersion).toBe('3.12.1');
    expect(model.codeCellCount).toBe(2);
    expect(model.blocks).toHaveLength(2);
    expect(model.blocks[0]).toMatchObject({
      kind: 'markdown',
      markdown: ['## Findings', 'Revenue increased.'].join('\n'),
    });
    expect(model.blocks[1]).toMatchObject({
      kind: 'text',
      text: 'ready\n',
    });
  });

  it('keeps markdown display outputs as markdown report blocks', () => {
    const notebook: NotebookFile = {
      cells: [
        {
          cell_type: 'code',
          source: [
            'from IPython.display import Markdown',
            'from IPython.display import display',
          ].join('\n'),
          outputs: [
            {
              output_type: 'display_data',
              data: {
                'text/markdown': '## Result',
                'text/plain': '<IPython.core.display.Markdown object>',
              },
            },
          ],
        },
      ],
    };

    const model = buildNotebookReportExportModel(notebook);

    expect(model.blocks).toEqual([
      expect.objectContaining({
        kind: 'markdown',
        markdown: '## Result',
      }),
    ]);
  });

  it('excludes ignorable plain-text repr outputs but keeps normal text outputs', () => {
    const notebook: NotebookFile = {
      cells: [
        {
          cell_type: 'code',
          source: 'show_results()',
          outputs: [
            {
              output_type: 'execute_result',
              data: {
                'text/plain': "DataTransformerRegistry.enable('default')",
              },
            },
            {
              output_type: 'stream',
              text: 'ready\n',
            },
          ],
        },
      ],
    };

    const model = buildNotebookReportExportModel(notebook);

    expect(model.blocks).toEqual([
      expect.objectContaining({
        id: 'cell-0-output-0',
        kind: 'text',
        text: 'ready\n',
      }),
    ]);
  });

  it('keeps rich markdown, table, and chart outputs with text/plain fallbacks', () => {
    const notebook: NotebookFile = {
      cells: [
        {
          cell_type: 'code',
          source: 'display_results()',
          outputs: [
            {
              output_type: 'display_data',
              data: {
                'text/markdown': '## Result',
                'text/plain': '<IPython.core.display.Markdown object>',
              },
            },
            {
              output_type: 'display_data',
              data: {
                'text/html': [
                  '<table>',
                  '<thead><tr><th>Metric</th><th>Value</th></tr></thead>',
                  '<tbody><tr><td>Accuracy</td><td>0.91</td></tr></tbody>',
                  '</table>',
                ],
                'text/plain': '<IPython.core.display.HTML object>',
              },
            },
            {
              output_type: 'display_data',
              data: {
                'application/vnd.vegalite.v5+json': {
                  mark: 'bar',
                  data: { values: [{ x: 'A', y: 1 }] },
                  encoding: {
                    x: { field: 'x', type: 'nominal' },
                    y: { field: 'y', type: 'quantitative' },
                  },
                },
                'text/plain': '<IPython.core.display.JSON object>',
              },
            },
          ],
        },
      ],
    };

    const model = buildNotebookReportExportModel(notebook);

    expect(model.blocks.map((block) => block.kind)).toEqual(['markdown', 'table', 'chart']);
  });
});
