import {
  isUserUploadMountPath,
  parseUploadRefs,
} from '@/lib/chat-attachment-refs';
import {
  buildSlugMap,
  parseMentions,
  stripMentionAnnotationsWithMetadata,
  type MentionableProject,
} from '@/lib/mentions';
import { normalizeThreadUserMessageText } from '@/lib/thread-preview';
import type { ThreadProjectActivity } from '@/lib/thread-project-activity';
import type { GroupNewChatRecentItems, Integration } from '@/types';

const UPLOAD_REF_HINT_LIMIT = 8;

export interface GroupRecentItemsMessage {
  role: 'user' | 'assistant';
  content: unknown;
  created_at: number;
  isMeta?: boolean;
  isCompactSummary?: boolean;
}

export interface GroupRecentItemsThread {
  threadId: string;
  title: string;
  messages: GroupRecentItemsMessage[];
  projectActivity?: ThreadProjectActivity[];
}

/**
 * Upload mount paths referenced in a thread's first/latest user message
 * summaries. Used as a synchronous "attachments are coming" hint while the
 * full recent-items scan streams; generated transcripts are excluded by
 * filename since summary normalization strips the upload kind annotation.
 */
export function extractUploadRefPathsForHint(
  ...texts: Array<string | null | undefined>
): string[] {
  const paths = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const ref of parseUploadRefs(text).refs) {
      if (!isUserUploadMountPath(ref.mountPath)) continue;
      if (ref.originalName.endsWith('-transcript.md')) continue;
      paths.add(ref.mountPath);
      if (paths.size >= UPLOAD_REF_HINT_LIMIT) {
        return [...paths];
      }
    }
  }
  return [...paths];
}

function contentToUserText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      const record = block as { type?: unknown; text?: unknown };
      return record.type === 'text' && typeof record.text === 'string'
        ? record.text
        : '';
    })
    .filter(Boolean)
    .join('\n');
}

export function extractGroupNewChatRecentItems({
  threads,
  connections,
  projects,
  attachmentLimit = 8,
}: {
  threads: GroupRecentItemsThread[];
  connections: Integration[];
  projects: MentionableProject[];
  attachmentLimit?: number;
}): GroupNewChatRecentItems {
  const mentionableConnections = connections.map((connection) => ({
    ...connection,
    kind: 'connection' as const,
  }));
  const mentionables = [...mentionableConnections, ...projects];
  const slugMap = buildSlugMap(mentionables);
  const connectionIds = new Set(connections.map((connection) => connection.id));
  const projectIds = new Set(projects.map((project) => project.id));
  const seenConnectionIds = new Set<string>();
  const projectRecency = new Map<
    string,
    { lastUsedAt: number; firstSeenOrder: number }
  >();
  let nextProjectSeenOrder = 0;
  const seenAttachmentPaths = new Set<string>();
  const recentlyUsed: GroupNewChatRecentItems['recentlyUsed'] = {
    connectionIds: [],
    projectIds: [],
  };
  const attachmentCards: GroupNewChatRecentItems['attachmentCards'] = [];

  const addConnection = (id: string | null | undefined) => {
    if (!id || !connectionIds.has(id) || seenConnectionIds.has(id)) return;
    seenConnectionIds.add(id);
    recentlyUsed.connectionIds.push(id);
  };
  const addProject = (
    id: string | null | undefined,
    lastUsedAt: number,
  ) => {
    if (!id || !projectIds.has(id)) return;
    const normalizedLastUsedAt =
      Number.isFinite(lastUsedAt) && lastUsedAt > 0 ? lastUsedAt : 0;
    const existing = projectRecency.get(id);
    if (existing) {
      existing.lastUsedAt = Math.max(existing.lastUsedAt, normalizedLastUsedAt);
      return;
    }
    projectRecency.set(id, {
      lastUsedAt: normalizedLastUsedAt,
      firstSeenOrder: nextProjectSeenOrder,
    });
    nextProjectSeenOrder += 1;
  };

  for (const thread of threads) {
    const userMessages = [...thread.messages]
      .filter(
        (message) =>
          message.role === 'user' &&
          !message.isMeta &&
          !message.isCompactSummary,
      )
      .sort((left, right) => right.created_at - left.created_at);

    for (const message of userMessages) {
      const rawText = contentToUserText(message.content);
      if (!rawText.trim()) continue;

      const { displayText, annotatedMentions } =
        stripMentionAnnotationsWithMetadata(rawText);
      for (const mention of annotatedMentions) {
        addConnection(mention.id);
        addProject(mention.id, message.created_at);
      }

      const normalizedTextWithUploadAnnotations = normalizeThreadUserMessageText(
        displayText,
        { stripUploadAnnotations: false },
      );
      const normalizedText = normalizeThreadUserMessageText(displayText);
      if (!normalizedTextWithUploadAnnotations || !normalizedText) continue;

      for (const uploadRef of parseUploadRefs(normalizedTextWithUploadAnnotations).refs) {
        if (
          uploadRef.kind === 'generated_transcript' ||
          attachmentCards.length >= attachmentLimit ||
          seenAttachmentPaths.has(uploadRef.mountPath) ||
          !isUserUploadMountPath(uploadRef.mountPath)
        ) {
          continue;
        }
        seenAttachmentPaths.add(uploadRef.mountPath);
        attachmentCards.push({
          path: uploadRef.mountPath,
          filename: uploadRef.filename,
          originalName: uploadRef.originalName,
          sourceThreadId: thread.threadId,
          sourceTitle: thread.title,
          lastUsedAt: message.created_at,
        });
      }

      for (const match of parseMentions(normalizedText, slugMap)) {
        if (!match.target) continue;
        if (match.target.kind === 'connection') {
          addConnection(match.target.id);
        } else {
          addProject(match.target.id, message.created_at);
        }
      }
    }

    for (const activity of thread.projectActivity ?? []) {
      if (
        (activity.activityType !== 'created' &&
          activity.activityType !== 'deployed') ||
        !Number.isFinite(activity.lastUsedAt) ||
        activity.lastUsedAt <= 0
      ) {
        continue;
      }
      addProject(activity.projectId, activity.lastUsedAt);
    }
  }

  recentlyUsed.projectIds = [...projectRecency.entries()]
    .sort(([, left], [, right]) => {
      if (left.lastUsedAt !== right.lastUsedAt) {
        return right.lastUsedAt - left.lastUsedAt;
      }
      return left.firstSeenOrder - right.firstSeenOrder;
    })
    .map(([projectId]) => projectId);

  return {
    recentlyUsed,
    attachmentCards,
  };
}
