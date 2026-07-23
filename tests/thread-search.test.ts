import { describe, expect, it } from 'vitest';
import {
  THREAD_ASK_LOG_ENTRY_MAX_CHARS,
  THREAD_ASK_LOG_MAX_BYTES,
  appendToThreadAskLog,
  buildThreadSearchMatch,
  canonicalizeThreadSearchQuery,
  parseThreadSearchTerms,
} from '@/lib/thread-search';

describe('canonicalizeThreadSearchQuery', () => {
  it('caps by Unicode code point without splitting an emoji surrogate pair', () => {
    const query = `${'a'.repeat(199)}😀`;
    const canonical = canonicalizeThreadSearchQuery(query);

    expect(canonical).toBe(query);
    expect(Array.from(canonical)).toHaveLength(200);
    expect(new URLSearchParams({ q: canonical }).get('q')).toBe(canonical);
  });

  it('matches URLSearchParams replacement of unpaired surrogates', () => {
    const query = `before\ud83dafter`;
    const canonical = canonicalizeThreadSearchQuery(query);

    expect(canonical).toBe('before\ufffdafter');
    expect(new URLSearchParams({ q: query }).get('q')).toBe(canonical);
  });
});

describe('parseThreadSearchTerms', () => {
  it('trims, splits, deduplicates, and caps terms', () => {
    expect(parseThreadSearchTerms('  One\n two ONE three four five six  ')).toEqual([
      'One',
      'two',
      'three',
      'four',
      'five',
    ]);
  });

  it('caps the query before splitting it', () => {
    expect(parseThreadSearchTerms(`${'a'.repeat(199)} bc`)).toEqual([
      'a'.repeat(199),
    ]);
  });

  it('returns no terms for an empty query', () => {
    expect(parseThreadSearchTerms(' \n\t ')).toEqual([]);
    expect(parseThreadSearchTerms(null)).toEqual([]);
  });
});

describe('buildThreadSearchMatch', () => {
  it('prioritizes title matches and omits their snippet', () => {
    expect(
      buildThreadSearchMatch(
        {
          title: 'Pomodoro timer',
          first_user_message: 'The message also contains pomodoro',
        },
        ['pomodoro'],
      ),
    ).toEqual({
      field: 'title',
      snippet: null,
      matchStart: 0,
      matchEnd: 0,
    });
  });

  it('uses field priority and the first matching query term', () => {
    const match = buildThreadSearchMatch(
      {
        title: 'Unrelated',
        first_user_message: 'The opening message contains the SECOND query term.',
        last_user_message: 'The last message contains first.',
      },
      ['first', 'second'],
    );

    expect(match?.field).toBe('first_user_message');
    expect(match?.snippet?.slice(match.matchStart, match.matchEnd)).toBe('SECOND');
  });

  it('collapses whitespace, clips on word boundaries, and reports exact ranges', () => {
    const before = 'alpha '.repeat(12);
    const after = ' omega'.repeat(25);
    const match = buildThreadSearchMatch(
      {
        title: 'Unrelated',
        user_ask_log: `${before}\n\tNeedle${after}`,
      },
      ['needle'],
    );

    expect(match?.field).toBe('user_ask_log');
    expect(match?.snippet?.startsWith('…')).toBe(true);
    expect(match?.snippet?.endsWith('…')).toBe(true);
    expect(match?.snippet?.slice(match.matchStart, match.matchEnd)).toBe('Needle');
    expect(match?.snippet).not.toMatch(/\s{2,}/);
  });

  it('falls back to assistant summaries after user-authored fields', () => {
    expect(
      buildThreadSearchMatch(
        {
          title: 'Unrelated',
          last_assistant_summary: 'Implemented the authentication fix.',
        },
        ['authentication'],
      )?.field,
    ).toBe('last_assistant_summary');
  });

  it('maps a lowercased match range back to the original string', () => {
    const match = buildThreadSearchMatch(
      {
        title: 'Unrelated',
        first_user_message: 'İ needle',
      },
      ['needle'],
    );

    expect(match?.snippet?.slice(match.matchStart, match.matchEnd)).toBe(
      'needle',
    );
  });

  it('returns null when no field matches', () => {
    expect(buildThreadSearchMatch({ title: 'Unrelated' }, ['missing'])).toBeNull();
  });
});

describe('appendToThreadAskLog', () => {
  it('preserves the existing log for null or blank messages', () => {
    expect(appendToThreadAskLog('existing', null)).toBe('existing');
    expect(appendToThreadAskLog('existing', ' \n\t ')).toBe('existing');
  });

  it('collapses whitespace and appends to a null or existing log', () => {
    expect(appendToThreadAskLog(null, '  first\n ask  ')).toBe('first ask');
    expect(appendToThreadAskLog('first ask', ' second\t ask ')).toBe(
      'first ask\nsecond ask',
    );
  });

  it('truncates each entry and suppresses consecutive duplicates', () => {
    const entry = appendToThreadAskLog(null, 'x'.repeat(700));
    expect(entry).toHaveLength(THREAD_ASK_LOG_ENTRY_MAX_CHARS);
    expect(appendToThreadAskLog(entry, 'x'.repeat(700))).toBe(entry);
  });

  it('drops oldest entries to preserve the cap and newest content', () => {
    let log: string | null = null;
    for (let index = 0; index < 30; index += 1) {
      log = appendToThreadAskLog(
        log,
        `entry-${index.toString().padStart(2, '0')}-${'x'.repeat(490)}`,
      );
    }

    expect(new TextEncoder().encode(log!).byteLength).toBeLessThanOrEqual(
      THREAD_ASK_LOG_MAX_BYTES,
    );
    expect(log).not.toContain('entry-00-');
    expect(log).toContain('entry-29-');
  });

  it('enforces the byte ceiling for multibyte input', () => {
    let log: string | null = null;
    for (let index = 0; index < 20; index += 1) {
      log = appendToThreadAskLog(
        log,
        `条目-${index.toString().padStart(2, '0')}-${'界'.repeat(490)}`,
      );
    }

    expect(new TextEncoder().encode(log!).byteLength).toBeLessThanOrEqual(
      THREAD_ASK_LOG_MAX_BYTES,
    );
    expect(log).not.toContain('条目-00-');
    expect(log).toContain('条目-19-');
  });

  it('repairs an oversized single-line log to the byte ceiling', () => {
    const log = appendToThreadAskLog('界'.repeat(THREAD_ASK_LOG_MAX_BYTES), null);

    expect(new TextEncoder().encode(log!).byteLength).toBeLessThanOrEqual(
      THREAD_ASK_LOG_MAX_BYTES,
    );
  });
});
