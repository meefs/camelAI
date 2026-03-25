import { isSupportedSlashCommand } from './slash-commands';
import { normalizeThreadPreviewUserMessage } from './thread-preview';

export const DEFAULT_THREAD_TITLE = 'New Chat';
export const APP_THREAD_FALLBACK_TITLE_PREFIX = 'Working on ';
export const THREAD_TITLE_GENERATION_SYSTEM_PROMPT =
  'Summarize the message into a simple chat thread topic title. Respond with only the title, no quotes or extra punctuation.';

const MAX_THREAD_TITLE_LENGTH = 100;

export function sanitizeGeneratedThreadTitle(title: string | null | undefined): string | null {
  const normalized = title?.trim();
  if (!normalized) {
    return null;
  }

  return normalized.slice(0, MAX_THREAD_TITLE_LENGTH);
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

export function getThreadTitleSourceMessage(content: string): string | null {
  const normalized = normalizeThreadPreviewUserMessage(content);
  if (!normalized) {
    return null;
  }

  if (isSupportedSlashCommand(normalized)) {
    return null;
  }

  return normalized;
}
