import { StyleSheet, Text, View } from '@react-pdf/renderer';
import type { Style } from '@react-pdf/types';
import { getTableDisplayModel, isNumericValue, truncateCell, type TableDisplayModel } from './table-display';
import type { ParsedTable } from './types';

interface PdfTableProps {
  table: ParsedTable;
  display?: TableDisplayModel;
}

const COLUMN_SAMPLE_ROWS = 8;

const styles = StyleSheet.create({
  root: {
    gap: 8,
  },
  chunk: {
    gap: 6,
  },
  table: {
    borderWidth: 1,
    borderColor: '#d7dde7',
    borderRadius: 6,
    overflow: 'hidden',
  },
  headerRow: {
    flexDirection: 'row',
    backgroundColor: '#eef2f7',
    borderBottomWidth: 1,
    borderBottomColor: '#d7dde7',
  },
  row: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#e7ebf0',
    minHeight: 24,
  },
  stripedRow: {
    backgroundColor: '#f8fafc',
  },
  cellBase: {
    flexGrow: 1,
    flexBasis: 0,
    paddingHorizontal: 6,
    paddingVertical: 5,
    borderRightWidth: 1,
    borderRightColor: '#e7ebf0',
  },
  lastCell: {
    borderRightWidth: 0,
  },
  headerCellText: {
    fontFamily: 'Figtree',
    fontWeight: 700,
    fontSize: 9.5,
    color: '#475569',
  },
  cellText: {
    fontFamily: 'Figtree',
    fontSize: 9,
    color: '#1f2937',
  },
  indexCellText: {
    color: '#64748b',
  },
  numericCellText: {
    fontFamily: 'Geist Mono',
    textAlign: 'right',
  },
  metadata: {
    gap: 2,
  },
  caption: {
    fontFamily: 'Figtree',
    fontSize: 8.5,
    color: '#475569',
  },
  note: {
    fontFamily: 'Figtree',
    fontSize: 8,
    color: '#64748b',
  },
});

function getRowsPerChunk(columnCount: number): number {
  if (columnCount >= 8) return 12;
  if (columnCount >= 6) return 16;
  if (columnCount >= 4) return 20;
  return 24;
}

function chunkRows(rows: string[][], size: number): string[][][] {
  if (rows.length === 0) return [[]];

  const chunks: string[][][] = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getColumnFlexWeights(table: ParsedTable, model: TableDisplayModel): number[] {
  const sampleRows = model.displayRows.slice(0, COLUMN_SAMPLE_ROWS);

  return Array.from({ length: model.columnCount }, (_, columnIndex) => {
    const header = truncateCell(table.headers[columnIndex] ?? '');
    let longestLength = header.trim().length;
    let nonEmptyCount = header.trim() ? 1 : 0;
    let numericCount = 0;

    for (const row of sampleRows) {
      const rawValue = row[columnIndex] ?? '';
      const value = truncateCell(rawValue).trim();
      if (!value) continue;

      longestLength = Math.max(longestLength, value.length);
      nonEmptyCount += 1;
      if (isNumericValue(rawValue)) {
        numericCount += 1;
      }
    }

    const isIndexColumn = columnIndex < table.indexColumns;
    const isMostlyNumeric =
      !isIndexColumn &&
      nonEmptyCount > 0 &&
      numericCount >= Math.max(1, Math.floor(nonEmptyCount / 2));
    const minWeight = isIndexColumn ? 4 : isMostlyNumeric ? 5 : 6;
    const maxWeight = isIndexColumn ? 10 : isMostlyNumeric ? 12 : 18;
    const scaledLength = isMostlyNumeric ? longestLength * 0.8 : longestLength;

    return clamp(scaledLength || minWeight, minWeight, maxWeight);
  });
}

export function PdfTable({ table, display }: PdfTableProps) {
  const model = display ?? getTableDisplayModel(table);
  const rowChunks = chunkRows(model.displayRows, getRowsPerChunk(model.columnCount));
  const columnFlexWeights = getColumnFlexWeights(table, model);

  return (
    <View style={styles.root}>
      {rowChunks.map((rows, chunkIndex) => (
        <View key={`chunk-${chunkIndex}`} style={styles.chunk} wrap={false}>
          <View style={styles.table}>
            {table.headers.length > 0 ? (
              <View style={styles.headerRow}>
                {Array.from({ length: model.columnCount }, (_, columnIndex) => {
                  const isLastCell = columnIndex === model.columnCount - 1;
                  const cellStyles = isLastCell
                    ? [styles.cellBase, { flexGrow: columnFlexWeights[columnIndex] }, styles.lastCell]
                    : [styles.cellBase, { flexGrow: columnFlexWeights[columnIndex] }];
                  return (
                    <View
                      key={`header-${chunkIndex}-${columnIndex}`}
                      style={cellStyles}
                    >
                      <Text style={styles.headerCellText}>
                        {table.headers[columnIndex] ?? ''}
                      </Text>
                    </View>
                  );
                })}
              </View>
            ) : null}

            {rows.map((row, rowIndex) => {
              const absoluteIndex = chunkIndex * getRowsPerChunk(model.columnCount) + rowIndex;
              return (
                <View
                  key={`row-${chunkIndex}-${rowIndex}`}
                  style={absoluteIndex % 2 === 1 ? [styles.row, styles.stripedRow] : [styles.row]}
                >
                  {Array.from({ length: model.columnCount }, (_, columnIndex) => {
                    const rawValue = row[columnIndex] ?? '';
                    const isIndexColumn = columnIndex < table.indexColumns;
                    const isLastCell = columnIndex === model.columnCount - 1;
                    const value = truncateCell(rawValue);
                    const cellStyles = isLastCell
                      ? [styles.cellBase, { flexGrow: columnFlexWeights[columnIndex] }, styles.lastCell]
                      : [styles.cellBase, { flexGrow: columnFlexWeights[columnIndex] }];
                    const textStyles: Style[] = [styles.cellText];
                    if (isIndexColumn) {
                      textStyles.push(styles.indexCellText);
                    }
                    if (!isIndexColumn && isNumericValue(rawValue)) {
                      textStyles.push(styles.numericCellText);
                    }

                    return (
                      <View
                        key={`cell-${chunkIndex}-${rowIndex}-${columnIndex}`}
                        style={cellStyles}
                      >
                        <Text style={textStyles}>
                          {value}
                        </Text>
                      </View>
                    );
                  })}
                </View>
              );
            })}
          </View>

          {chunkIndex === rowChunks.length - 1 ? (
            <View style={styles.metadata}>
              <Text style={styles.caption}>{model.captionText}</Text>
              {model.truncationNote ? (
                <Text style={styles.note}>{model.truncationNote}</Text>
              ) : null}
            </View>
          ) : null}
        </View>
      ))}
    </View>
  );
}
