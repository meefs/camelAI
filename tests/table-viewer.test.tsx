import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TableViewer } from '@/components/chat-file-preview/notebook-preview/table-viewer';
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

describe('TableViewer', () => {
  it('caps rendered rows at 500', () => {
    const table: ParsedTable = {
      headers: ['Index', 'Value'],
      rows: Array.from({ length: 650 }, (_, index) => [
        String(index),
        `Value ${index}`,
      ]),
      indexColumns: 1,
      caption: null,
      sourceRowCount: null,
    };

    const { container } = render(<TableViewer table={table} title="Dataset" />);

    expect(screen.getByText('Showing 500 of 650 rows x 1 column')).toBeInTheDocument();
    expect(container.querySelectorAll('tbody tr')).toHaveLength(500);
  });

  it('sorts data columns asc/desc and resets to original order', () => {
    const table: ParsedTable = {
      headers: ['Index', 'Name'],
      rows: [
        ['0', 'Bravo'],
        ['1', 'Alpha'],
        ['2', 'Charlie'],
      ],
      indexColumns: 1,
      caption: null,
      sourceRowCount: null,
    };

    const { container } = render(<TableViewer table={table} title="Names" />);
    const sortButton = screen.getByRole('button', { name: /name/i });

    fireEvent.click(sortButton);
    let renderedRows = container.querySelectorAll('tbody tr');
    expect(renderedRows[0]).toHaveTextContent('Alpha');

    fireEvent.click(sortButton);
    renderedRows = container.querySelectorAll('tbody tr');
    expect(renderedRows[0]).toHaveTextContent('Charlie');

    fireEvent.click(sortButton);
    renderedRows = container.querySelectorAll('tbody tr');
    expect(renderedRows[0]).toHaveTextContent('Bravo');
  });

  it('ignores pandas ellipsis placeholders when detecting numeric columns', () => {
    const table: ParsedTable = {
      headers: ['Index', 'Value'],
      rows: [
        ['0', '100'],
        ['1', '2'],
        ['...', '...'],
        ['2', '50'],
      ],
      indexColumns: 1,
      caption: null,
      sourceRowCount: 1000,
    };

    const { container } = render(<TableViewer table={table} title="Numeric values" />);
    const sortButton = screen.getByRole('button', { name: /value/i });

    fireEvent.click(sortButton);

    const sortedValues = Array.from(container.querySelectorAll('tbody tr')).map((row) =>
      row.querySelector('td')?.textContent ?? ''
    );
    expect(sortedValues).toEqual(['2', '50', '100', '...']);
  });

  it('ignores rows beyond the render cap when estimating initial column widths', async () => {
    const rows: string[][] = Array.from({ length: 501 }, (_, index) => [
      String(index),
      index === 500 ? 'x'.repeat(200) : 'x',
    ]);
    const table: ParsedTable = {
      headers: ['Index', 'Value'],
      rows,
      indexColumns: 1,
      caption: null,
      sourceRowCount: null,
    };

    const { container } = render(<TableViewer table={table} title="Width sample" />);
    const dataColumn = container.querySelectorAll('col')[1];
    expect(dataColumn).toBeTruthy();

    await waitFor(() => {
      expect(dataColumn?.style.width).toBe('90px');
    });
  });
});
