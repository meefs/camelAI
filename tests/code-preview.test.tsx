import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SourcePreview } from '@/components/chat-file-preview/code-preview';

const codeToHtmlMock = vi.hoisted(() =>
  vi.fn(() => new Promise<string>(() => {}))
);

vi.mock('@/lib/shiki-config', () => ({
  codeToHtml: codeToHtmlMock,
  SHIKI_DEFAULT_THEMES: {
    light: 'github-light',
    dark: 'github-dark',
  },
  SUPPORTED_LANGUAGES: new Set(['javascript', 'markdown']),
}));

describe('SourcePreview', () => {
  beforeEach(() => {
    codeToHtmlMock.mockReset();
    codeToHtmlMock.mockImplementation(() => new Promise<string>(() => {}));
  });

  it('renders line-numbered fallback content before highlighting resolves', () => {
    const { container } = render(
      <SourcePreview
        code={'const value = 1;\n\nconsole.log(value);'}
        filename="example.js"
        layout="panel"
        truncated={false}
        totalLines={3}
      />
    );

    const lines = container.querySelectorAll('.source-preview-lines .line');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toHaveTextContent('const value = 1;');
    expect(lines[1]?.textContent).toBe('\u00a0');
    expect(lines[2]).toHaveTextContent('console.log(value);');
  });

  it('renders Shiki-like highlighted HTML with source line elements', async () => {
    codeToHtmlMock.mockResolvedValueOnce(
      '<pre class="shiki"><code><span class="line">line 1</span>\n<span class="line">line 2</span></code></pre>'
    );

    const { container } = render(
      <SourcePreview
        code={'line 1\nline 2'}
        filename="README.md"
        layout="panel"
        truncated={false}
        totalLines={2}
        languageOverride="markdown"
      />
    );

    await waitFor(() => {
      const highlightedPre = container.querySelector('.source-preview-lines .shiki');
      expect(highlightedPre).not.toBeNull();
    });

    const lines = container.querySelectorAll('.source-preview-lines .line');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toHaveTextContent('line 1');
    expect(lines[1]).toHaveTextContent('line 2');
  });

  it('does not apply horizontal-scroll-only classes to the source wrapper', () => {
    const { container } = render(
      <SourcePreview
        code="https://example.com/a/really/long/url/that/should/wrap/in/source/preview"
        filename="README.md"
        layout="panel"
        truncated={false}
        totalLines={1}
        languageOverride="markdown"
      />
    );

    const sourceWrapper = container.querySelector('.source-preview-lines');
    expect(sourceWrapper).not.toBeNull();
    expect(sourceWrapper?.className).not.toContain('overflow-x-auto');
    expect(sourceWrapper?.className).not.toContain('min-w-max');
  });
});
