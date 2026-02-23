import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NotebookTable } from '@/components/chat-file-preview/notebook-preview/notebook-table';
import type { ParsedTable } from '@/components/chat-file-preview/notebook-preview/types';

class ResizeObserverMock {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  }
});

describe('NotebookTable', () => {
  it('truncates rendered rows at 100 and shows truncation caption for larger tables', () => {
    const table: ParsedTable = {
      headers: ['Row', 'Value'],
      rows: Array.from({ length: 150 }, (_, index) => [
        `${index + 1}`,
        `Value ${index + 1}`,
      ]),
      indexColumns: 1,
      caption: '150 rows × 1 column',
      sourceRowCount: null,
    };

    const { container } = render(<NotebookTable table={table} mode="report" />);

    expect(screen.getByText('Showing 100 of 150 rows × 1 column')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /download all 150 rows as csv/i })).toBeInTheDocument();

    expect(screen.getByText('Value 1')).toBeInTheDocument();
    expect(screen.getByText('Value 100')).toBeInTheDocument();
    expect(screen.queryByText('Value 101')).not.toBeInTheDocument();
    expect(screen.queryByText('Value 150')).not.toBeInTheDocument();

    const renderedRows = container.querySelectorAll('tbody tr');
    expect(renderedRows).toHaveLength(100);
  });

  it('handles large tables without spread-based argument overflow', () => {
    const rowCount = 140000;
    const table: ParsedTable = {
      headers: ['Value'],
      rows: Array.from({ length: rowCount }, (_, index) => [`${index}`]),
      indexColumns: 0,
      caption: `${rowCount} rows × 1 column`,
      sourceRowCount: null,
    };

    expect(() => {
      render(<NotebookTable table={table} mode="report" />);
    }).not.toThrow();

    expect(
      screen.getByText(`Showing 100 of ${rowCount.toLocaleString()} rows × 1 column`)
    ).toBeInTheDocument();
  });

  it('renders an expand button when onExpand is provided', () => {
    const table: ParsedTable = {
      headers: ['Name', 'Value'],
      rows: [['Row 1', '10']],
      indexColumns: 0,
      caption: '1 row × 2 columns',
      sourceRowCount: null,
    };
    const onExpand = vi.fn();

    render(<NotebookTable table={table} mode="report" onExpand={onExpand} />);

    const expandButton = screen.getByRole('button', { name: /expand/i });
    fireEvent.click(expandButton);
    expect(onExpand).toHaveBeenCalledTimes(1);
  });
});
