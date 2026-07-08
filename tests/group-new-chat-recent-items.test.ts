import { describe, expect, it } from 'vitest';
import {
  extractGroupNewChatRecentItems,
  extractUploadRefPathsForHint,
} from '@/lib/group-new-chat-recent-items';
import { appendAttachmentReferences } from '@/lib/chat-attachment-refs';
import type { Integration } from '@/types';
import type { MentionableProject } from '@/lib/mentions';

const connection: Integration = {
  id: 'conn_1',
  integration_type: 'postgres',
  name: 'Prod DB',
  category: 'databases',
  auth_method: 'api_key',
  config: {},
  created_by: 'user_1',
  created_at: 1,
  updated_at: 2,
  has_credentials: true,
};

const project: MentionableProject = {
  kind: 'project',
  id: 'project_1',
  name: 'Frontend App',
  description: 'Main UI project',
  created_at: 1,
  updated_at: 2,
};

describe('extractGroupNewChatRecentItems', () => {
  it('extracts mentions and deduped upload refs from sibling user messages', () => {
    const items = extractGroupNewChatRecentItems({
      connections: [connection],
      projects: [project],
      threads: [
        {
          threadId: 'thread_new',
          title: 'Newer chat',
          messages: [
            {
              role: 'user',
              created_at: 30,
              content:
                'Use @prod_db and @frontend_app\n\n(user uploaded file to uploads/report-1712345678901-abcd.csv)\n(user uploaded file to uploads/design.png)',
            },
            {
              role: 'user',
              created_at: 10,
              content:
                'Older duplicate\n\n(user uploaded file to uploads/report-1712345678901-abcd.csv)',
            },
          ],
        },
        {
          threadId: 'thread_old',
          title: 'Older chat',
          messages: [
            {
              role: 'user',
              created_at: 20,
              content:
                '@prod_db ⟦ref: postgres "Prod DB" id=conn_1⟧\n\n(user uploaded file to uploads/notes.txt)',
            },
          ],
        },
      ],
    });

    expect(items.recentlyUsed).toEqual({
      connectionIds: ['conn_1'],
      projectIds: ['project_1'],
    });
    expect(items.attachmentCards).toEqual([
      {
        path: 'uploads/report-1712345678901-abcd.csv',
        filename: 'report-1712345678901-abcd.csv',
        originalName: 'report.csv',
        sourceThreadId: 'thread_new',
        sourceTitle: 'Newer chat',
        lastUsedAt: 30,
      },
      {
        path: 'uploads/design.png',
        filename: 'design.png',
        originalName: 'design.png',
        sourceThreadId: 'thread_new',
        sourceTitle: 'Newer chat',
        lastUsedAt: 30,
      },
      {
        path: 'uploads/notes.txt',
        filename: 'notes.txt',
        originalName: 'notes.txt',
        sourceThreadId: 'thread_old',
        sourceTitle: 'Older chat',
        lastUsedAt: 20,
      },
    ]);
  });

  it('excludes generated transcript uploads but keeps regular markdown uploads', () => {
    const items = extractGroupNewChatRecentItems({
      connections: [],
      projects: [],
      threads: [
        {
          threadId: 'thread_1',
          title: 'Planning chat',
          messages: [
            {
              role: 'user',
              created_at: 40,
              content:
                'compare these\n\n(user uploaded file to uploads/meeting-transcript.md)\n(user uploaded file to uploads/generated-transcript-1712345678901-abcd.md) ⟦upload: generated_transcript source_thread_id=thread_source⟧',
            },
          ],
        },
      ],
    });

    expect(items.attachmentCards).toEqual([
      {
        path: 'uploads/meeting-transcript.md',
        filename: 'meeting-transcript.md',
        originalName: 'meeting-transcript.md',
        sourceThreadId: 'thread_1',
        sourceTitle: 'Planning chat',
        lastUsedAt: 40,
      },
    ]);
  });

  it('excludes generated transcript uploads produced by the sender helper', () => {
    const content = appendAttachmentReferences('use this', [
      {
        path: 'uploads/planning-chat-transcript.md',
        kind: 'generated_transcript',
        sourceThreadId: 'thread_source',
      },
    ]);

    const items = extractGroupNewChatRecentItems({
      connections: [],
      projects: [],
      threads: [
        {
          threadId: 'thread_new',
          title: 'Follow-up chat',
          messages: [{ role: 'user', created_at: 1, content }],
        },
      ],
    });

    expect(items.attachmentCards).toEqual([]);
  });
});

describe('extractUploadRefPathsForHint', () => {
  it('extracts and dedupes upload paths from first and latest user messages', () => {
    expect(
      extractUploadRefPathsForHint(
        '(user uploaded file to uploads/report-1712345678901-abcd.csv)',
        [
          '(user uploaded file to uploads/report-1712345678901-abcd.csv)',
          '(user uploaded file to uploads/design.png)',
        ].join('\n'),
      ),
    ).toEqual([
      'uploads/report-1712345678901-abcd.csv',
      'uploads/design.png',
    ]);
  });

  it('excludes generated transcript-shaped upload filenames', () => {
    expect(
      extractUploadRefPathsForHint(
        '(user uploaded file to uploads/planning-chat-transcript-1751000000000-ab12.md)',
      ),
    ).toEqual([]);
  });

  it('returns an empty list for null and marker-free text', () => {
    expect(extractUploadRefPathsForHint(null, undefined, 'no uploads here')).toEqual([]);
  });

  it('extracts markers beyond the 500 character preview truncation point', () => {
    const longMessage = `${'x'.repeat(520)}\n\n(user uploaded file to uploads/late-1712345678901-abcd.png)`;

    expect(extractUploadRefPathsForHint(longMessage)).toEqual([
      'uploads/late-1712345678901-abcd.png',
    ]);
  });

  it('caps upload-ref hints at the maximum displayed attachment cards', () => {
    const text = Array.from(
      { length: 12 },
      (_, index) => `(user uploaded file to uploads/file-${index}.txt)`,
    ).join('\n');

    expect(extractUploadRefPathsForHint(text)).toEqual(
      Array.from({ length: 8 }, (_, index) => `uploads/file-${index}.txt`),
    );
  });
});
