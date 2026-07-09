import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GroupNewChatAttachmentCard } from '@/types';
import { RecentAttachmentCard } from '@/components/welcome-screen/attachment-card';
import {
  AttachmentHoverPreview,
  getAttachmentHoverKind,
  shapeDelimitedPreview,
  type AttachmentHoverPreviewProps,
} from '@/components/chat-file-preview/attachment-hover-preview';

const NOW = new Date('2026-07-08T12:00:00Z').getTime();

function makeCard(
  overrides: Partial<GroupNewChatAttachmentCard> = {},
): GroupNewChatAttachmentCard {
  return {
    path: 'uploads/stored-file',
    filename: 'stored-file',
    originalName: 'stored-file.txt',
    sourceThreadId: 'thread_1',
    sourceTitle: 'Churn dashboard',
    lastUsedAt: NOW - 3 * 24 * 60 * 60 * 1000,
    ...overrides,
  };
}

function renderHoverPreview(overrides: Partial<AttachmentHoverPreviewProps> = {}) {
  return render(
    <AttachmentHoverPreview
      displayName="stored-file.txt"
      filename="stored-file.txt"
      kind="metadata"
      imageUrl={null}
      state={{ status: 'idle' }}
      {...overrides}
    />,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('getAttachmentHoverKind', () => {
  it.each([
    ['photo.png', undefined, 'image'],
    ['logo.svg', undefined, 'image'],
    ['pic.heic', undefined, 'metadata'],
    ['data.csv', undefined, 'table'],
    ['data.xlsx', undefined, 'metadata'],
    ['README.md', undefined, 'markdown'],
    ['main.py', undefined, 'text'],
    ['page.html', undefined, 'text'],
    ['events.jsonl', undefined, 'text'],
    ['report.pdf', undefined, 'metadata'],
    ['run.ipynb', undefined, 'metadata'],
    ['demo.mp4', undefined, 'metadata'],
    ['bundle.zip', undefined, 'metadata'],
    ['blob', 'text/csv', 'table'],
  ] as const)('maps %s (%s) to %s', (filename, contentType, expected) => {
    expect(getAttachmentHoverKind(filename, contentType)).toBe(expected);
  });
});

describe('shapeDelimitedPreview', () => {
  it('caps delimited previews at 8 data rows and 6 columns', () => {
    const header = Array.from({ length: 8 }, (_, index) => `h${index + 1}`).join(',');
    const rows = Array.from({ length: 10 }, (_, rowIndex) =>
      Array.from({ length: 8 }, (_, columnIndex) => `r${rowIndex + 1}c${columnIndex + 1}`).join(','),
    );

    const shape = shapeDelimitedPreview([header, ...rows].join('\n'), false, 'data.csv');

    expect(shape.header).toHaveLength(8);
    expect(shape.body).toHaveLength(8);
    expect(shape.totalRows).toBe(10);
    expect(shape.totalCols).toBe(8);
    expect(shape.cols).toBe(6);
  });

  it('drops the final fetched row when the text preview was truncated', () => {
    const shape = shapeDelimitedPreview(
      'email,plan\nada@example.com,pro\nlin@example.com,starter\npartial',
      true,
      'data.csv',
    );

    expect(shape.body).toEqual([
      ['ada@example.com', 'pro'],
      ['lin@example.com', 'starter'],
    ]);
    expect(shape.totalRows).toBe(2);
  });

  it('returns an empty shape for empty text', () => {
    expect(shapeDelimitedPreview('', false, 'data.csv')).toEqual({
      header: [],
      body: [],
      totalRows: 0,
      totalCols: 0,
      cols: 0,
    });
  });
});

describe('AttachmentHoverPreview', () => {
  it('renders ready text content with a truncation footnote', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    renderHoverPreview({
      displayName: 'main.py',
      filename: 'main.py',
      size: 1024,
      kind: 'text',
      state: { status: 'ready', text: 'print("hello")\nprint("again")', truncated: true },
    });

    expect(screen.getByText('main.py')).toBeInTheDocument();
    expect(screen.getByText('PY · 1.0 KB')).toBeInTheDocument();
    expect(
      screen.getByText((_, element) =>
        element?.tagName === 'PRE' &&
        element.textContent?.includes('print("hello")\nprint("again")') === true,
      ),
    ).toHaveClass('font-mono');
    expect(screen.getByText('Preview truncated')).toBeInTheDocument();
  });

  it('caps rendered text content before wrapping long single-line files', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    renderHoverPreview({
      displayName: 'events.json',
      filename: 'events.json',
      kind: 'text',
      state: { status: 'ready', text: 'x'.repeat(4_100), truncated: false },
    });

    const pre = screen.getByText((_, element) => element?.tagName === 'PRE');
    expect(pre.textContent).toHaveLength(4_000);
    expect(pre.textContent).toBe('x'.repeat(4_000));
    expect(pre).toHaveClass('whitespace-pre-wrap', 'break-words');
    expect(screen.getByText('Preview truncated')).toBeInTheDocument();
  });

  it('caps rendered markdown content and shows a truncation footnote', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const { container } = renderHoverPreview({
      displayName: 'README.md',
      filename: 'README.md',
      kind: 'markdown',
      state: { status: 'ready', text: 'x'.repeat(4_100), truncated: false },
    });

    const markdownContent = container.querySelector('.markdown-content');
    expect(markdownContent?.textContent).toHaveLength(4_000);
    expect(markdownContent?.textContent).toBe('x'.repeat(4_000));
    expect(screen.getByText('Preview truncated')).toBeInTheDocument();
  });

  it('renders ready table content with clipped rows and columns', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const header = 'email,plan,seats,mrr,owner,status,notes';
    const rows = Array.from({ length: 9 }, (_, index) =>
      `user${index}@example.com,pro,4,$96,Ada,active,note`,
    );

    renderHoverPreview({
      displayName: 'users.csv',
      filename: 'users.csv',
      kind: 'table',
      state: { status: 'ready', text: [header, ...rows].join('\n'), truncated: false },
    });

    expect(screen.getByRole('columnheader', { name: 'email' })).toBeInTheDocument();
    expect(screen.getByText('user0@example.com')).toBeInTheDocument();
    expect(screen.getByText(/First 8 rows/)).toBeInTheDocument();
    expect(screen.getByText(/1 more columns/)).toBeInTheDocument();
  });

  it('omits the table footnote for exactly 8 unclipped data rows', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const header = 'email,plan';
    const rows = Array.from({ length: 8 }, (_, index) =>
      `user${index}@example.com,pro`,
    );

    renderHoverPreview({
      displayName: 'users.csv',
      filename: 'users.csv',
      kind: 'table',
      state: { status: 'ready', text: [header, ...rows].join('\n'), truncated: false },
    });

    expect(screen.getByText('user7@example.com')).toBeInTheDocument();
    expect(screen.queryByText(/First 8 rows/)).not.toBeInTheDocument();
  });

  it('renders metadata without fabricated body text', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const { container } = renderHoverPreview({
      displayName: 'report.pdf',
      filename: 'report.pdf',
      kind: 'metadata',
      state: { status: 'idle' },
    });

    expect(screen.getByText('report.pdf')).toBeInTheDocument();
    expect(screen.getByText('PDF')).toBeInTheDocument();
    expect(container.firstElementChild?.children).toHaveLength(1);
    expect(screen.queryByText(/No preview/)).not.toBeInTheDocument();
    expect(screen.queryByText('Empty file.')).not.toBeInTheDocument();
    expect(container.querySelector('svg')).not.toBeInTheDocument();
  });

  it('renders error messages in the metadata frame', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    renderHoverPreview({
      displayName: 'missing.csv',
      filename: 'missing.csv',
      kind: 'table',
      state: { status: 'error', message: 'This file is no longer available.' },
    });

    expect(screen.getByText('This file is no longer available.')).toBeInTheDocument();
  });

  it('renders the source chat and relative time in the footer', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    renderHoverPreview({
      displayName: 'long-original-report-name-that-wraps.txt',
      filename: 'long-original-report-name-that-wraps.txt',
      kind: 'metadata',
      state: { status: 'idle' },
      footer: <>From &ldquo;Churn dashboard&rdquo; · 3 days ago</>,
    });

    expect(screen.getByText('long-original-report-name-that-wraps.txt')).toBeInTheDocument();
    expect(
      screen.getByText((_, element) =>
        element?.tagName === 'SPAN' &&
        element?.textContent?.includes('From \u201cChurn dashboard\u201d') === true &&
        element.textContent.includes('3 days ago'),
      ),
    ).toBeInTheDocument();
  });
});

describe('RecentAttachmentCard', () => {
  it('renders image attachments as thumbnail buttons and falls back after image errors', () => {
    const onSelect = vi.fn();

    const card = makeCard({
      path: 'uploads/stored photo.png',
      filename: 'stored photo.png',
      originalName: 'photo.png',
      contentType: 'image/png',
    });

    render(
      <RecentAttachmentCard
        card={card}
        workspaceId="workspace_1"
        onSelect={onSelect}
      />,
    );

    const imageButton = screen.getByRole('button', { name: 'Add photo.png to chat' });
    const image = imageButton.querySelector('img');
    expect(image).not.toBeNull();
    expect(image?.getAttribute('src')).toContain('/api/workspaces/workspace_1/uploads/');
    expect(image?.getAttribute('src')).toContain('stored%20photo.png');

    fireEvent.error(image as HTMLImageElement);

    expect(screen.queryByRole('button', { name: 'Add photo.png to chat' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'photo.png' })).toBeInTheDocument();
  });
});
