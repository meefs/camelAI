import type { ContentBlock } from '@/types';
import { stripMentionAnnotations } from '@/lib/connection-mentions';

const AUTHOR_PREFIX_WITH_EMAIL_REGEX = /^\[([^\]]+)\s+\(([^)]+)\)\]:\s*/;
const AUTHOR_PREFIX_SIMPLE_REGEX = /^\[([^\]]+)\]:\s*/;
const SYSTEM_MESSAGE_TAG_REGEX = /<camelai system message>[\s\S]*?<\/camelai system message>/g;
const MAX_FIRST_USER_MESSAGE_LENGTH = 500;
const MAX_ASSISTANT_COMPLETION_SUMMARY_LENGTH = 240;

function stripSystemMessageTags(text: string): string {
  return stripMentionAnnotations(text.replace(SYSTEM_MESSAGE_TAG_REGEX, '')).trim();
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
