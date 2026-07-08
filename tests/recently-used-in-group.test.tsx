import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectedTools } from '@/components/welcome-screen/connected-tools';
import { RecentlyUsedInGroup } from '@/components/welcome-screen/recently-used-in-group';
import { buildSlugMap, type MentionableProject } from '@/lib/mentions';
import type {
  AtMentionEntity,
  GroupNewChatPayload,
  GroupNewChatRecentItems,
  Integration,
} from '@/types';

const connection: Integration = {
  id: 'conn_1',
  integration_type: 'postgres',
  name: 'Prod DB',
  category: 'databases',
  auth_method: 'api_key',
  config: {},
  created_by: 'user_1',
  created_at: Date.now() - 2 * 24 * 60 * 60 * 1000,
  updated_at: Date.now() - 24 * 60 * 60 * 1000,
  has_credentials: false,
};

const project: MentionableProject = {
  kind: 'project',
  id: 'project_1',
  name: 'Frontend App',
  description: 'Main UI project',
  created_at: Date.now() - 2 * 24 * 60 * 60 * 1000,
  updated_at: Date.now() - 24 * 60 * 60 * 1000,
};

function groupPayload(overrides: Partial<GroupNewChatPayload> = {}): GroupNewChatPayload {
  return {
    id: 'group_1',
    name: 'Launch group',
    avatar: null,
    transcriptCards: [],
    recentlyUsed: { connectionIds: [], projectIds: [] },
    attachmentCards: [],
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function hoverWithDelay(user: ReturnType<typeof userEvent.setup>, element: HTMLElement) {
  await user.hover(element);
}

describe('recent mention and attachment pills', () => {
  afterEach(() => vi.useRealTimers());

  it('shows the shared connection hover preview for standard connected tools', async () => {
    const user = userEvent.setup();

    render(<ConnectedTools connections={[connection]} onSelect={vi.fn()} />);

    await hoverWithDelay(user, screen.getByRole('button', { name: /Prod DB/ }));

    expect(await screen.findByText('No credentials configured')).toBeInTheDocument();
    expect(screen.getByText(/Updated/)).toBeInTheDocument();
  });

  it('shows shared project and connection hover previews for group recent tags', async () => {
    const user = userEvent.setup();
    const mentionables: AtMentionEntity[] = [
      { ...connection, kind: 'connection' },
      project,
    ];

    render(
      <RecentlyUsedInGroup
        group={groupPayload({
          recentlyUsed: {
            connectionIds: [connection.id],
            projectIds: [project.id],
          },
        })}
        connections={[connection]}
        projects={[project]}
        inputValue=""
        attachments={[]}
        workspaceId={null}
        mentionSlugMap={buildSlugMap(mentionables)}
        onTagSelect={vi.fn()}
        onAttachmentSelect={vi.fn()}
        onTranscriptAttach={vi.fn()}
      />,
    );

    expect(screen.getByText('Projects & connections')).toBeInTheDocument();
    expect(screen.queryByText('Attachments')).not.toBeInTheDocument();
    expect(screen.queryByText('Transcripts')).not.toBeInTheDocument();

    await hoverWithDelay(user, screen.getByRole('button', { name: 'Add Frontend App to chat' }));
    expect(await screen.findByText('Main UI project')).toBeInTheDocument();

    await hoverWithDelay(user, screen.getByRole('button', { name: 'Add Prod DB to chat' }));
    expect(await screen.findByText('No credentials configured')).toBeInTheDocument();
  });

  it('renders recent attachments as FileCard buttons and inserts by card path', async () => {
    const user = userEvent.setup();
    const onAttachmentSelect = vi.fn();

    render(
      <RecentlyUsedInGroup
        group={groupPayload({
          attachmentCards: [
            {
              path: 'uploads/report.csv',
              filename: 'report.csv',
              originalName: 'report.csv',
              sourceThreadId: 'thread_1',
              sourceTitle: 'Planning chat',
              lastUsedAt: 10,
            },
          ],
        })}
        connections={[]}
        projects={[]}
        inputValue=""
        attachments={[]}
        workspaceId={null}
        mentionSlugMap={new Map()}
        onTagSelect={vi.fn()}
        onAttachmentSelect={onAttachmentSelect}
        onTranscriptAttach={vi.fn()}
      />,
    );

    expect(screen.getByText('Attachments')).toBeInTheDocument();
    expect(screen.queryByText('Projects & connections')).not.toBeInTheDocument();
    expect(screen.queryByText('Transcripts')).not.toBeInTheDocument();
    expect(screen.queryByText('0 B')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'report.csv' }));

    expect(onAttachmentSelect).toHaveBeenCalledWith({
      path: 'uploads/report.csv',
      filename: 'report.csv',
      originalName: 'report.csv',
      sourceThreadId: 'thread_1',
      sourceTitle: 'Planning chat',
      lastUsedAt: 10,
    });
  });

  it('renders group recent sublabels in row order when all rows have items', () => {
    const mentionables: AtMentionEntity[] = [
      { ...connection, kind: 'connection' },
      project,
    ];

    render(
      <RecentlyUsedInGroup
        group={groupPayload({
          recentlyUsed: {
            connectionIds: [connection.id],
            projectIds: [project.id],
          },
          attachmentCards: [
            {
              path: 'uploads/report.csv',
              filename: 'report.csv',
              originalName: 'report.csv',
              sourceThreadId: 'thread_1',
              sourceTitle: 'Planning chat',
              lastUsedAt: 10,
            },
          ],
          transcriptCards: [
            {
              threadId: 'thread_2',
              title: 'Architecture review',
              openingLine: 'Deployment notes and follow-ups',
              status: 'idle',
              lastActiveAt: Date.now(),
              lastAssistantCompletedAt: Date.now(),
            },
          ],
        })}
        connections={[connection]}
        projects={[project]}
        inputValue=""
        attachments={[]}
        workspaceId={null}
        mentionSlugMap={buildSlugMap(mentionables)}
        onTagSelect={vi.fn()}
        onAttachmentSelect={vi.fn()}
        onTranscriptAttach={vi.fn()}
      />,
    );

    const sectionText =
      screen.getByText('Recently used in this group').closest('section')?.textContent ?? '';
    const topIndex = sectionText.indexOf('Recently used in this group');
    const tagsIndex = sectionText.indexOf('Projects & connections');
    const attachmentsIndex = sectionText.indexOf('Attachments');
    const transcriptsIndex = sectionText.indexOf('Transcripts');

    expect(topIndex).toBeGreaterThanOrEqual(0);
    expect(tagsIndex).toBeGreaterThan(topIndex);
    expect(attachmentsIndex).toBeGreaterThan(tagsIndex);
    expect(transcriptsIndex).toBeGreaterThan(attachmentsIndex);
  });

  it('reserves pending attachment space with skeletons until recent items resolve', async () => {
    const pendingRecentItems = deferred<GroupNewChatRecentItems>();
    const attachmentCard = {
      path: 'uploads/report.csv',
      filename: 'report.csv',
      originalName: 'report.csv',
      sourceThreadId: 'thread_1',
      sourceTitle: 'Planning chat',
      lastUsedAt: 10,
    };

    const { container } = render(
      <RecentlyUsedInGroup
        group={groupPayload({
          recentItems: pendingRecentItems.promise,
          pendingAttachmentCount: 2,
          transcriptCards: [
            {
              threadId: 'thread_2',
              title: 'Architecture review',
              openingLine: 'Deployment notes and follow-ups',
              status: 'idle',
              lastActiveAt: Date.now(),
              lastAssistantCompletedAt: Date.now(),
            },
          ],
        })}
        connections={[]}
        projects={[]}
        inputValue=""
        attachments={[]}
        workspaceId={null}
        mentionSlugMap={new Map()}
        onTagSelect={vi.fn()}
        onAttachmentSelect={vi.fn()}
        onTranscriptAttach={vi.fn()}
      />,
    );

    expect(screen.getByText('Attachments')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'report.csv' })).not.toBeInTheDocument();

    await act(async () => {
      pendingRecentItems.resolve({
        recentlyUsed: { connectionIds: [], projectIds: [] },
        attachmentCards: [attachmentCard],
      });
      await pendingRecentItems.promise;
    });

    expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'report.csv' })).toBeInTheDocument();
  });

  it('does not render a pending attachments block when the hint count is zero', () => {
    const pendingRecentItems = deferred<GroupNewChatRecentItems>();

    render(
      <RecentlyUsedInGroup
        group={groupPayload({
          recentItems: pendingRecentItems.promise,
          pendingAttachmentCount: 0,
          transcriptCards: [
            {
              threadId: 'thread_2',
              title: 'Architecture review',
              openingLine: 'Deployment notes and follow-ups',
              status: 'idle',
              lastActiveAt: Date.now(),
              lastAssistantCompletedAt: Date.now(),
            },
          ],
        })}
        connections={[]}
        projects={[]}
        inputValue=""
        attachments={[]}
        workspaceId={null}
        mentionSlugMap={new Map()}
        onTagSelect={vi.fn()}
        onAttachmentSelect={vi.fn()}
        onTranscriptAttach={vi.fn()}
      />,
    );

    expect(screen.queryByText('Attachments')).not.toBeInTheDocument();
    expect(screen.getByText('Transcripts')).toBeInTheDocument();
  });

  it('removes the pending attachments block when recent items resolve empty', async () => {
    const pendingRecentItems = deferred<GroupNewChatRecentItems>();

    const { container } = render(
      <RecentlyUsedInGroup
        group={groupPayload({
          recentItems: pendingRecentItems.promise,
          pendingAttachmentCount: 2,
          transcriptCards: [
            {
              threadId: 'thread_2',
              title: 'Architecture review',
              openingLine: 'Deployment notes and follow-ups',
              status: 'idle',
              lastActiveAt: Date.now(),
              lastAssistantCompletedAt: Date.now(),
            },
          ],
        })}
        connections={[]}
        projects={[]}
        inputValue=""
        attachments={[]}
        workspaceId={null}
        mentionSlugMap={new Map()}
        onTagSelect={vi.fn()}
        onAttachmentSelect={vi.fn()}
        onTranscriptAttach={vi.fn()}
      />,
    );

    expect(screen.getByText('Attachments')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(2);

    await act(async () => {
      pendingRecentItems.resolve({
        recentlyUsed: { connectionIds: [], projectIds: [] },
        attachmentCards: [],
      });
      await pendingRecentItems.promise;
    });

    expect(screen.queryByText('Attachments')).not.toBeInTheDocument();
    expect(screen.getByText('Transcripts')).toBeInTheDocument();
  });
});
