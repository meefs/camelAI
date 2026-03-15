'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { Attachment } from '@/components/attachment-list';

const DRAFT_PREFIX = 'draft:';
const MAX_DRAFTS = 50;

export interface SerializedAttachment {
  id: string;
  name: string;
  path: string;
  size: number;
  contentType?: string;
  originalName?: string;
  status: 'complete';
}

export interface DraftData {
  text: string;
  attachments: SerializedAttachment[];
  savedAt: number;
}

function getStorage(): Storage | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function draftKey(workspaceId: string, threadId: string | null): string {
  return `${DRAFT_PREFIX}${workspaceId}:${threadId ?? 'new'}`;
}

export function serializeAttachments(attachments: Attachment[]): SerializedAttachment[] {
  return attachments
    .filter((attachment) => attachment.status === 'complete')
    .map(({ id, name, path, size, contentType, originalName }) => ({
      id,
      name,
      path,
      size,
      contentType,
      originalName,
      status: 'complete',
    }));
}

export function hasPersistableDraft(text: string, attachments: Attachment[]): boolean {
  return text.trim().length > 0 || serializeAttachments(attachments).length > 0;
}

function parseSerializedAttachment(value: unknown): SerializedAttachment | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== 'string' ||
    typeof record.name !== 'string' ||
    typeof record.path !== 'string' ||
    typeof record.size !== 'number' ||
    !Number.isFinite(record.size)
  ) {
    return null;
  }

  return {
    id: record.id,
    name: record.name,
    path: record.path,
    size: record.size,
    contentType: typeof record.contentType === 'string' ? record.contentType : undefined,
    originalName: typeof record.originalName === 'string' ? record.originalName : undefined,
    status: 'complete',
  };
}

function parseDraft(raw: string): DraftData | null {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const text = typeof parsed.text === 'string' ? parsed.text : '';
  const attachments = Array.isArray(parsed.attachments)
    ? parsed.attachments
        .map(parseSerializedAttachment)
        .filter((attachment): attachment is SerializedAttachment => attachment !== null)
    : [];
  const savedAt = typeof parsed.savedAt === 'number' && Number.isFinite(parsed.savedAt)
    ? parsed.savedAt
    : 0;

  if (!text.trim() && attachments.length === 0) {
    return null;
  }

  return { text, attachments, savedAt };
}

function evictOldDrafts(storage: Storage, maxDrafts: number) {
  const drafts: Array<{ key: string; savedAt: number }> = [];

  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(DRAFT_PREFIX)) {
      continue;
    }

    const raw = storage.getItem(key);
    if (!raw) {
      continue;
    }

    try {
      const draft = parseDraft(raw);
      if (!draft) {
        storage.removeItem(key);
        continue;
      }
      drafts.push({ key, savedAt: draft.savedAt });
    } catch {
      storage.removeItem(key);
    }
  }

  if (drafts.length <= maxDrafts) {
    return;
  }

  drafts.sort((left, right) => left.savedAt - right.savedAt);
  for (const draft of drafts.slice(0, drafts.length - maxDrafts)) {
    storage.removeItem(draft.key);
  }
}

export function loadDraft(
  workspaceId: string | null | undefined,
  threadId: string | null
): DraftData | null {
  const storage = getStorage();
  if (!storage || !workspaceId) {
    return null;
  }

  const key = draftKey(workspaceId, threadId);

  try {
    const raw = storage.getItem(key);
    if (!raw) {
      return null;
    }

    const draft = parseDraft(raw);
    if (!draft) {
      storage.removeItem(key);
      return null;
    }

    return draft;
  } catch {
    storage.removeItem(key);
    return null;
  }
}

export function writeDraft(
  workspaceId: string | null | undefined,
  threadId: string | null,
  text: string,
  attachments: Attachment[]
): DraftData | null {
  const storage = getStorage();
  if (!storage || !workspaceId) {
    return null;
  }

  const key = draftKey(workspaceId, threadId);
  const serializedAttachments = serializeAttachments(attachments);
  if (!text.trim() && serializedAttachments.length === 0) {
    storage.removeItem(key);
    return null;
  }

  const draft: DraftData = {
    text,
    attachments: serializedAttachments,
    savedAt: Date.now(),
  };

  try {
    storage.setItem(key, JSON.stringify(draft));
    evictOldDrafts(storage, MAX_DRAFTS);
    return draft;
  } catch (error) {
    console.warn('Failed to persist draft', error);
    return null;
  }
}

export function removeDraft(workspaceId: string | null | undefined, threadId: string | null) {
  const storage = getStorage();
  if (!storage || !workspaceId) {
    return;
  }

  storage.removeItem(draftKey(workspaceId, threadId));
}

export function useDraftPersistence(workspaceId: string | undefined, threadId: string | null) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestRef = useRef<{ text: string; attachments: Attachment[] } | null>(null);

  const saveDraft = useCallback((text: string, attachments: Attachment[]) => {
    if (!workspaceId) {
      return;
    }

    latestRef.current = { text, attachments };

    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    timerRef.current = setTimeout(() => {
      writeDraft(workspaceId, threadId, text, attachments);
      timerRef.current = null;
    }, 500);
  }, [threadId, workspaceId]);

  const flushDraft = useCallback((text: string, attachments: Attachment[]) => {
    if (!workspaceId) {
      return null;
    }

    latestRef.current = { text, attachments };

    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    return writeDraft(workspaceId, threadId, text, attachments);
  }, [threadId, workspaceId]);

  const clearDraft = useCallback(() => {
    if (!workspaceId) {
      return;
    }

    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    latestRef.current = null;
    removeDraft(workspaceId, threadId);
  }, [threadId, workspaceId]);

  useEffect(() => {
    return () => {
      if (!workspaceId || !latestRef.current) {
        return;
      }

      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
        writeDraft(
          workspaceId,
          threadId,
          latestRef.current.text,
          latestRef.current.attachments
        );
      }
    };
  }, [threadId, workspaceId]);

  return { saveDraft, flushDraft, clearDraft };
}
