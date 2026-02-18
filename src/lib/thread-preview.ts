import type { ContentBlock, Message } from '@/types';

const AUTHOR_PREFIX_WITH_EMAIL_REGEX = /^\[([^\]]+)\s+\(([^)]+)\)\]:\s*/;
const AUTHOR_PREFIX_SIMPLE_REGEX = /^\[([^\]]+)\]:\s*/;
const SYSTEM_MESSAGE_TAG_REGEX = /<camelai system message>[\s\S]*?<\/camelai system message>/g;
const MAX_FIRST_USER_MESSAGE_LENGTH = 500;

function stripSystemMessageTags(text: string): string {
  return text.replace(SYSTEM_MESSAGE_TAG_REGEX, '').trim();
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
 * Convert a user message into the normalized text shown in recent-chat cards.
 */
export function normalizeThreadPreviewUserMessage(content: string | ContentBlock[]): string | null {
  const rawText = contentToText(content);
  const withoutSystemTags = stripSystemMessageTags(rawText);
  if (!withoutSystemTags) {
    return null;
  }

  const withoutAuthor = stripAuthorPrefix(withoutSystemTags).trim();
  if (!withoutAuthor) {
    return null;
  }

  return withoutAuthor.slice(0, MAX_FIRST_USER_MESSAGE_LENGTH);
}

/**
 * Find the first non-meta user message suitable for thread preview text.
 */
export function getFirstThreadPreviewUserMessage(messages: Message[]): string | null {
  for (const message of messages) {
    if (message.role !== 'user') {
      continue;
    }
    if (message.isMeta || message.isCompactSummary) {
      continue;
    }

    const normalized = normalizeThreadPreviewUserMessage(message.content);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}
