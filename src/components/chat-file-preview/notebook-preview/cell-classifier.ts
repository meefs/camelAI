import type {
  CellClassification,
  ClassifiedCell,
  NotebookCell,
} from './types';
import {
  getOutputText,
  hasVisualOutput,
  toText,
} from './utils';

export function classifyCell(cell: NotebookCell): CellClassification {
  if (cell.cell_type === 'markdown') return 'show';

  const source = toText(cell.source);
  const outputs = Array.isArray(cell.outputs) ? cell.outputs : [];

  if (hasVisualOutput(outputs)) return 'show';

  const lines = source.split('\n').filter((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith('#');
  });

  if (lines.length === 0) return 'setup';

  const importLines = lines.filter((line) => /^\s*(import |from .+ import )/.test(line));
  if (importLines.length / lines.length >= 0.6) return 'setup';

  const loadingPatterns = [
    '.read_csv(', '.read_sql(', '.read_excel(',
    '.read_json(', '.read_parquet(', '.read_feather(',
    '.read_pickle(', '.read_hdf(', '.read_stata(',
  ];
  if (loadingPatterns.some((pattern) => source.includes(pattern))) return 'setup';

  const profilingPatterns = [
    '.info()', '.describe()', '.head()', '.tail()',
    '.dtypes', '.columns', '.shape', '.sample(',
    '.nunique()', '.value_counts()',
  ];
  if (profilingPatterns.some((pattern) => source.includes(pattern))) {
    const outputText = outputs.map((output) => getOutputText(output)).join('\n');
    const isProfileOutput =
      (outputText.match(/\d+\/\d+/g)?.length ?? 0) >= 3 ||
      /dtype:|non-null|memory usage|RangeIndex/.test(outputText);
    if (isProfileOutput) return 'setup';
  }

  const configPatterns = [
    'warnings.filterwarnings', '%matplotlib',
    'sns.set', 'plt.style', 'pd.set_option',
    'pd.options.', 'plt.rcParams',
  ];
  const isConfigOnly = lines.every((line) =>
    configPatterns.some((pattern) => line.trim().startsWith(pattern) || line.trim().includes(pattern))
  );
  if (isConfigOnly) return 'setup';

  return 'show';
}

export function classifyCells(cells: NotebookCell[]): ClassifiedCell[] {
  return cells.map((cell, index) => ({
    cell,
    classification: classifyCell(cell),
    index,
  }));
}
