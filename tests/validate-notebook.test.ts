import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const validatorPath = path.join(root, 'sandbox/validate-notebook.py');

function findPython(): string | null {
  for (const command of ['python3', 'python']) {
    const result = spawnSync(command, ['--version'], { encoding: 'utf8' });
    if (result.status === 0) {
      return command;
    }
  }
  return null;
}

const python = findPython();
const describeIfPython = python ? describe : describe.skip;

function writeNotebook(cells: unknown[]): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'validate-notebook-'));
  const notebookPath = path.join(directory, 'analysis.ipynb');
  writeFileSync(
    notebookPath,
    JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells,
    }),
    'utf8'
  );
  return notebookPath;
}

function runValidator(notebookPath: string) {
  if (!python) {
    throw new Error('Python is required to run validate-notebook tests');
  }

  return spawnSync(python, [validatorPath, notebookPath], {
    cwd: root,
    encoding: 'utf8',
  });
}

function cleanupNotebook(notebookPath: string): void {
  rmSync(path.dirname(notebookPath), { recursive: true, force: true });
}

function codeCell(outputs: unknown[]) {
  return {
    cell_type: 'code',
    source: 'show_results()',
    metadata: {},
    execution_count: 1,
    outputs,
  };
}

describeIfPython('validate-notebook', () => {
  it('warns for ignorable setup repr text outputs', () => {
    const notebookPath = writeNotebook([
      codeCell([
        {
          output_type: 'execute_result',
          data: {
            'text/plain': "DataTransformerRegistry.enable('default')",
          },
        },
      ]),
      codeCell([
        {
          output_type: 'execute_result',
          data: {
            'text/plain': '[<matplotlib.lines.Line2D at 0x12abc1230>]',
          },
        },
      ]),
    ]);

    try {
      const result = runValidator(notebookPath);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain(
        'Cell 0 WARNING: setup output "DataTransformerRegistry.enable(\'default\')" should be suppressed with ; or assignment to _'
      );
      expect(result.stdout).toContain(
        'Cell 1 WARNING: setup output "[<matplotlib.lines.Line2D at 0x12abc1230>]" should be suppressed with ; or assignment to _'
      );
    } finally {
      cleanupNotebook(notebookPath);
    }
  });

  it('does not warn for normal text, scalar, stream, or rich outputs', () => {
    const notebookPath = writeNotebook([
      codeCell([
        {
          output_type: 'execute_result',
          data: {
            'text/plain': 'ready',
          },
        },
        {
          output_type: 'execute_result',
          data: {
            'text/plain': '42',
          },
        },
        {
          output_type: 'stream',
          name: 'stdout',
          text: '3 rows processed\n',
        },
        {
          output_type: 'display_data',
          data: {
            'text/html': '<p>ready</p>',
            'text/plain': '<IPython.core.display.HTML object>',
          },
        },
        {
          output_type: 'display_data',
          data: {
            'text/markdown': '## Ready',
            'text/plain': '<IPython.core.display.Markdown object>',
          },
        },
        {
          output_type: 'display_data',
          data: {
            'image/png': 'aW1hZ2U=',
            'text/plain': '<matplotlib.figure.Figure object at 0x12abc1230>',
          },
        },
        {
          output_type: 'display_data',
          data: {
            'application/json': {},
            'text/plain': '<IPython.core.display.JSON object>',
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
        {
          output_type: 'display_data',
          data: {
            'application/vnd.plotly.v1+json': { data: [] },
            'text/plain': '<IPython.core.display.JSON object>',
          },
        },
      ]),
    ]);

    try {
      const result = runValidator(notebookPath);

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('OK');
    } finally {
      cleanupNotebook(notebookPath);
    }
  });
});
