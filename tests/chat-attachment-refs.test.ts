import { describe, expect, it } from 'vitest';
import {
  appendAttachmentReferences,
  appendUserUploadReferences,
  buildUserUploadReference,
  isUserUploadMountPath,
  parseUploadRefs,
  parseUploadRefsFromContent,
} from '@/lib/chat-attachment-refs';
import type { ContentBlock } from '@/types';

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

  it('parses upload refs from string content like parseUploadRefs', () => {
    const content =
      'please analyze\n\n(user uploaded file to uploads/report-1710000000-abcd.csv)';

    expect(parseUploadRefsFromContent(content)).toEqual(parseUploadRefs(content));
  });

  it('parses upload refs from text content blocks and strips markers', () => {
    const result = parseUploadRefsFromContent([
      {
        type: 'text',
        text: 'please analyze\n\n(user uploaded file to uploads/report-1710000000-abcd.csv)',
      },
    ]);

    expect(result.refs).toEqual([
      {
        originalText: '(user uploaded file to uploads/report-1710000000-abcd.csv)',
        mountPath: 'uploads/report-1710000000-abcd.csv',
        filename: 'report-1710000000-abcd.csv',
        originalName: 'report.csv',
        kind: 'user_upload',
      },
    ]);
    expect(result.cleanContent).toEqual([{ type: 'text', text: 'please analyze' }]);
  });

  it('drops file-only text blocks after extracting upload refs', () => {
    const result = parseUploadRefsFromContent([
      {
        type: 'text',
        text: '(user uploaded file to uploads/data-1710000000-abcd.json)',
      },
    ]);

    expect(result.refs).toHaveLength(1);
    expect(result.cleanContent).toEqual([]);
  });

  it('accumulates refs across text blocks while preserving non-upload content and non-text blocks', () => {
    const content: ContentBlock[] = [
      {
        type: 'text',
        itemKind: 'userNote',
        text: 'first\n(user uploaded file to uploads/first-1710000000-abcd.csv)',
      },
      { type: 'thinking', thinking: 'preserved' },
      { type: 'text', text: 'middle' },
      {
        type: 'text',
        text: '(user uploaded file to uploads/second-1710000001-wxyz.json)',
      },
    ];

    const result = parseUploadRefsFromContent(content);

    expect(result.refs.map((ref) => ref.mountPath)).toEqual([
      'uploads/first-1710000000-abcd.csv',
      'uploads/second-1710000001-wxyz.json',
    ]);
    expect(result.cleanContent).toEqual([
      { type: 'text', itemKind: 'userNote', text: 'first' },
      { type: 'thinking', thinking: 'preserved' },
      { type: 'text', text: 'middle' },
    ]);
  });

  it('parses generated transcript annotations from content blocks', () => {
    const result = parseUploadRefsFromContent([
      {
        type: 'text',
        itemKind: 'generated_transcript',
        text: 'compare this\n(user uploaded file to uploads/meeting-1710000000-abcd.md) ⟦upload: generated_transcript source_thread_id=thread_123⟧',
      },
    ]);

    expect(result.refs).toEqual([
      {
        originalText:
          '(user uploaded file to uploads/meeting-1710000000-abcd.md) ⟦upload: generated_transcript source_thread_id=thread_123⟧',
        mountPath: 'uploads/meeting-1710000000-abcd.md',
        filename: 'meeting-1710000000-abcd.md',
        originalName: 'meeting.md',
        kind: 'generated_transcript',
        sourceThreadId: 'thread_123',
      },
    ]);
    expect(result.cleanContent).toEqual([
      { type: 'text', itemKind: 'generated_transcript', text: 'compare this' },
    ]);
  });
});
