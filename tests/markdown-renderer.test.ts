import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createElement } from 'react';

import { MarkdownRenderer, normalizeProviderCitationMarkers } from '@/components/markdown-renderer';
import { ReportMarkdownCell } from '@/components/chat-file-preview/notebook-preview/report-markdown-cell';
import type { AtMentionConnection, Integration } from '@/types';

function integration(fields: Pick<Integration, 'id' | 'integration_type' | 'name'>): AtMentionConnection {
  return {
    kind: 'connection',
    category: 'databases',
    auth_method: 'api_key',
    config: {},
    created_by: 'user',
    created_at: 0,
    updated_at: 0,
    has_credentials: true,
    ...fields,
  };
}

describe('normalizeProviderCitationMarkers', () => {
  it('leaves normal markdown unchanged', () => {
    const input = 'Use [OpenAI](https://openai.com) for details.';
    expect(normalizeProviderCitationMarkers(input)).toBe(input);
  });

  it('strips leaked provider web-search citation markers', () => {
    expect(
      normalizeProviderCitationMarkers(
        'Web search is working. citeturn1search0',
      ),
    ).toBe('Web search is working. ');
  });

  it('strips multiple leaked citation markers', () => {
    expect(
      normalizeProviderCitationMarkers(
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

  it('scopes annotation ids to each mention occurrence', () => {
    render(
      createElement(MarkdownRenderer, {
        content: '@camel then @camel',
        mentionSlugMap: new Map([
          ['camel', integration({ id: 'current', integration_type: 'postgres', name: 'Camel' })],
        ]),
        annotatedMentions: [
          { slug: 'camel', id: 'old' },
          { slug: 'camel', id: 'current' },
        ],
      }),
    );

    const chips = screen.getAllByText('@camel');
    expect(chips[0]).toHaveClass('bg-muted/60');
    expect(chips[1]).toHaveClass('bg-muted');
    expect(chips[1]).not.toHaveClass('bg-muted/60');
  });

  it('renders project mention chips and honors annotated ids', () => {
    render(
      createElement(MarkdownRenderer, {
        content: '@camel_site then @camel_site',
        mentionSlugMap: new Map([
          ['camel_site', {
            kind: 'project',
            id: 'ca-workspace-camel-site',
            name: 'camel-site',
            description: 'Marketing site rebuild',
          } as const],
        ]),
        annotatedMentions: [
          { slug: 'camel_site', id: 'old-project' },
          { slug: 'camel_site', id: 'ca-workspace-camel-site' },
        ],
      }),
    );

    const chips = screen.getAllByText('@camel_site');
    expect(chips[0]).toHaveClass('bg-muted/60');
    expect(chips[1]).toHaveClass('bg-muted');
    expect(chips[1]).not.toHaveClass('bg-muted/60');
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

describe('MarkdownRenderer inline HTML', () => {
  it('keeps raw HTML disabled by default', () => {
    const { container } = render(
      createElement(MarkdownRenderer, {
        content: '<mark>highlight</mark>',
      }),
    );

    expect(container.querySelector('mark')).not.toBeInTheDocument();
    expect(container).toHaveTextContent('<mark>highlight</mark>');
  });

  it('renders allowed inline HTML when enabled', () => {
    const { container } = render(
      createElement(MarkdownRenderer, {
        content: '<mark>highlight</mark> H<sub>2</sub> x<sup>3</sup>',
        allowInlineHtml: true,
      }),
    );

    expect(container.querySelector('mark')).toHaveTextContent('highlight');
    expect(container.querySelector('sub')).toHaveTextContent('2');
    expect(container.querySelector('sup')).toHaveTextContent('3');
  });

  it('sanitizes unsafe inline HTML when enabled', () => {
    const { container } = render(
      createElement(MarkdownRenderer, {
        content: '<script>alert(1)</script><mark onclick="alert(2)">highlight</mark>',
        allowInlineHtml: true,
      }),
    );

    const mark = container.querySelector('mark');
    expect(container.querySelector('script')).not.toBeInTheDocument();
    expect(mark).toHaveTextContent('highlight');
    expect(mark).not.toHaveAttribute('onclick');
  });
});

describe('ReportMarkdownCell heading ids', () => {
  it('skips raw HTML headings when assigning TOC ids', () => {
    const { container } = render(
      createElement(ReportMarkdownCell, {
        source: ['## First', '', '<h2>Raw HTML</h2>', '', '## Second'].join('\n'),
        entries: [
          { id: 'toc-0', text: 'First', level: 2, cellIndex: 0 },
          { id: 'toc-1', text: 'Second', level: 2, cellIndex: 0 },
        ],
      }),
    );

    const headings = Array.from(container.querySelectorAll('h2'));
    expect(headings.map((heading) => [heading.textContent, heading.id])).toEqual([
      ['First', 'toc-0'],
      ['Raw HTML', ''],
      ['Second', 'toc-1'],
    ]);
  });
});
