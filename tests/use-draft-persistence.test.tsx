import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { useEffect } from 'react';
import type { Attachment } from '@/components/attachment-list';
import {
  draftKey,
  loadDraft,
  removeDraft,
  useDraftPersistence,
  writeDraft,
} from '@/hooks/use-draft-persistence';

function DraftSaver({
  workspaceId,
  threadId,
  text,
  attachments,
}: {
  workspaceId: string;
  threadId: string | null;
  text: string;
  attachments: Attachment[];
}) {
  const { saveDraft } = useDraftPersistence(workspaceId, threadId);

  useEffect(() => {
    saveDraft(text, attachments);
  }, [attachments, saveDraft, text]);

  return null;
}

describe('use-draft-persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('round-trips text and completed attachments', () => {
    const attachments: Attachment[] = [
      {
        id: 'complete-1',
        name: 'report.csv',
        path: '/mnt/user-uploads/report.csv',
        size: 1024,
        contentType: 'text/csv',
        originalName: 'report.csv',
        status: 'complete',
        previewUrl: 'blob:preview',
      },
      {
        id: 'uploading-1',
        name: 'draft.png',
        path: '',
        size: 2048,
        contentType: 'image/png',
        status: 'uploading',
        progress: 50,
      },
    ];

    writeDraft('ws-1', 'thread-1', 'hello world', attachments);

    expect(loadDraft('ws-1', 'thread-1')).toEqual({
      text: 'hello world',
      attachments: [
        {
          id: 'complete-1',
          name: 'report.csv',
          path: '/mnt/user-uploads/report.csv',
          size: 1024,
          contentType: 'text/csv',
          originalName: 'report.csv',
          status: 'complete',
        },
      ],
      savedAt: expect.any(Number),
    });
  });

  it('removes the stored draft when text and attachments are empty', () => {
    writeDraft('ws-1', 'thread-1', 'hello', []);
    expect(loadDraft('ws-1', 'thread-1')?.text).toBe('hello');

    writeDraft('ws-1', 'thread-1', '   ', []);
    expect(loadDraft('ws-1', 'thread-1')).toBeNull();

    removeDraft('ws-1', 'thread-1');
    expect(localStorage.getItem(draftKey('ws-1', 'thread-1'))).toBeNull();
  });

  it('evicts the oldest drafts once the limit is exceeded', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-14T00:00:00.000Z'));

    for (let index = 0; index <= 50; index += 1) {
      writeDraft('ws-1', `thread-${index}`, `draft ${index}`, []);
      vi.setSystemTime(Date.now() + 1000);
    }

    expect(localStorage.length).toBe(50);
    expect(loadDraft('ws-1', 'thread-0')).toBeNull();
    expect(loadDraft('ws-1', 'thread-1')?.text).toBe('draft 1');
    expect(loadDraft('ws-1', 'thread-50')?.text).toBe('draft 50');
  });

  it('flushes a pending debounced save during unmount', () => {
    vi.useFakeTimers();

    const { unmount } = render(
      <DraftSaver
        workspaceId="ws-1"
        threadId="thread-1"
        text="typed but not yet debounced"
        attachments={[]}
      />
    );

    expect(loadDraft('ws-1', 'thread-1')).toBeNull();

    act(() => {
      unmount();
    });

    expect(loadDraft('ws-1', 'thread-1')).toEqual({
      text: 'typed but not yet debounced',
      attachments: [],
      savedAt: expect.any(Number),
    });
  });
});
