import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { useEffect } from 'react';
import type { Attachment } from '@/components/attachment-list';
import {
  deliveryDraftKey,
  draftKey,
  loadDeliveryDraft,
  loadDraft,
  markDeliveryDraftAccepted,
  removeDeliveryDraft,
  removeDraft,
  useDraftPersistence,
  writeDeliveryDraft,
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

function DraftSaveThenClear({
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
  const { saveDraft, clearDraft } = useDraftPersistence(workspaceId, threadId);

  useEffect(() => {
    saveDraft(text, attachments);
    clearDraft();
  }, [attachments, clearDraft, saveDraft, text]);

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
        path: 'uploads/report.csv',
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
          path: 'uploads/report.csv',
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

  it('returns null instead of throwing when localStorage writes fail', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });

    expect(writeDraft('ws-1', null, 'hello world', [])).toBeNull();
    expect(loadDraft('ws-1', null)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      'Failed to persist draft',
      expect.any(DOMException)
    );

    setItemSpy.mockRestore();
    warnSpy.mockRestore();
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

  it('clearDraft cancels a pending debounced save so unmount does not restore it', () => {
    const { unmount } = render(
      <DraftSaveThenClear
        workspaceId="ws-1"
        threadId={null}
        text="submitted prompt"
        attachments={[]}
      />,
    );

    expect(loadDraft('ws-1', null)).toBeNull();

    act(() => {
      unmount();
    });

    expect(loadDraft('ws-1', null)).toBeNull();
  });

  it('keeps delivery backups separate from normal drafts', () => {
    writeDeliveryDraft('ws-1', 'thread-1', 'client-1', 'in flight', [], null);

    expect(loadDraft('ws-1', 'thread-1')).toBeNull();
    expect(loadDeliveryDraft('ws-1', 'thread-1')).toMatchObject({
      text: 'in flight',
      clientMessageId: 'client-1',
      acceptedAt: null,
    });

    const accepted = markDeliveryDraftAccepted('ws-1', 'thread-1', 'client-1');
    expect(accepted).toMatchObject({
      text: 'in flight',
      clientMessageId: 'client-1',
      acceptedAt: expect.any(Number),
    });

    removeDeliveryDraft('ws-1', 'thread-1');
    expect(localStorage.getItem(deliveryDraftKey('ws-1', 'thread-1'))).toBeNull();
  });
});
