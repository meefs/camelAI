import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createElement } from 'react';

import { MarkdownRenderer, normalizeCodexCitationMarkers } from '@/components/markdown-renderer';

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

describe('MarkdownRenderer mention chips', () => {
  it('renders stale annotated mentions as deleted chips', () => {
    render(
      createElement(MarkdownRenderer, {
        content: 'Use @camel now',
        mentionSlugMap: new Map(),
        annotatedMentions: [{ slug: 'camel', id: null }],
      }),
    );

    expect(screen.getByText('@camel')).toHaveClass('bg-muted/60');
  });

  it('leaves unmatched non-annotated @words as plain text', () => {
    render(
      createElement(MarkdownRenderer, {
        content: 'Use @random now',
        mentionSlugMap: new Map(),
      }),
    );

    expect(screen.queryByText('@random')).not.toBeInTheDocument();
    expect(screen.getByText('Use @random now')).toBeInTheDocument();
  });
});
