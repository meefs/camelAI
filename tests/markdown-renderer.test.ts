import { describe, expect, it } from 'vitest';

import { normalizeCodexCitationMarkers } from '@/components/markdown-renderer';

describe('normalizeCodexCitationMarkers', () => {
  it('leaves normal markdown unchanged', () => {
    const input = 'Use [OpenAI](https://openai.com) for details.';
    expect(normalizeCodexCitationMarkers(input)).toBe(input);
  });

  it('strips leaked Codex web-search citation markers', () => {
    expect(
      normalizeCodexCitationMarkers(
        'Web search is working. citeturn1search0',
      ),
    ).toBe('Web search is working. ');
  });

  it('strips multiple leaked citation markers', () => {
    expect(
      normalizeCodexCitationMarkers(
        'First citeturn1search0 and second citeturn1search1 done.',
      ),
    ).toBe('First  and second  done.');
  });
});
