import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SourcePreview } from '@/components/chat-file-preview/code-preview';
import { FilePreviewContent } from '@/components/chat-file-preview/file-preview-content';

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

  it('uses text highlighting fallback for plain text filenames', async () => {
    const { container } = render(
      <SourcePreview
        code={'first line\nsecond line'}
        filename="notes.txt"
        layout="panel"
        truncated={false}
        totalLines={2}
      />
    );

    const lines = container.querySelectorAll('.source-preview-lines .line');
    expect(lines).toHaveLength(2);

    await waitFor(() => {
      expect(codeToHtmlMock).toHaveBeenCalledWith(
        'first line\nsecond line',
        expect.objectContaining({ lang: 'text' })
      );
    });
  });

  it('renders plain text file previews through SourcePreview', async () => {
    const originalFetch = globalThis.fetch;
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue('hello\nfrom txt'),
      }),
    });

    try {
      const { container } = render(
        <FilePreviewContent
          filename="notes.txt"
          previewUrl="/preview/notes.txt"
          contentType="text/plain"
          layout="panel"
        />
      );

      await waitFor(() => {
        const lines = container.querySelectorAll('.source-preview-lines .line');
        expect(lines).toHaveLength(2);
      });
    } finally {
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        writable: true,
        value: originalFetch,
      });
    }
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
