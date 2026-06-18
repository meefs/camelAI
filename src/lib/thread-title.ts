import { isSupportedSlashCommand } from './slash-commands';
import {
  normalizeThreadUserMessageText,
  truncateThreadPreviewText,
} from './thread-preview';

export const DEFAULT_THREAD_TITLE = 'New Chat';
export const APP_THREAD_FALLBACK_TITLE_PREFIX = 'Working on ';
export const THREAD_TITLE_GENERATION_SYSTEM_PROMPT =
  'Create a concise 3-6 word chat title for the user request. Do not copy the full request. Use title case. Respond with only the title: no markdown, quotes, punctuation, or explanation.';

const MAX_THREAD_TITLE_LENGTH = 100;
const TITLE_CASE_ACRONYMS = new Set([
  'ai',
  'api',
  'auth',
  'css',
  'db',
  'html',
  'http',
  'https',
  'id',
  'json',
  'oauth',
  'r2',
  'sql',
  'ui',
  'url',
  'ux',
]);

function toTitleCase(title: string): string {
  return title.replace(/\S+/g, (word) => {
    const lower = word.toLowerCase();
    if (TITLE_CASE_ACRONYMS.has(lower)) {
      return lower === 'oauth' ? 'OAuth' : lower.toUpperCase();
    }
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  });
}

export function sanitizeGeneratedThreadTitle(
  title: string | null | undefined,
  options: { titleCase?: boolean } = {},
): string | null {
  const normalized = title
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/^#+\s*/, '')
    .replace(/^[-*`"'“”]+|[-*`"'“”]+$/g, '')
    .trim();
  if (!normalized) {
    return null;
  }

  const formatted = options.titleCase ? toTitleCase(normalized) : normalized;
  return formatted.slice(0, MAX_THREAD_TITLE_LENGTH);
}

export function buildAppThreadFallbackTitle(scriptName: string): string {
  const normalized = scriptName.trim();
  if (!normalized) {
    return DEFAULT_THREAD_TITLE;
  }

  return sanitizeGeneratedThreadTitle(`${APP_THREAD_FALLBACK_TITLE_PREFIX}${normalized}`)
    ?? DEFAULT_THREAD_TITLE;
}

export function isPlaceholderThreadTitle(title: string | null | undefined): boolean {
  const normalized = title?.trim();
  return !normalized
    || normalized === DEFAULT_THREAD_TITLE
    || normalized.startsWith(APP_THREAD_FALLBACK_TITLE_PREFIX);
}

export function getInitialChatGroupNameFromThreadTitle(
  title: string | null | undefined,
): string | undefined {
  const normalized = sanitizeGeneratedThreadTitle(title);
  if (!normalized || isPlaceholderThreadTitle(normalized)) {
    return undefined;
  }
  return normalized;
}

export function getThreadUserMessageSources(content: string): {
  metadataSourceMessage: string;
  titleSourceMessage: string;
} | null {
  const metadataSourceMessage = normalizeThreadUserMessageText(content);
  if (!metadataSourceMessage) {
    return null;
  }

  const titleSourceMessage = truncateThreadPreviewText(metadataSourceMessage, 500);
  if (!titleSourceMessage || isSupportedSlashCommand(titleSourceMessage)) {
    return null;
  }

  return {
    metadataSourceMessage,
    titleSourceMessage,
  };
}

export function getThreadTitleSourceMessage(content: string): string | null {
  return getThreadUserMessageSources(content)?.titleSourceMessage ?? null;
}
