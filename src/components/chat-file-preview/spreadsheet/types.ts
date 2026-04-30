
export type SpreadsheetSelection = {
  anchorRow: number;
  anchorCol: number;
  focusRow: number;
  focusCol: number;
};

export type SpreadsheetCell = {
  value: string | null;
  formula?: string | null;
  numberValue?: number | null;
  backgroundColor?: string | null;
  textColor?: string | null;
  textAlign?: CanvasTextAlign | null;
};

export type SpreadsheetMerge = {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
};

export type SpreadsheetSheet = {
  name: string;
  rows: SpreadsheetCell[][];
  rowCount: number;
  columnCount: number;
  sourceStartRow?: number;
  sourceStartCol?: number;
  rowHeights: number[];
  columnWidths: Array<number | undefined>;
  merges: SpreadsheetMerge[];
  rowKinds: Array<'body' | 'header' | 'title'>;
  isFirstRowHeader: boolean;
  wasTrimmed: boolean;
};

export type SpreadsheetChartSeries = {
  name: string;
  values: Array<number | null>;
  color: string;
};

export type SpreadsheetChart = {
  id: string;
  kind: 'bar' | 'line' | 'pie' | 'doughnut';
  title: string;
  sheetName: string;
  categoryLabel: string;
  categories: string[];
  series: SpreadsheetChartSeries[];
  source: 'embedded';
};

export type SpreadsheetWorkbook = {
  sheets: SpreadsheetSheet[];
  charts: SpreadsheetChart[];
  kind: 'excel' | 'delimited';
};

export interface SpreadsheetPreviewProps {
  content: string | ArrayBuffer;
  filename: string;
  contentType?: string;
  layout: 'panel' | 'dialog';
  onToolbarStateChange?: (state: SpreadsheetToolbarState | null) => void;
}

export type SpreadsheetToolbarState = {
  canCopySelection: boolean;
  copiedSelection: boolean;
  copySelection: () => void | Promise<void>;
};

export type SpreadsheetSurface = 'data' | 'charts';

export type WorkbookFileEntry = {
  content?: unknown;
};

export type ChartHoverState = {
  key: string;
  category: string;
  seriesName: string;
  value: number;
  left: number;
  top: number;
  color: string;
};
