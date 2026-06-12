'use client';

import { useMemo } from 'react';

export interface MentionTriggerState {
  /** Whether the menu should be open. */
  open: boolean;
  /** Substring after the "@", lower-cased. Empty string means just-typed `@`. */
  query: string;
  /** Index of the leading "@" in `value`. -1 when closed. */
  triggerStart: number;
  /** Index just past the last character of the partial search query. -1 when closed. */
  triggerEnd: number;
}

const CLOSED: MentionTriggerState = {
  open: false,
  query: '',
  triggerStart: -1,
  triggerEnd: -1,
};

const SEARCH_CHAR = /[a-z0-9_-]/i;

function isWordBoundary(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch);
}

function isMentionSearchChar(ch: string): boolean {
  return SEARCH_CHAR.test(ch) || ch === ' ';
}

interface MentionTriggerInput {
  value: string;
  caretPos: number;
  /** When false, the trigger never opens (textarea blurred / IME composing / etc.). */
  enabled: boolean;
}

/**
 * Detects a live `@<partial>` autocomplete trigger to the left of the caret.
 *
 * Conditions for `open`:
 *   1. There is an `@` somewhere to the left of the caret.
 *   2. Between that `@` and the caret there are only search characters
 *      (slug characters plus normal spaces).
 *   3. The character immediately to the left of `@` is whitespace or
 *      the very start of the string (so `email@host.com` does NOT open).
 *   4. `enabled` is true.
 */
export function useMentionTrigger({
  value,
  caretPos,
  enabled,
}: MentionTriggerInput): MentionTriggerState {
  return useMemo<MentionTriggerState>(() => {
    if (!enabled) return CLOSED;
    if (caretPos < 0 || caretPos > value.length) return CLOSED;

    let cursor = caretPos - 1;
    while (cursor >= 0) {
      const ch = value[cursor];
      if (ch === '@') break;
      if (!isMentionSearchChar(ch)) return CLOSED;
      cursor--;
    }
    if (cursor < 0) return CLOSED;
    if (value[cursor] !== '@') return CLOSED;

    if (!isWordBoundary(value[cursor - 1])) return CLOSED;

    const query = value.slice(cursor + 1, caretPos).toLowerCase();
    return {
      open: true,
      query,
      triggerStart: cursor,
      triggerEnd: caretPos,
    };
  }, [value, caretPos, enabled]);
}
