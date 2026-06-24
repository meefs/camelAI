import type { ContentBlock } from '@/types';
import { stripMentionAnnotations } from '@/lib/mentions';
import { stripUploadAnnotations } from '@/lib/chat-attachment-refs';

const AUTHOR_PREFIX_WITH_EMAIL_REGEX = /^\[([^\]]+)\s+\(([^)]+)\)\]:\s*/;
const AUTHOR_PREFIX_SIMPLE_REGEX = /^\[([^\]]+)\]:\s*/;
const SYSTEM_MESSAGE_TAG_REGEX = /<camelai system message>[\s\S]*?<\/camelai system message>/g;
const MAX_THREAD_PREVIEW_TEXT_LENGTH = 500;
const MAX_ASSISTANT_COMPLETION_SUMMARY_LENGTH = 240;

interface NormalizeThreadUserMessageTextOptions {
  stripUploadAnnotations?: boolean;
}

function stripSystemMessageTags(
  text: string,
  options: NormalizeThreadUserMessageTextOptions = {},
): string {
  const withoutMentionAnnotations = stripMentionAnnotations(
    text.replace(SYSTEM_MESSAGE_TAG_REGEX, ''),
  );
  const withoutUploadAnnotations =
    options.stripUploadAnnotations === false
      ? withoutMentionAnnotations
      : stripUploadAnnotations(withoutMentionAnnotations);
  return withoutUploadAnnotations.trim();
}

function stripAuthorPrefix(text: string): string {
  const withEmail = text.match(AUTHOR_PREFIX_WITH_EMAIL_REGEX);
  if (withEmail) {
    return text.slice(withEmail[0].length);
  }

  const simple = text.match(AUTHOR_PREFIX_SIMPLE_REGEX);
  if (simple) {
    return text.slice(simple[0].length);
  }

  return text;
}

function contentToText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') {
    return content;
  }

  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/**
 * Convert a user message into normalized user-authored text for thread metadata.
 */
export function normalizeThreadUserMessageText(
  content: string | ContentBlock[],
  options: NormalizeThreadUserMessageTextOptions = {},
): string | null {
  const rawText = contentToText(content);
  const withoutSystemTags = stripSystemMessageTags(rawText, options);
  if (!withoutSystemTags) {
    return null;
  }

  const withoutAuthor = stripAuthorPrefix(withoutSystemTags).trim();
  if (!withoutAuthor) {
    return null;
  }

  return withoutAuthor;
}

export function truncateThreadPreviewText(
  value: string | null | undefined,
  limit = MAX_THREAD_PREVIEW_TEXT_LENGTH,
): string | null {
  const text = value?.trim();
  if (!text) {
    return null;
  }
  const boundedLimit = Number.isFinite(limit) && limit > 0
    ? Math.floor(limit)
    : MAX_THREAD_PREVIEW_TEXT_LENGTH;
  return text.length > boundedLimit ? text.slice(0, boundedLimit) : text;
}

/**
 * Convert a user message into bounded text for preview-only UI surfaces.
 */
export function normalizeThreadPreviewUserMessage(content: string | ContentBlock[]): string | null {
  return truncateThreadPreviewText(normalizeThreadUserMessageText(content));
}

export function normalizeThreadCompletionSummary(content: string | null | undefined): string | null {
  const raw = content?.replace(SYSTEM_MESSAGE_TAG_REGEX, ' ') ?? '';
  const collapsed = stripMentionAnnotations(raw)
    .replace(/\s+/g, ' ')
    .trim();
  if (!collapsed) {
    return null;
  }

  const withoutWrapper = collapsed
    .replace(/^(assistant\s+)?(?:final\s+)?(?:answer|response|message|result|summary):\s*/i, '')
    .trim();
  if (!withoutWrapper) {
    return null;
  }

  return withoutWrapper.slice(0, MAX_ASSISTANT_COMPLETION_SUMMARY_LENGTH);
}
