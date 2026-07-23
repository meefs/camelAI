export const THREAD_SEARCH_QUERY_MAX_CHARS = 200;
export const THREAD_SEARCH_MAX_TERMS = 5;
export const THREAD_SEARCH_FIELD_MAX_CHARS = 8192;
export const THREAD_ASK_LOG_MAX_BYTES = 8192;
export const THREAD_ASK_LOG_ENTRY_MAX_CHARS = 500;

export function canonicalizeThreadSearchQuery(
  query: string | null | undefined,
): string {
  const trimmed = query?.trim() ?? '';
  let canonical = '';
  let codePointCount = 0;

  for (const character of trimmed) {
    if (codePointCount === THREAD_SEARCH_QUERY_MAX_CHARS) break;

    const codeUnit = character.charCodeAt(0);
    canonical += character.length === 1
      && codeUnit >= 0xd800
      && codeUnit <= 0xdfff
      ? '\ufffd'
      : character;
    codePointCount += 1;
  }

  return canonical;
}

export interface ThreadSearchMatch {
  field:
    | 'title'
    | 'first_user_message'
    | 'last_user_message'
    | 'last_assistant_summary'
    | 'user_ask_log';
  snippet: string | null;
  matchStart: number;
  matchEnd: number;
}

export function parseThreadSearchTerms(
  query: string | null | undefined,
): string[] {
  const bounded = canonicalizeThreadSearchQuery(query);
  if (!bounded) return [];

  const seen = new Set<string>();
  const terms: string[] = [];
  for (const term of bounded.split(/\s+/)) {
    const key = term.toLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length === THREAD_SEARCH_MAX_TERMS) break;
  }
  return terms;
}

export function normalizeThreadSearchTitle(title: string): string {
  return Array.from(title.toLowerCase())
    .slice(0, THREAD_SEARCH_FIELD_MAX_CHARS)
    .join('');
}

function findNearestStartBoundary(text: string, target: number): number {
  if (target <= 0) return 0;

  let nearest = target;
  let nearestDistance = Number.POSITIVE_INFINITY;
  const from = Math.max(0, target - 10);
  const to = Math.min(text.length - 1, target + 10);
  for (let index = from; index <= to; index += 1) {
    if (text[index] !== ' ') continue;
    const boundary = index + 1;
    const distance = Math.abs(boundary - target);
    if (distance < nearestDistance) {
      nearest = boundary;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function findNearestEndBoundary(text: string, target: number): number {
  if (target >= text.length) return text.length;

  let nearest = target;
  let nearestDistance = Number.POSITIVE_INFINITY;
  const from = Math.max(0, target - 10);
  const to = Math.min(text.length - 1, target + 10);
  for (let index = from; index <= to; index += 1) {
    if (text[index] !== ' ') continue;
    const distance = Math.abs(index - target);
    if (distance < nearestDistance) {
      nearest = index;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function findCaseInsensitiveRange(
  text: string,
  term: string,
): { start: number; end: number } | null {
  const foldedTerm = term.toLowerCase();
  const foldedStart = text.toLowerCase().indexOf(foldedTerm);
  if (foldedStart < 0) return null;

  const foldedEnd = foldedStart + foldedTerm.length;
  let foldedOffset = 0;
  let originalOffset = 0;
  let originalStart: number | null = null;

  for (const character of text) {
    const nextOriginalOffset = originalOffset + character.length;
    const nextFoldedOffset = foldedOffset + character.toLowerCase().length;
    if (originalStart === null && foldedStart < nextFoldedOffset) {
      originalStart = originalOffset;
    }
    if (originalStart !== null && foldedEnd <= nextFoldedOffset) {
      return { start: originalStart, end: nextOriginalOffset };
    }
    originalOffset = nextOriginalOffset;
    foldedOffset = nextFoldedOffset;
  }

  return null;
}

export function buildThreadSearchMatch(
  row: {
    title: string;
    first_user_message?: string | null;
    last_user_message?: string | null;
    last_assistant_summary?: string | null;
    user_ask_log?: string | null;
  },
  terms: string[],
): ThreadSearchMatch | null {
  if (terms.length === 0) return null;

  const fields: Array<{
    field: ThreadSearchMatch['field'];
    value: string | null | undefined;
  }> = [
    { field: 'title', value: row.title },
    { field: 'first_user_message', value: row.first_user_message },
    { field: 'last_user_message', value: row.last_user_message },
    { field: 'user_ask_log', value: row.user_ask_log },
    { field: 'last_assistant_summary', value: row.last_assistant_summary },
  ];

  for (const { field, value } of fields) {
    const collapsed = value?.replace(/\s+/g, ' ').trim();
    if (!collapsed) continue;

    for (const term of terms) {
      const range = findCaseInsensitiveRange(collapsed, term);
      if (!range) continue;

      if (field === 'title') {
        return { field, snippet: null, matchStart: 0, matchEnd: 0 };
      }

      const rawStart = Math.max(0, range.start - 30);
      const rawEnd = Math.min(collapsed.length, range.end + 90);
      const start = findNearestStartBoundary(collapsed, rawStart);
      const end = findNearestEndBoundary(collapsed, rawEnd);
      const clippedAtStart = start > 0;
      const clippedAtEnd = end < collapsed.length;
      const prefix = clippedAtStart ? '…' : '';
      const suffix = clippedAtEnd ? '…' : '';
      const snippet = `${prefix}${collapsed.slice(start, end)}${suffix}`;
      const matchStart = prefix.length + range.start - start;

      return {
        field,
        snippet,
        matchStart,
        matchEnd: matchStart + range.end - range.start,
      };
    }
  }

  return null;
}

/**
 * Append one normalized user message to the newline-delimited ask log.
 * Returns the byte-bounded existing log when there is nothing to append.
 */
export function appendToThreadAskLog(
  existing: string | null,
  message: string | null,
): string | null {
  const encoder = new TextEncoder();
  const trimToByteLimit = (value: string): string => {
    let bounded = value;
    while (encoder.encode(bounded).byteLength > THREAD_ASK_LOG_MAX_BYTES) {
      const newlineIndex = bounded.indexOf('\n');
      if (newlineIndex >= 0) {
        bounded = bounded.slice(newlineIndex + 1);
        continue;
      }

      const suffix: string[] = [];
      let suffixBytes = 0;
      const characters = Array.from(bounded);
      for (let index = characters.length - 1; index >= 0; index -= 1) {
        const character = characters[index]!;
        const characterBytes = encoder.encode(character).byteLength;
        if (suffixBytes + characterBytes > THREAD_ASK_LOG_MAX_BYTES) break;
        suffix.push(character);
        suffixBytes += characterBytes;
      }
      return suffix.reverse().join('');
    }
    return bounded;
  };

  const boundedExisting = existing ? trimToByteLimit(existing) : null;
  const collapsed = message?.replace(/\s+/g, ' ').trim() ?? '';
  if (!collapsed) return boundedExisting;

  const entry = Array.from(collapsed)
    .slice(0, THREAD_ASK_LOG_ENTRY_MAX_CHARS)
    .join('');
  const lastLineStart = boundedExisting?.lastIndexOf('\n') ?? -1;
  const lastLine = boundedExisting?.slice(lastLineStart + 1) ?? null;
  if (lastLine === entry) return boundedExisting;

  const log = boundedExisting ? `${boundedExisting}\n${entry}` : entry;
  return trimToByteLimit(log);
}
