
import {
  DEFAULT_ROW_HEIGHT,
  HEADER_ROW_HEIGHT,
  INDEX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
} from './constants';
import type { SpreadsheetCell, SpreadsheetMerge, SpreadsheetSelection, SpreadsheetSheet } from './types';

export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function getCellValue(cell: SpreadsheetCell | null | undefined) {
  return cell?.value ?? '';
}

export function getCellFormula(cell: SpreadsheetCell | null | undefined) {
  return cell?.formula ?? null;
}

export function getCellNumberValue(cell: SpreadsheetCell | null | undefined) {
  if (typeof cell?.numberValue === 'number' && Number.isFinite(cell.numberValue)) {
    return cell.numberValue;
  }
  return null;
}

export function parseNumericLikeValue(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed
    .replace(/\u00A0/g, '')
    .replace(/[$\u20ac\u00a3\u00a5,]/g, '')
    .replace(/^\((.*)\)$/, '-$1')
    .replace(/%$/, '');
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function toColumnLabel(index: number) {
  let current = index;
  let label = '';
  while (current >= 0) {
    label = String.fromCharCode((current % 26) + 65) + label;
    current = Math.floor(current / 26) - 1;
  }
  return label;
}

export function createInitialColumnWidths(sheet: SpreadsheetSheet) {
  return Array.from({ length: sheet.columnCount }, (_, columnIndex) => {
    const workbookWidth = sheet.columnWidths[columnIndex];
    if (typeof workbookWidth === 'number') {
      return workbookWidth;
    }
    let maxLength = toColumnLabel((sheet.sourceStartCol ?? 0) + columnIndex).length;
    const sampleRows = Math.min(sheet.rowCount, 40);
    for (let rowIndex = 0; rowIndex < sampleRows; rowIndex += 1) {
      const value = getCellValue(sheet.rows[rowIndex]?.[columnIndex]);
      maxLength = Math.max(maxLength, value.length);
    }
    return clamp(40 + maxLength * 7.5, MIN_COLUMN_WIDTH, 280);
  });
}

export function getSelectionBounds(selection: SpreadsheetSelection) {
  return {
    top: Math.min(selection.anchorRow, selection.focusRow),
    bottom: Math.max(selection.anchorRow, selection.focusRow),
    left: Math.min(selection.anchorCol, selection.focusCol),
    right: Math.max(selection.anchorCol, selection.focusCol),
  };
}

export function buildClipboardText(sheet: SpreadsheetSheet, selection: SpreadsheetSelection) {
  const bounds = getSelectionBounds(selection);
  const lines: string[] = [];
  for (let rowIndex = bounds.top; rowIndex <= bounds.bottom; rowIndex += 1) {
    const values: string[] = [];
    for (let columnIndex = bounds.left; columnIndex <= bounds.right; columnIndex += 1) {
      values.push(getCellValue(sheet.rows[rowIndex]?.[columnIndex]));
    }
    lines.push(values.join('\t'));
  }
  return lines.join('\n');
}

export function measureSheetWidth(columnWidths: number[]) {
  return INDEX_COLUMN_WIDTH + columnWidths.reduce((total, width) => total + width, 0);
}

export function measureSheetHeight(rowHeights: number[]) {
  return HEADER_ROW_HEIGHT + rowHeights.reduce((total, height) => total + height, 0);
}

export function getColumnLeft(columnWidths: number[], columnIndex: number) {
  let left = INDEX_COLUMN_WIDTH;
  for (let index = 0; index < columnIndex; index += 1) {
    left += columnWidths[index] ?? MIN_COLUMN_WIDTH;
  }
  return left;
}

export function getRowTop(rowOffsets: number[], rowIndex: number) {
  return rowOffsets[rowIndex] ?? HEADER_ROW_HEIGHT;
}

export function getSelectionFrame(
  selection: SpreadsheetSelection,
  columnWidths: number[],
  rowOffsets: number[],
  rowHeights: number[],
  mergeByAnchor: Map<string, SpreadsheetMerge>,
) {
  const bounds = getSelectionBounds(selection);
  const merge =
    bounds.top === bounds.bottom && bounds.left === bounds.right
      ? mergeByAnchor.get(`${bounds.top}:${bounds.left}`)
      : null;
  const effectiveLeft = merge?.startCol ?? bounds.left;
  const effectiveRight = merge?.endCol ?? bounds.right;
  const effectiveTop = merge?.startRow ?? bounds.top;
  const effectiveBottom = merge?.endRow ?? bounds.bottom;
  const left = getColumnLeft(columnWidths, effectiveLeft);
  const top = getRowTop(rowOffsets, effectiveTop);
  let width = 0;
  for (let index = effectiveLeft; index <= effectiveRight; index += 1) {
    width += columnWidths[index] ?? MIN_COLUMN_WIDTH;
  }
  let height = 0;
  for (let index = effectiveTop; index <= effectiveBottom; index += 1) {
    height += rowHeights[index] ?? DEFAULT_ROW_HEIGHT;
  }
  return { left, top, width, height };
}

export function findRowIndexAtPosition(y: number, rowOffsets: number[], rowHeights: number[]) {
  if (rowOffsets.length === 0) {
    return -1;
  }
  if (y <= HEADER_ROW_HEIGHT) {
    return 0;
  }
  for (let rowIndex = 0; rowIndex < rowOffsets.length; rowIndex += 1) {
    const rowTop = rowOffsets[rowIndex];
    const rowBottom = rowTop + (rowHeights[rowIndex] ?? DEFAULT_ROW_HEIGHT);
    if (y >= rowTop && y <= rowBottom) {
      return rowIndex;
    }
  }
  return rowOffsets.length - 1;
}
