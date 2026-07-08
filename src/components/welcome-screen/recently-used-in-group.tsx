'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FolderGit2 } from 'lucide-react';
import { toast } from 'sonner';
import type {
  AtMentionEntity,
  CondensedTranscript,
  GroupNewChatAttachmentCard,
  GroupNewChatPayload,
  GroupNewChatRecentItems,
  GroupNewChatTranscriptCard,
  Integration,
} from '@/types';
import type { Attachment } from '@/components/attachment-list';
import { MentionTargetHoverCard } from '@/components/at-mention-menu/mention-target-hover-preview';
import { Skeleton } from '@/components/ui/skeleton';
import { IntegrationIcon, resolveLogoType } from '@/lib/integration-icons';
import {
  parseMentions,
  type MentionableProject,
} from '@/lib/mentions';
import { cn } from '@/lib/utils';
import { RecentAttachmentCard } from './attachment-card';
import { TranscriptCard } from './transcript-card';
import type { TranscriptPreviewState } from './transcript-hover-preview';

interface RecentlyUsedInGroupProps {
  group: GroupNewChatPayload;
  connections: Integration[];
  projects: MentionableProject[];
  inputValue: string;
  attachments: Attachment[];
  workspaceId: string | null;
  mentionSlugMap: ReadonlyMap<string, AtMentionEntity>;
  onTagSelect: (item: AtMentionEntity) => void;
  onAttachmentSelect: (card: GroupNewChatAttachmentCard) => void;
  onTranscriptAttach: (
    transcript: CondensedTranscript,
    card: GroupNewChatTranscriptCard,
  ) => Promise<void> | void;
}

function isPromiseLike<T>(value: T | Promise<T> | undefined): value is Promise<T> {
  return typeof (value as Promise<T> | undefined)?.then === 'function';
}

function RecentlyUsedTag({
  item,
  onSelect,
}: {
  item: AtMentionEntity;
  onSelect: (item: AtMentionEntity) => void;
}) {
  const label = item.name || (item.kind === 'connection' ? item.integration_type : 'Project');

  return (
    <MentionTargetHoverCard target={item}>
      <button
        type="button"
        onClick={() => onSelect(item)}
        aria-label={`Add ${label} to chat`}
        className={cn(
          'inline-flex items-center gap-2 rounded-lg px-4 py-2.5',
          'cursor-pointer border border-border bg-card hover:bg-accent/50',
          'text-sm transition-all duration-200 ease-out',
          'hover:border-ring hover:shadow-md',
        )}
      >
        {item.kind === 'connection' ? (
          <IntegrationIcon
            type={resolveLogoType(item.integration_type, [
              (item.config as Record<string, unknown>)?.display_name as string,
              item.name,
            ])}
            size={16}
          />
        ) : (
          <FolderGit2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <span className="text-foreground">{label}</span>
      </button>
    </MentionTargetHoverCard>
  );
}

function parseTranscriptPayload(value: unknown): CondensedTranscript | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.threadId !== 'string' ||
    typeof record.title !== 'string' ||
    !Array.isArray(record.turns)
  ) {
    return null;
  }

  const turns = record.turns
    .map((turn) => {
      if (!turn || typeof turn !== 'object') return null;
      const turnRecord = turn as Record<string, unknown>;
      if (
        typeof turnRecord.user !== 'string' ||
        typeof turnRecord.assistantFinal !== 'string' ||
        typeof turnRecord.omittedCount !== 'number' ||
        !Number.isFinite(turnRecord.omittedCount)
      ) {
        return null;
      }
      return {
        user: turnRecord.user,
        assistantFinal: turnRecord.assistantFinal,
        omittedCount: turnRecord.omittedCount,
      };
    })
    .filter((turn): turn is CondensedTranscript['turns'][number] => turn !== null);

  return {
    threadId: record.threadId,
    title: record.title,
    turns,
  };
}

export function RecentlyUsedInGroup({
  group,
  connections,
  projects,
  inputValue,
  attachments,
  workspaceId,
  mentionSlugMap,
  onTagSelect,
  onAttachmentSelect,
  onTranscriptAttach,
}: RecentlyUsedInGroupProps) {
  const [resolvedRecentItems, setResolvedRecentItems] =
    useState<GroupNewChatRecentItems>(() => ({
      recentlyUsed: group.recentlyUsed,
      attachmentCards: group.attachmentCards,
    }));
  const [recentItemsPending, setRecentItemsPending] = useState(() =>
    isPromiseLike(group.recentItems),
  );
  const [transcriptStates, setTranscriptStates] = useState<
    Record<string, TranscriptPreviewState>
  >({});
  const [insertingThreadId, setInsertingThreadId] = useState<string | null>(null);
  const pendingTranscriptsRef = useRef(new Map<string, Promise<CondensedTranscript>>());

  useEffect(() => {
    const fallbackItems = {
      recentlyUsed: group.recentlyUsed,
      attachmentCards: group.attachmentCards,
    };
    if (!isPromiseLike(group.recentItems)) {
      setResolvedRecentItems(group.recentItems ?? fallbackItems);
      setRecentItemsPending(false);
      return;
    }

    let cancelled = false;
    setRecentItemsPending(true);
    setResolvedRecentItems(fallbackItems);
    group.recentItems
      .then((items) => {
        if (!cancelled) {
          setResolvedRecentItems(items);
          setRecentItemsPending(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResolvedRecentItems(fallbackItems);
          setRecentItemsPending(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [group.attachmentCards, group.recentItems, group.recentlyUsed]);

  const mentionedTargets = useMemo(() => {
    const targets = new Set<string>();
    for (const match of parseMentions(inputValue, mentionSlugMap)) {
      if (!match.target) continue;
      targets.add(`${match.target.kind}:${match.target.id}`);
    }
    return targets;
  }, [inputValue, mentionSlugMap]);

  const tags = useMemo<AtMentionEntity[]>(() => {
    const connectionsById = new Map(connections.map((connection) => [connection.id, connection]));
    const projectsById = new Map(projects.map((project) => [project.id, project]));
    const nextTags: AtMentionEntity[] = [];

    for (const projectId of resolvedRecentItems.recentlyUsed.projectIds) {
      const project = projectsById.get(projectId);
      if (!project || mentionedTargets.has(`project:${project.id}`)) continue;
      nextTags.push(project);
    }

    for (const connectionId of resolvedRecentItems.recentlyUsed.connectionIds) {
      const connection = connectionsById.get(connectionId);
      if (!connection || mentionedTargets.has(`connection:${connection.id}`)) continue;
      nextTags.push({ ...connection, kind: 'connection' as const });
    }

    return nextTags;
  }, [
    connections,
    mentionedTargets,
    projects,
    resolvedRecentItems.recentlyUsed.connectionIds,
    resolvedRecentItems.recentlyUsed.projectIds,
  ]);

  const attachedPaths = useMemo(
    () => new Set(attachments.map((attachment) => attachment.path).filter(Boolean)),
    [attachments],
  );

  const attachmentCards = useMemo(
    () =>
      resolvedRecentItems.attachmentCards.filter(
        (card) => !attachedPaths.has(card.path),
      ),
    [attachedPaths, resolvedRecentItems.attachmentCards],
  );
  const showAttachmentSkeletons =
    recentItemsPending &&
    (group.pendingAttachmentCount ?? 0) > 0 &&
    attachmentCards.length === 0;

  const attachedTranscriptThreadIds = useMemo(
    () =>
      new Set(
        attachments
          .filter((attachment) => attachment.kind === 'transcript')
          .map((attachment) => attachment.sourceThreadId)
          .filter((threadId): threadId is string => Boolean(threadId)),
      ),
    [attachments],
  );

  const transcriptCards = useMemo(
    () =>
      group.transcriptCards.filter(
        (card) => !attachedTranscriptThreadIds.has(card.threadId),
      ),
    [attachedTranscriptThreadIds, group.transcriptCards],
  );

  const ensureTranscript = useCallback(
    (card: GroupNewChatTranscriptCard): Promise<CondensedTranscript> => {
      const existingState = transcriptStates[card.threadId];
      if (existingState?.status === 'ready') {
        return Promise.resolve(existingState.transcript);
      }

      const pending = pendingTranscriptsRef.current.get(card.threadId);
      if (pending) return pending;

      setTranscriptStates((current) => ({
        ...current,
        [card.threadId]: { status: 'loading' },
      }));

      const request = fetch(
        `/api/threads/${encodeURIComponent(card.threadId)}/condensed-transcript?groupId=${encodeURIComponent(group.id)}`,
      )
        .then(async (response) => {
          const payload = (await response.json().catch(() => null)) as unknown;
          if (!response.ok) {
            const errorPayload =
              payload && typeof payload === 'object'
                ? (payload as { error?: unknown })
                : null;
            const message =
              typeof errorPayload?.error === 'string'
                ? errorPayload.error
                : 'Failed to load transcript';
            throw new Error(message);
          }
          const transcript = parseTranscriptPayload(payload);
          if (!transcript) {
            throw new Error('Invalid transcript response');
          }
          setTranscriptStates((current) => ({
            ...current,
            [card.threadId]: { status: 'ready', transcript },
          }));
          return transcript;
        })
        .catch((error) => {
          const message =
            error instanceof Error ? error.message : 'Failed to load transcript';
          setTranscriptStates((current) => ({
            ...current,
            [card.threadId]: { status: 'error', error: message },
          }));
          throw error;
        })
        .finally(() => {
          pendingTranscriptsRef.current.delete(card.threadId);
        });

      pendingTranscriptsRef.current.set(card.threadId, request);
      return request;
    },
    [group.id, transcriptStates],
  );

  const handlePreviewRequest = useCallback(
    (card: GroupNewChatTranscriptCard) => {
      const state = transcriptStates[card.threadId];
      if (state?.status === 'ready' || state?.status === 'loading') return;
      void ensureTranscript(card).catch(() => {});
    },
    [ensureTranscript, transcriptStates],
  );

  const handleInsertTranscript = useCallback(
    async (card: GroupNewChatTranscriptCard) => {
      setInsertingThreadId(card.threadId);
      try {
        const transcript = await ensureTranscript(card);
        await onTranscriptAttach(transcript, card);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Failed to attach transcript';
        toast.error(message);
      } finally {
        setInsertingThreadId(null);
      }
    },
    [ensureTranscript, onTranscriptAttach],
  );

  if (
    tags.length === 0 &&
    attachmentCards.length === 0 &&
    !showAttachmentSkeletons &&
    transcriptCards.length === 0
  ) {
    return null;
  }

  return (
    <section className="space-y-6">
      <div className="border-b border-border pb-3">
        <span className="text-xs font-medium uppercase tracking-wider text-foreground">
          Recently used in this group
        </span>
      </div>

      {tags.length > 0 ? (
        <div className="space-y-3">
          <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Projects & connections
          </h4>
          <div className="flex flex-wrap gap-3">
            {tags.map((item) => (
              <RecentlyUsedTag
                key={`${item.kind}:${item.id}`}
                item={item}
                onSelect={onTagSelect}
              />
            ))}
          </div>
        </div>
      ) : null}

      {attachmentCards.length > 0 || showAttachmentSkeletons ? (
        <div className="space-y-3">
          <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Attachments
          </h4>
          <div className="flex flex-wrap gap-3">
            {showAttachmentSkeletons
              ? Array.from(
                  { length: Math.min(group.pendingAttachmentCount ?? 0, 8) },
                  (_, index) => (
                    <Skeleton key={index} className="h-[88px] w-[88px] rounded-lg" />
                  ),
                )
              : attachmentCards.map((card) => (
                  <RecentAttachmentCard
                    key={card.path}
                    card={card}
                    workspaceId={workspaceId}
                    onSelect={onAttachmentSelect}
                  />
                ))}
          </div>
        </div>
      ) : null}

      {transcriptCards.length > 0 ? (
        <div className="space-y-3">
          <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Transcripts
          </h4>
          <div className="flex flex-wrap gap-3">
            {transcriptCards.map((card) => (
              <TranscriptCard
                key={card.threadId}
                transcript={card}
                previewState={transcriptStates[card.threadId] ?? { status: 'idle' }}
                isInserting={insertingThreadId === card.threadId}
                onPreviewRequest={handlePreviewRequest}
                onInsert={handleInsertTranscript}
              />
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
