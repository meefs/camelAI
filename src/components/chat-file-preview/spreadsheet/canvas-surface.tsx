
'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Copy } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import {
  DEFAULT_ROW_HEIGHT,
  HEADER_ROW_HEIGHT,
  INDEX_COLUMN_WIDTH,
  MAX_COLUMN_WIDTH,
  MAX_SHEET_COLUMNS,
  MAX_SHEET_ROWS,
  MIN_COLUMN_WIDTH,
} from './constants';
import { SpreadsheetChartsSurface } from './chart-surface';
import { SheetTabBar } from './sheet-tab-bar';
import type {
  SpreadsheetSelection,
  SpreadsheetSurface,
  SpreadsheetToolbarState,
  SpreadsheetWorkbook,
} from './types';
import {
  buildClipboardText,
  clamp,
  createInitialColumnWidths,
  findRowIndexAtPosition,
  getCellFormula,
  getCellValue,
  getColumnLeft,
  getRowTop,
  getSelectionFrame,
  measureSheetHeight,
  measureSheetWidth,
  toColumnLabel,
} from './utils';

type ColumnResizeState = {
  columnIndex: number;
  pointerX: number;
  startWidth: number;
} | null;

type SpreadsheetPanState = {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startScrollLeft: number;
  startScrollTop: number;
} | null;

type CanvasTheme = {
  background: string;
  cellBgEven: string;
  cellBgOdd: string;
  headerBg: string;
  indexBg: string;
  cornerBg: string;
  titleRowBg: string;
  headerRowBg: string;
  text: string;
  mutedText: string;
  strongMutedText: string;
  border: string;
  subtleBorder: string;
  selectionFill: string;
  selectionStroke: string;
};

function readCanvasTheme(canvas: HTMLCanvasElement): CanvasTheme {
  const styles = getComputedStyle(canvas);
  const cssColor = (name: string, fallback: string) => {
    const value = styles.getPropertyValue(name).trim();
    return value.length > 0 ? value : fallback;
  };

  const borderColor = cssColor('--border', '#d4d4d8');

  return {
    background: cssColor('--background', '#ffffff'),
    cellBgEven: cssColor('--card', '#ffffff'),
    cellBgOdd: cssColor('--muted', '#f4f4f5'),
    headerBg: cssColor('--accent', '#f4f4f5'),
    indexBg: cssColor('--muted', '#f4f4f5'),
    cornerBg: cssColor('--secondary', '#e4e4e7'),
    titleRowBg: cssColor('--secondary', '#e4e4e7'),
    headerRowBg: cssColor('--accent', '#f4f4f5'),
    text: cssColor('--foreground', '#18181b'),
    mutedText: cssColor('--muted-foreground', '#71717a'),
    strongMutedText: cssColor('--secondary-foreground', '#3f3f46'),
    border: borderColor,
    subtleBorder: `color-mix(in oklab, ${borderColor} 55%, transparent)`,
    selectionFill: 'rgba(59, 130, 246, 0.10)',
    selectionStroke: cssColor('--ring', '#3b82f6'),
  };
}

function getRowHeaderBackground(rowKind: 'body' | 'header' | 'title', theme: CanvasTheme) {
  if (rowKind === 'title') return theme.titleRowBg;
  if (rowKind === 'header') return theme.headerRowBg;
  return theme.indexBg;
}

export function SpreadsheetCanvasSurface({
  workbook,
  layout,
  onToolbarStateChange,
}: {
  workbook: SpreadsheetWorkbook;
  layout: 'panel' | 'dialog';
  onToolbarStateChange?: (state: SpreadsheetToolbarState | null) => void;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportAnimationFrameRef = useRef<number | null>(null);
  const pendingViewportRef = useRef<{
    width: number;
    height: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);
  const [activeSheetIndex, setActiveSheetIndex] = useState(0);
  const [activeSurface, setActiveSurface] = useState<SpreadsheetSurface>('data');
  const [selection, setSelection] = useState<SpreadsheetSelection | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isSpacePressed, setIsSpacePressed] = useState(false);
  const [panState, setPanState] = useState<SpreadsheetPanState>(null);
  const [columnResize, setColumnResize] = useState<ColumnResizeState>(null);
  const [activePointerId, setActivePointerId] = useState<number | null>(null);
  const [columnWidthsBySheet, setColumnWidthsBySheet] = useState<Record<string, number[]>>(() =>
    Object.fromEntries(workbook.sheets.map((sheet) => [sheet.name, createInitialColumnWidths(sheet)])),
  );
  const [viewport, setViewport] = useState({ width: 0, height: 0, scrollLeft: 0, scrollTop: 0 });
  const [themeRevision, setThemeRevision] = useState(0);
  const [copied, setCopied] = useState(false);

  const activeSheet = workbook.sheets[activeSheetIndex] ?? workbook.sheets[0];
  const columnWidths = columnWidthsBySheet[activeSheet.name] ?? createInitialColumnWidths(activeSheet);
  const rowHeights = activeSheet.rowHeights.length === activeSheet.rowCount
    ? activeSheet.rowHeights
    : Array.from({ length: activeSheet.rowCount }, () => DEFAULT_ROW_HEIGHT);
  const rowOffsets = useMemo(() => {
    const offsets: number[] = [];
    let runningTop = HEADER_ROW_HEIGHT;
    for (let rowIndex = 0; rowIndex < rowHeights.length; rowIndex += 1) {
      offsets[rowIndex] = runningTop;
      runningTop += rowHeights[rowIndex] ?? DEFAULT_ROW_HEIGHT;
    }
    return offsets;
  }, [rowHeights]);
  const mergeByAnchor = useMemo(
    () =>
      new Map(activeSheet.merges.map((merge) => [`${merge.startRow}:${merge.startCol}`, merge])),
    [activeSheet.merges],
  );
  const mergeAnchorByCell = useMemo(() => {
    const mapping = new Map<string, { rowIndex: number; columnIndex: number }>();
    for (const merge of activeSheet.merges) {
      for (let rowIndex = merge.startRow; rowIndex <= merge.endRow; rowIndex += 1) {
        for (let columnIndex = merge.startCol; columnIndex <= merge.endCol; columnIndex += 1) {
          mapping.set(`${rowIndex}:${columnIndex}`, {
            rowIndex: merge.startRow,
            columnIndex: merge.startCol,
          });
        }
      }
    }
    return mapping;
  }, [activeSheet.merges]);
  const selectedCell =
    selection ? activeSheet.rows[selection.focusRow]?.[selection.focusCol] ?? null : null;
  const sourceStartRow = activeSheet.sourceStartRow ?? 0;
  const sourceStartCol = activeSheet.sourceStartCol ?? 0;
  const selectedLabel = selection
    ? `${toColumnLabel(sourceStartCol + selection.focusCol)}${sourceStartRow + selection.focusRow + 1}`
    : null;
  const selectionFrame = selection
    ? getSelectionFrame(selection, columnWidths, rowOffsets, rowHeights, mergeByAnchor)
    : null;
  const clippedSelectionFrame = selectionFrame
    ? {
        left: Math.max(selectionFrame.left, INDEX_COLUMN_WIDTH),
        top: Math.max(selectionFrame.top, HEADER_ROW_HEIGHT),
        width: Math.max(
          0,
          selectionFrame.width - Math.max(INDEX_COLUMN_WIDTH - selectionFrame.left, 0),
        ),
        height: Math.max(
          0,
          selectionFrame.height - Math.max(HEADER_ROW_HEIGHT - selectionFrame.top, 0),
        ),
      }
    : null;
  const totalWidth = measureSheetWidth(columnWidths);
  const totalHeight = measureSheetHeight(rowHeights);
  const hasCharts = workbook.charts.length > 0;

  useEffect(() => {
    setColumnWidthsBySheet(
      Object.fromEntries(workbook.sheets.map((sheet) => [sheet.name, createInitialColumnWidths(sheet)])),
    );
    setActiveSheetIndex(0);
    setActiveSurface('data');
    setSelection(
      workbook.sheets[0] && workbook.sheets[0].rowCount > 0 && workbook.sheets[0].columnCount > 0
        ? { anchorRow: 0, anchorCol: 0, focusRow: 0, focusCol: 0 }
        : null,
    );
  }, [workbook]);

  useEffect(() => {
    if (!activeSheet || activeSheet.rowCount === 0 || activeSheet.columnCount === 0) {
      setSelection(null);
      return;
    }
    setSelection((current) => {
      if (!current) {
        return { anchorRow: 0, anchorCol: 0, focusRow: 0, focusCol: 0 };
      }
      return {
        anchorRow: clamp(current.anchorRow, 0, activeSheet.rowCount - 1),
        anchorCol: clamp(current.anchorCol, 0, activeSheet.columnCount - 1),
        focusRow: clamp(current.focusRow, 0, activeSheet.rowCount - 1),
        focusCol: clamp(current.focusCol, 0, activeSheet.columnCount - 1),
      };
    });
  }, [activeSheet]);

  useEffect(() => {
    if (activeSurface !== 'data') return;

    const viewportNode = viewportRef.current;
    if (!viewportNode) return;

    const flushViewport = () => {
      viewportAnimationFrameRef.current = null;
      const nextViewport = pendingViewportRef.current;
      if (!nextViewport) {
        return;
      }

      pendingViewportRef.current = null;
      setViewport((current) =>
        current.width === nextViewport.width &&
        current.height === nextViewport.height &&
        current.scrollLeft === nextViewport.scrollLeft &&
        current.scrollTop === nextViewport.scrollTop
          ? current
          : nextViewport,
      );
    };

    const updateViewport = () => {
      pendingViewportRef.current = {
        width: viewportNode.clientWidth,
        height: viewportNode.clientHeight,
        scrollLeft: viewportNode.scrollLeft,
        scrollTop: viewportNode.scrollTop,
      };

      if (viewportAnimationFrameRef.current !== null) {
        return;
      }

      viewportAnimationFrameRef.current = window.requestAnimationFrame(flushViewport);
    };

    const resizeObserver = new ResizeObserver(updateViewport);
    resizeObserver.observe(viewportNode);
    viewportNode.addEventListener('scroll', updateViewport, { passive: true });
    updateViewport();

    return () => {
      if (viewportAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(viewportAnimationFrameRef.current);
        viewportAnimationFrameRef.current = null;
      }
      pendingViewportRef.current = null;
      resizeObserver.disconnect();
      viewportNode.removeEventListener('scroll', updateViewport);
    };
  }, [activeSurface]);

  useEffect(() => {
    if (!columnResize) return;

    const handlePointerMove = (event: MouseEvent) => {
      setColumnWidthsBySheet((current) => {
        const next = [...(current[activeSheet.name] ?? columnWidths)];
        next[columnResize.columnIndex] = clamp(
          columnResize.startWidth + (event.clientX - columnResize.pointerX),
          MIN_COLUMN_WIDTH,
          MAX_COLUMN_WIDTH,
        );
        return {
          ...current,
          [activeSheet.name]: next,
        };
      });
    };

    const stopResize = () => setColumnResize(null);

    document.addEventListener('mousemove', handlePointerMove);
    document.addEventListener('mouseup', stopResize);
    return () => {
      document.removeEventListener('mousemove', handlePointerMove);
      document.removeEventListener('mouseup', stopResize);
    };
  }, [activeSheet.name, columnResize, columnWidths]);

  useEffect(() => {
    if (!isDragging) return;

    const handlePointerUp = () => {
      setIsDragging(false);
      setActivePointerId(null);
    };

    document.addEventListener('pointerup', handlePointerUp);
    return () => document.removeEventListener('pointerup', handlePointerUp);
  }, [isDragging]);

  useEffect(() => {
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') {
        setIsSpacePressed(false);
      }
    };

    const handleWindowBlur = () => {
      setIsSpacePressed(false);
      setPanState(null);
    };

    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleWindowBlur);
    return () => {
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, []);

  useEffect(() => {
    const refreshTheme = () => setThemeRevision((current) => current + 1);
    const mediaQuery = window.matchMedia?.('(prefers-color-scheme: dark)');
    mediaQuery?.addEventListener?.('change', refreshTheme);

    const observer = new MutationObserver(refreshTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    });

    return () => {
      mediaQuery?.removeEventListener?.('change', refreshTheme);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !activeSheet) return;

    const width = Math.max(viewport.width, 1);
    const height = Math.max(viewport.height, 1);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(Math.floor(width * dpr), 1);
    canvas.height = Math.max(Math.floor(height * dpr), 1);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const context = canvas.getContext('2d');
    if (!context) return;
    const theme = readCanvasTheme(canvas);

    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    context.fillStyle = theme.background;
    context.fillRect(0, 0, width, height);
    context.font = '11px ui-sans-serif, system-ui, sans-serif';
    context.textBaseline = 'middle';

    const visibleLeft = viewport.scrollLeft;
    const visibleTop = viewport.scrollTop;

    const drawText = (text: string, x: number, y: number, maxWidth: number, options?: {
      align?: CanvasTextAlign;
      fillStyle?: string;
      font?: string;
      rectHeight?: number;
    }) => {
      context.save();
      context.fillStyle = options?.fillStyle ?? theme.text;
      context.textAlign = options?.align ?? 'left';
      context.font = options?.font ?? '11px ui-sans-serif, system-ui, sans-serif';
      context.beginPath();
      const rectHeight = options?.rectHeight ?? DEFAULT_ROW_HEIGHT;
      context.rect(x, y - rectHeight / 2, maxWidth, rectHeight);
      context.clip();
      const textX =
        options?.align === 'center'
          ? x + maxWidth / 2
          : options?.align === 'right'
            ? x + maxWidth - 4
            : x + 4;
      context.fillText(text, textX, y);
      context.restore();
    };

    const drawRect = (
      x: number,
      y: number,
      rectWidth: number,
      rectHeight: number,
      fillStyle: string,
      strokeStyle = theme.subtleBorder,
    ) => {
      context.fillStyle = fillStyle;
      context.fillRect(x, y, rectWidth, rectHeight);
      context.strokeStyle = strokeStyle;
      context.lineWidth = 1;
      context.strokeRect(x + 0.5, y + 0.5, rectWidth - 1, rectHeight - 1);
    };

    const firstVisibleRow = Math.max(
      0,
      findRowIndexAtPosition(visibleTop + HEADER_ROW_HEIGHT, rowOffsets, rowHeights),
    );
    const lastVisibleRow = Math.max(
      firstVisibleRow,
      Math.min(
        activeSheet.rowCount - 1,
        findRowIndexAtPosition(visibleTop + height + HEADER_ROW_HEIGHT, rowOffsets, rowHeights),
      ),
    );

    for (let rowIndex = firstVisibleRow; rowIndex <= lastVisibleRow; rowIndex += 1) {
      const drawTop = getRowTop(rowOffsets, rowIndex) - visibleTop;
      const rowHeight = rowHeights[rowIndex] ?? DEFAULT_ROW_HEIGHT;
      if (drawTop > height) break;
      const rowBackground = rowIndex % 2 === 0 ? theme.cellBgEven : theme.cellBgOdd;
      const rowKind = activeSheet.rowKinds[rowIndex] ?? 'body';

      drawRect(
        0,
        drawTop,
        INDEX_COLUMN_WIDTH,
        rowHeight,
        getRowHeaderBackground(rowKind, theme),
        theme.border,
      );
      drawText(String(sourceStartRow + rowIndex + 1), 0, drawTop + rowHeight / 2, INDEX_COLUMN_WIDTH, {
        align: 'center',
        fillStyle: rowKind === 'body' ? theme.mutedText : theme.strongMutedText,
        font: '600 11px ui-sans-serif, system-ui, sans-serif',
        rectHeight: rowHeight,
      });

      let cellLeft = INDEX_COLUMN_WIDTH;
      for (let columnIndex = 0; columnIndex < activeSheet.columnCount; columnIndex += 1) {
        const columnWidth = columnWidths[columnIndex] ?? MIN_COLUMN_WIDTH;
        const mergeAnchor = mergeAnchorByCell.get(`${rowIndex}:${columnIndex}`);
        if (mergeAnchor && (mergeAnchor.rowIndex !== rowIndex || mergeAnchor.columnIndex !== columnIndex)) {
          cellLeft += columnWidth;
          continue;
        }

        const merge = mergeByAnchor.get(`${rowIndex}:${columnIndex}`);
        let mergedWidth = columnWidth;
        let mergedHeight = rowHeight;
        if (merge) {
          mergedWidth = 0;
          for (let mergedColumnIndex = merge.startCol; mergedColumnIndex <= merge.endCol; mergedColumnIndex += 1) {
            mergedWidth += columnWidths[mergedColumnIndex] ?? MIN_COLUMN_WIDTH;
          }
          mergedHeight = 0;
          for (let mergedRowIndex = merge.startRow; mergedRowIndex <= merge.endRow; mergedRowIndex += 1) {
            mergedHeight += rowHeights[mergedRowIndex] ?? DEFAULT_ROW_HEIGHT;
          }
        }

        const drawLeft = cellLeft - visibleLeft;
        const drawRight = drawLeft + mergedWidth;

        if (drawRight >= INDEX_COLUMN_WIDTH && drawLeft <= width) {
          const cell = activeSheet.rows[rowIndex]?.[columnIndex];
          drawRect(
            drawLeft,
            drawTop,
            mergedWidth,
            mergedHeight,
            cell?.backgroundColor ?? rowBackground,
            theme.subtleBorder,
          );
          const cellValue = getCellFormula(cell) && !getCellValue(cell)
            ? `=${getCellFormula(cell)}`
            : getCellValue(cell);
          if (cellValue) {
            const isMergedTitle = rowKind === 'title' && Boolean(merge);
            drawText(
              cellValue,
              drawLeft,
              drawTop + mergedHeight / 2,
              mergedWidth,
              {
                align: cell?.textAlign ?? (rowKind === 'header' || isMergedTitle ? 'center' : 'left'),
                fillStyle: cell?.textColor ?? theme.text,
                font:
                  isMergedTitle
                    ? '700 15px ui-sans-serif, system-ui, sans-serif'
                    : rowKind === 'title' || rowKind === 'header'
                      ? '600 11px ui-sans-serif, system-ui, sans-serif'
                      : '11px ui-sans-serif, system-ui, sans-serif',
                rectHeight: mergedHeight,
              },
            );
          }
        }
        cellLeft += columnWidth;
      }
    }

    if (clippedSelectionFrame) {
      const drawLeft = clippedSelectionFrame.left - visibleLeft;
      const drawTop = clippedSelectionFrame.top - visibleTop;
      context.save();
      context.beginPath();
      context.rect(
        INDEX_COLUMN_WIDTH,
        HEADER_ROW_HEIGHT,
        Math.max(width - INDEX_COLUMN_WIDTH, 0),
        Math.max(height - HEADER_ROW_HEIGHT, 0),
      );
      context.clip();
      context.fillStyle = theme.selectionFill;
      context.strokeStyle = theme.selectionStroke;
      context.lineWidth = 1.5;
      context.fillRect(drawLeft, drawTop, clippedSelectionFrame.width, clippedSelectionFrame.height);
      context.strokeRect(
        drawLeft + 0.75,
        drawTop + 0.75,
        Math.max(clippedSelectionFrame.width - 1.5, 0),
        Math.max(clippedSelectionFrame.height - 1.5, 0),
      );
      context.restore();
    }

    drawRect(0, 0, width, HEADER_ROW_HEIGHT, theme.headerBg, theme.border);
    drawRect(0, 0, INDEX_COLUMN_WIDTH, height, theme.indexBg, theme.border);
    drawRect(0, 0, INDEX_COLUMN_WIDTH, HEADER_ROW_HEIGHT, theme.cornerBg, theme.border);

    let runningLeft = INDEX_COLUMN_WIDTH;
    for (let columnIndex = 0; columnIndex < activeSheet.columnCount; columnIndex += 1) {
      const columnWidth = columnWidths[columnIndex] ?? MIN_COLUMN_WIDTH;
      const drawLeft = runningLeft - visibleLeft;
      const drawRight = drawLeft + columnWidth;

      if (drawRight >= INDEX_COLUMN_WIDTH && drawLeft <= width) {
        drawRect(drawLeft, 0, columnWidth, HEADER_ROW_HEIGHT, theme.headerBg, theme.border);
        drawText(
          toColumnLabel(sourceStartCol + columnIndex),
          drawLeft,
          HEADER_ROW_HEIGHT / 2,
          columnWidth,
          { align: 'center', fillStyle: theme.mutedText, font: '600 11px ui-sans-serif, system-ui, sans-serif' },
        );
      }
      runningLeft += columnWidth;
    }

    for (let rowIndex = firstVisibleRow; rowIndex <= lastVisibleRow; rowIndex += 1) {
      const drawTop = getRowTop(rowOffsets, rowIndex) - visibleTop;
      const rowHeight = rowHeights[rowIndex] ?? DEFAULT_ROW_HEIGHT;
      if (drawTop > height) break;
      const rowKind = activeSheet.rowKinds[rowIndex] ?? 'body';
      drawRect(
        0,
        drawTop,
        INDEX_COLUMN_WIDTH,
        rowHeight,
        getRowHeaderBackground(rowKind, theme),
        theme.border,
      );
      drawText(String(sourceStartRow + rowIndex + 1), 0, drawTop + rowHeight / 2, INDEX_COLUMN_WIDTH, {
        align: 'center',
        fillStyle: rowKind === 'body' ? theme.mutedText : theme.strongMutedText,
        font: '600 11px ui-sans-serif, system-ui, sans-serif',
        rectHeight: rowHeight,
      });
    }
  }, [activeSheet, clippedSelectionFrame, columnWidths, mergeAnchorByCell, mergeByAnchor, rowHeights, rowOffsets, themeRevision, viewport]);

  const focusCell = (rowIndex: number, columnIndex: number, extendSelection: boolean) => {
    if (!activeSheet || activeSheet.rowCount === 0 || activeSheet.columnCount === 0) {
      return;
    }

    const nextRow = clamp(rowIndex, 0, activeSheet.rowCount - 1);
    const nextCol = clamp(columnIndex, 0, activeSheet.columnCount - 1);
    setSelection((current) => {
      if (!current || !extendSelection) {
        return {
          anchorRow: nextRow,
          anchorCol: nextCol,
          focusRow: nextRow,
          focusCol: nextCol,
        };
      }
      return {
        ...current,
        focusRow: nextRow,
        focusCol: nextCol,
      };
    });
  };

  const ensureCellVisible = (rowIndex: number, columnIndex: number) => {
    const viewportNode = viewportRef.current;
    if (!viewportNode) return;

    const cellLeft = getColumnLeft(columnWidths, columnIndex);
    const merge = mergeByAnchor.get(`${rowIndex}:${columnIndex}`);
    let cellRight = cellLeft;
    for (let mergeColumnIndex = merge?.startCol ?? columnIndex; mergeColumnIndex <= (merge?.endCol ?? columnIndex); mergeColumnIndex += 1) {
      cellRight += columnWidths[mergeColumnIndex] ?? MIN_COLUMN_WIDTH;
    }
    const cellTop = getRowTop(rowOffsets, merge?.startRow ?? rowIndex);
    let cellBottom = cellTop;
    for (let mergeRowIndex = merge?.startRow ?? rowIndex; mergeRowIndex <= (merge?.endRow ?? rowIndex); mergeRowIndex += 1) {
      cellBottom += rowHeights[mergeRowIndex] ?? DEFAULT_ROW_HEIGHT;
    }

    if (cellLeft < viewportNode.scrollLeft) {
      viewportNode.scrollLeft = Math.max(0, cellLeft - 20);
    } else if (cellRight > viewportNode.scrollLeft + viewportNode.clientWidth) {
      viewportNode.scrollLeft = Math.max(0, cellRight - viewportNode.clientWidth + 20);
    }

    if (cellTop < viewportNode.scrollTop) {
      viewportNode.scrollTop = Math.max(0, cellTop - 20);
    } else if (cellBottom > viewportNode.scrollTop + viewportNode.clientHeight) {
      viewportNode.scrollTop = Math.max(0, cellBottom - viewportNode.clientHeight + 20);
    }
  };

  const copySelection = useCallback(async () => {
    if (!selection) return;
    try {
      await navigator.clipboard.writeText(buildClipboardText(activeSheet, selection));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }, [activeSheet, selection]);

  const toolbarState = useMemo<SpreadsheetToolbarState>(
    () => ({
      canCopySelection: activeSurface === 'data' && Boolean(selection),
      copiedSelection: copied,
      copySelection,
    }),
    [activeSurface, copied, copySelection, selection],
  );

  useEffect(() => {
    if (layout !== 'dialog') return;
    onToolbarStateChange?.(toolbarState);
  }, [layout, onToolbarStateChange, toolbarState]);

  useEffect(
    () => () => {
      if (layout === 'dialog') {
        onToolbarStateChange?.(null);
      }
    },
    [layout, onToolbarStateChange],
  );

  const getGridCoordinates = (
    event:
      | ReactMouseEvent<HTMLDivElement>
      | ReactPointerEvent<HTMLDivElement>
      | MouseEvent
      | PointerEvent,
  ) => {
    const viewportNode = viewportRef.current;
    if (!viewportNode) return null;
    const rect = viewportNode.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    return { x, y };
  };

  const getHitTarget = (viewportX: number, viewportY: number) => {
    const viewportNode = viewportRef.current;
    const sheetX = viewportX + (viewportNode?.scrollLeft ?? 0);
    const sheetY = viewportY + (viewportNode?.scrollTop ?? 0);

    if (viewportX < INDEX_COLUMN_WIDTH && viewportY < HEADER_ROW_HEIGHT) {
      return { kind: 'all' } as const;
    }
    if (viewportY < HEADER_ROW_HEIGHT) {
      let runningLeft = INDEX_COLUMN_WIDTH;
      for (let columnIndex = 0; columnIndex < activeSheet.columnCount; columnIndex += 1) {
        const width = columnWidths[columnIndex] ?? MIN_COLUMN_WIDTH;
        if (sheetX >= runningLeft && sheetX <= runningLeft + width) {
          return { kind: 'column', columnIndex } as const;
        }
        runningLeft += width;
      }
      return null;
    }
    if (viewportX < INDEX_COLUMN_WIDTH) {
      const rowIndex = findRowIndexAtPosition(sheetY, rowOffsets, rowHeights);
      return rowIndex >= 0 && rowIndex < activeSheet.rowCount
        ? ({ kind: 'row', rowIndex } as const)
        : null;
    }

    const rowIndex = findRowIndexAtPosition(sheetY, rowOffsets, rowHeights);
    if (rowIndex < 0 || rowIndex >= activeSheet.rowCount) return null;

    let runningLeft = INDEX_COLUMN_WIDTH;
    for (let columnIndex = 0; columnIndex < activeSheet.columnCount; columnIndex += 1) {
      const width = columnWidths[columnIndex] ?? MIN_COLUMN_WIDTH;
      if (sheetX >= runningLeft && sheetX <= runningLeft + width) {
        const mergeAnchor = mergeAnchorByCell.get(`${rowIndex}:${columnIndex}`);
        return {
          kind: 'cell',
          rowIndex: mergeAnchor?.rowIndex ?? rowIndex,
          columnIndex: mergeAnchor?.columnIndex ?? columnIndex,
        } as const;
      }
      runningLeft += width;
    }
    return null;
  };

  const handleOverlayPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (columnResize) return;
    const viewportNode = viewportRef.current;
    const shouldPan = event.button === 1 || (event.button === 0 && isSpacePressed);
    if (shouldPan) {
      event.preventDefault();
      viewportRef.current?.focus();
      viewportRef.current?.setPointerCapture(event.pointerId);
      setActivePointerId(event.pointerId);
      setPanState({
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startScrollLeft: viewportNode?.scrollLeft ?? 0,
        startScrollTop: viewportNode?.scrollTop ?? 0,
      });
      return;
    }
    if (event.button !== 0) return;
    const coordinates = getGridCoordinates(event);
    if (!coordinates) return;

    const target = getHitTarget(coordinates.x, coordinates.y);
    if (!target) return;

    viewportRef.current?.focus();
    viewportRef.current?.setPointerCapture(event.pointerId);
    setIsDragging(true);
    setActivePointerId(event.pointerId);

    if (target.kind === 'all') {
      if (activeSheet.rowCount > 0 && activeSheet.columnCount > 0) {
        setSelection({
          anchorRow: 0,
          anchorCol: 0,
          focusRow: activeSheet.rowCount - 1,
          focusCol: activeSheet.columnCount - 1,
        });
      }
      return;
    }

    if (target.kind === 'row') {
      setSelection({
        anchorRow: target.rowIndex,
        anchorCol: 0,
        focusRow: target.rowIndex,
        focusCol: Math.max(activeSheet.columnCount - 1, 0),
      });
      return;
    }

    if (target.kind === 'column') {
      setSelection({
        anchorRow: 0,
        anchorCol: target.columnIndex,
        focusRow: Math.max(activeSheet.rowCount - 1, 0),
        focusCol: target.columnIndex,
      });
      return;
    }

    setSelection((current) => {
      if (event.shiftKey && current) {
        return {
          ...current,
          focusRow: target.rowIndex,
          focusCol: target.columnIndex,
        };
      }
      return {
        anchorRow: target.rowIndex,
        anchorCol: target.columnIndex,
        focusRow: target.rowIndex,
        focusCol: target.columnIndex,
      };
    });
  };

  const handleOverlayPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (panState) {
      if (event.pointerId !== panState.pointerId) return;
      const viewportNode = viewportRef.current;
      if (!viewportNode) return;
      viewportNode.scrollLeft = Math.max(
        0,
        panState.startScrollLeft - (event.clientX - panState.startClientX),
      );
      viewportNode.scrollTop = Math.max(
        0,
        panState.startScrollTop - (event.clientY - panState.startClientY),
      );
      return;
    }
    if (!isDragging || !selection || columnResize) return;
    if (activePointerId !== null && event.pointerId !== activePointerId) return;
    const coordinates = getGridCoordinates(event);
    if (!coordinates) return;
    const target = getHitTarget(coordinates.x, coordinates.y);
    if (!target || target.kind !== 'cell') return;
    setSelection((current) =>
      current
        ? {
            ...current,
            focusRow: target.rowIndex,
            focusCol: target.columnIndex,
          }
        : current,
    );
  };

  const handleOverlayPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (panState?.pointerId === event.pointerId) {
      viewportRef.current?.releasePointerCapture(event.pointerId);
      setActivePointerId(null);
      setPanState(null);
      return;
    }
    if (activePointerId === event.pointerId) {
      viewportRef.current?.releasePointerCapture(event.pointerId);
      setActivePointerId(null);
    }
    setIsDragging(false);
  };

  const handleOverlayContextMenu = () => {
    if (!selection) return;
    viewportRef.current?.focus();
  };

  const handleKeyDown = async (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.code === 'Space') {
      event.preventDefault();
      setIsSpacePressed(true);
      return;
    }

    if (!selection) return;

    const meta = event.metaKey || event.ctrlKey;
    if (meta && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      await copySelection();
      return;
    }

    if (meta && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      if (activeSheet.rowCount > 0 && activeSheet.columnCount > 0) {
        setSelection({
          anchorRow: 0,
          anchorCol: 0,
          focusRow: activeSheet.rowCount - 1,
          focusCol: activeSheet.columnCount - 1,
        });
      }
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      setSelection((current) =>
        current
          ? {
              anchorRow: current.focusRow,
              anchorCol: current.focusCol,
              focusRow: current.focusRow,
              focusCol: current.focusCol,
            }
          : current,
      );
      return;
    }

    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
      return;
    }

    event.preventDefault();
    let nextRow = selection.focusRow;
    let nextCol = selection.focusCol;

    switch (event.key) {
      case 'ArrowUp':
        nextRow = meta ? 0 : selection.focusRow - 1;
        break;
      case 'ArrowDown':
        nextRow = meta ? activeSheet.rowCount - 1 : selection.focusRow + 1;
        break;
      case 'ArrowLeft':
        nextCol = meta ? 0 : selection.focusCol - 1;
        break;
      case 'ArrowRight':
        nextCol = meta ? activeSheet.columnCount - 1 : selection.focusCol + 1;
        break;
      default:
        break;
    }

    focusCell(nextRow, nextCol, event.shiftKey);
    ensureCellVisible(nextRow, nextCol);
  };

  const visibleResizeHandles = useMemo(() => {
    const handles: Array<{ columnIndex: number; left: number }> = [];
    let runningLeft = INDEX_COLUMN_WIDTH;
    for (let columnIndex = 0; columnIndex < activeSheet.columnCount; columnIndex += 1) {
      const width = columnWidths[columnIndex] ?? MIN_COLUMN_WIDTH;
      const left = runningLeft + width - 3;
      const viewportLeft = left - viewport.scrollLeft;
      if (viewportLeft >= INDEX_COLUMN_WIDTH - 8 && viewportLeft <= viewport.width + 8) {
        handles.push({ columnIndex, left });
      }
      runningLeft += width;
    }
    return handles;
  }, [activeSheet.columnCount, columnWidths, viewport.scrollLeft, viewport.width]);
  const formulaBarValue = selectedCell
    ? getCellFormula(selectedCell)
      ? `=${getCellFormula(selectedCell)}`
      : getCellValue(selectedCell)
    : '';
  const formulaBarPlaceholder = selectedCell
    ? 'Empty cell'
    : 'Select a cell to inspect its content';

  const surface = (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      {hasCharts && (
        <div className="border-b border-border/70">
          <Tabs
            value={activeSurface}
            onValueChange={(value) => {
              if (value === 'data' || value === 'charts') {
                setActiveSurface(value);
              }
            }}
          >
            <TabsList variant="line" className="h-8 px-3">
              <TabsTrigger value="data">
                Data
              </TabsTrigger>
              <TabsTrigger value="charts">
                Charts
                <Badge variant="secondary" className="ml-1 h-4 px-1.5 text-[0.625rem]">
                  {workbook.charts.length}
                </Badge>
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      )}

      {activeSurface === 'data' ? (
        <>
          <div className="flex items-center gap-3 border-b border-border/70 bg-muted/40 px-3 py-2">
            <Badge variant="secondary" className="bg-accent font-mono text-muted-foreground">
              {selectedLabel ?? 'Cell'}
            </Badge>
            <div className="shrink-0 text-xs font-medium uppercase text-muted-foreground">
              fx
            </div>
            <Input
              data-testid="spreadsheet-formula-bar"
              aria-label="Formula bar"
              readOnly
              value={formulaBarValue}
              placeholder={formulaBarPlaceholder}
              className="bg-background font-mono text-xs text-foreground"
            />
            {copied && <span className="text-xs text-muted-foreground">Copied</span>}
          </div>

          <div className="relative min-h-0 flex-1 overflow-hidden bg-muted">
            <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 z-0" />
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <div
                  ref={viewportRef}
                  role="grid"
                  aria-label="Spreadsheet grid"
                  aria-rowcount={activeSheet.rowCount}
                  aria-colcount={activeSheet.columnCount}
                  data-testid="spreadsheet-viewport"
                  className={cn(
                    'relative z-10 h-full w-full overflow-auto outline-none',
                    panState ? 'cursor-grabbing' : isSpacePressed ? 'cursor-grab' : undefined,
                    layout === 'dialog' && 'max-h-[70vh]',
                  )}
                  tabIndex={0}
                  onPointerDown={handleOverlayPointerDown}
                  onPointerMove={handleOverlayPointerMove}
                  onPointerUp={handleOverlayPointerUp}
                  onPointerCancel={() => {
                    setIsDragging(false);
                    setActivePointerId(null);
                    setPanState(null);
                  }}
                  onContextMenu={handleOverlayContextMenu}
                  onKeyDown={(event) => void handleKeyDown(event)}
                >
                  <div className="relative" style={{ width: totalWidth, height: totalHeight }}>
                    <div
                      data-testid="spreadsheet-grid"
                      className={cn(
                        'pointer-events-none absolute inset-0',
                        panState ? 'cursor-grabbing' : isSpacePressed ? 'cursor-grab' : undefined,
                      )}
                    />

                    {visibleResizeHandles.map((handle) => (
                      <button
                        key={handle.columnIndex}
                        type="button"
                        aria-label={`Resize column ${toColumnLabel(handle.columnIndex)}`}
                        className="absolute top-0 z-10 w-2 -translate-x-1/2 cursor-col-resize bg-transparent hover:bg-ring/20"
                        style={{ left: handle.left, height: HEADER_ROW_HEIGHT }}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          setColumnResize({
                            columnIndex: handle.columnIndex,
                            pointerX: event.clientX,
                            startWidth: columnWidths[handle.columnIndex] ?? MIN_COLUMN_WIDTH,
                          });
                        }}
                      />
                    ))}
                  </div>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem
                  onSelect={() => {
                    void copySelection();
                  }}
                >
                  <Copy className="size-3.5" />
                  Copy
                  <ContextMenuShortcut>Cmd+C</ContextMenuShortcut>
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>

          </div>

          {activeSheet.wasTrimmed && (
            <div className="border-t border-border/70 px-3 py-2 text-xs text-muted-foreground">
              Showing the first {MAX_SHEET_ROWS} rows and {MAX_SHEET_COLUMNS} columns of this sheet.
            </div>
          )}

          {workbook.sheets.length > 1 && (
            <SheetTabBar
              sheets={workbook.sheets}
              activeIndex={activeSheetIndex}
              onActiveIndexChange={(index) => {
                setActiveSheetIndex(index);
                setCopied(false);
              }}
            />
          )}
        </>
      ) : (
        <SpreadsheetChartsSurface charts={workbook.charts} />
      )}
    </div>
  );

  return surface;
}
