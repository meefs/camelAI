import { describe, expect, it } from 'vitest';
import {
  appendAttachmentReferences,
  appendUserUploadReferences,
  buildUserUploadReference,
  isUserUploadMountPath,
} from '@/lib/chat-attachment-refs';

describe('chat attachment references', () => {
  it('appends readable upload mount paths to user messages', () => {
    expect(
      appendUserUploadReferences('please analyze this', [
        'uploads/report-123-abc.csv',
      ]),
    ).toBe(
      'please analyze this\n\n(user uploaded file to uploads/report-123-abc.csv)',
    );
  });

  it('supports file-only messages', () => {
    expect(
      appendUserUploadReferences('', ['uploads/data-123-abc.csv']),
    ).toBe('(user uploaded file to uploads/data-123-abc.csv)');
  });

  it('appends typed user upload references without annotations', () => {
    expect(
      appendAttachmentReferences('please analyze this', [
        { path: 'uploads/report-123-abc.csv', kind: 'user_upload' },
      ]),
    ).toBe(
      'please analyze this\n\n(user uploaded file to uploads/report-123-abc.csv)',
    );
  });

  it('annotates generated transcript references with their source thread id', () => {
    expect(
      appendAttachmentReferences('compare this context', [
        {
          path: 'uploads/planning-chat-123-abc.md',
          kind: 'generated_transcript',
          sourceThreadId: 'thread_123',
          sourceTitle: 'Planning chat',
        },
      ]),
    ).toBe(
      'compare this context\n\n(user uploaded file to uploads/planning-chat-123-abc.md) ⟦upload: generated_transcript source_thread_id=thread_123⟧',
    );
  });

  it('rejects non-upload mount paths', () => {
    expect(isUserUploadMountPath('/tmp/data.csv')).toBe(false);
    expect(() => buildUserUploadReference('/tmp/data.csv')).toThrow(
      'uploads/',
    );
  });
});
