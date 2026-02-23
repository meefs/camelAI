export interface NotebookCellMetadata {
  execution?: {
    'iopub.execute_input'?: string;
    'shell.execute_reply'?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface NotebookOutput {
  output_type?: string;
  name?: string;
  text?: string | string[];
  traceback?: string[];
  ename?: string;
  evalue?: string;
  data?: Record<string, unknown>;
}

export interface NotebookCell {
  cell_type?: string;
  source?: string | string[];
  outputs?: NotebookOutput[];
  execution_count?: number | null;
  metadata?: NotebookCellMetadata;
}

export interface NotebookKernelspec {
  display_name?: string;
  language?: string;
  name?: string;
}

export interface NotebookLanguageInfo {
  name?: string;
  version?: string;
  [key: string]: unknown;
}

export interface NotebookFile {
  nbformat?: number;
  nbformat_minor?: number;
  metadata?: {
    kernelspec?: NotebookKernelspec;
    language_info?: NotebookLanguageInfo;
    [key: string]: unknown;
  };
  cells?: NotebookCell[];
}

export type CellClassification = 'show' | 'setup';

export interface ClassifiedCell {
  cell: NotebookCell;
  classification: CellClassification;
  index: number;
}

export interface TocEntry {
  id: string;
  text: string;
  level: 2 | 3;
  cellIndex: number;
}

export interface NotebookHeader {
  title: string | null;
  subtitle: string | null;
  executionTimestamp: Date | null;
  cellCount: number;
  visualizationCount: number;
  titleCellIndex: number | null;
}

export interface ParsedTable {
  headers: string[];
  rows: string[][];
  indexColumns: number;
  caption: string | null;
  /** Total row count reported by pandas (from the trailing dimension `<p>` tag). */
  sourceRowCount: number | null;
}

export type NotebookOutputRender =
  | { kind: 'vegalite'; spec: Record<string, unknown> }
  | { kind: 'plotly'; payload: Record<string, unknown> }
  | { kind: 'table'; table: ParsedTable }
  | { kind: 'html'; html: string }
  | { kind: 'image'; src: string }
  | { kind: 'text'; text: string }
  | { kind: 'unsupported' };
