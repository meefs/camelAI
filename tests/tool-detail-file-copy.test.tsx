import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPreviewProvider } from '@/components/chat-preview/preview-context';
import { ReadDetails } from '@/components/tool-call/details/read-details';
import { SearchDetails } from '@/components/tool-call/details/search-details';
import { formatCopyFilePath } from '@/lib/file-path-copy';
import type { PreviewTarget, ToolResultBlock, ToolUseBlock } from '@/types';

const { mockUseAuthData } = vi.hoisted(() => ({
  mockUseAuthData: vi.fn(),
}));

vi.mock('@/hooks/use-auth-data', () => ({
  useAuthData: () => mockUseAuthData(),
}));

const mentionSlugMap = new Map([
  [
    'thread_review_dashboard',
    { kind: 'project' as const, name: 'Thread Review Dashboard' },
  ],
]);

function makeTool(
  name: string,
  input: Record<string, unknown>,
): ToolUseBlock {
  return {
    type: 'tool_use',
    id: `tool_${name}`,
    name,
    input,
  };
}

function makeResult(content: string): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: 'tool_result',
    content,
  };
}

function renderWithPreviewContext(
  children: React.ReactNode,
  overrides?: {
    openPreviewTarget?: (target: PreviewTarget) => void;
  },
) {
  return render(
    <ChatPreviewProvider
      value={{
        workspaceId: 'thread-ws',
        openPreviewTarget: overrides?.openPreviewTarget ?? vi.fn(),
        clearPreviewTarget: vi.fn(),
        formatFilePathForCopy: (target) =>
          formatCopyFilePath(target, { mentionSlugMap }),
      }}
    >
      {children}
    </ChatPreviewProvider>,
  );
}

describe('tool detail file path copying', () => {
  beforeEach(() => {
    mockUseAuthData.mockReset();
    mockUseAuthData.mockReturnValue({
      currentWorkspace: { id: 'other-ws' },
    });
  });

  it('copies read path rows with the project mention slug', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      writable: true,
      value: {
        writeText,
      },
    });

    renderWithPreviewContext(
      <ReadDetails
        tool={makeTool('read', {
          location: 'project',
          project: 'Thread Review Dashboard',
          path: '/plans/phase-2-automation.md',
        })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        '@thread_review_dashboard - /plans/phase-2-automation.md',
      );
    });
  });

  it('copies search result lists with the project mention slug on each line', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      writable: true,
      value: {
        writeText,
      },
    });

    renderWithPreviewContext(
      <SearchDetails
        mode="grep"
        tool={makeTool('grep', {
          location: 'project',
          project: 'Thread Review Dashboard',
          pattern: 'query',
          path: '/src',
        })}
        result={makeResult(
          [
            'Found 2 matches',
            '/src/App.tsx',
            '/src/lib/query.ts:42:const query = true',
          ].join('\n'),
        )}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy list' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        [
          '@thread_review_dashboard - /src/App.tsx',
          '@thread_review_dashboard - /src/lib/query.ts:42:const query = true',
        ].join('\n'),
      );
    });
  });

  it('copies project glob root-level search results with the project mention slug', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      writable: true,
      value: {
        writeText,
      },
    });

    renderWithPreviewContext(
      <SearchDetails
        mode="glob"
        tool={makeTool('glob', {
          location: 'project',
          project: 'Thread Review Dashboard',
          pattern: '*.html',
          path: '/workspace',
        })}
        result={makeResult(
          [
            'Found 2 files',
            'test.html',
            'nested/page.html',
          ].join('\n'),
        )}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy list' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        [
          '@thread_review_dashboard - /test.html',
          '@thread_review_dashboard - /nested/page.html',
        ].join('\n'),
      );
    });
  });

  it('resolves project glob search results against a non-root search path', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      writable: true,
      value: {
        writeText,
      },
    });

    renderWithPreviewContext(
      <SearchDetails
        mode="glob"
        tool={makeTool('glob', {
          location: 'project',
          project: 'Thread Review Dashboard',
          pattern: '*.tsx',
          path: '/src',
        })}
        result={makeResult(
          [
            'Found 2 files',
            'App.tsx',
            'nested/page.tsx',
          ].join('\n'),
        )}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy list' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        [
          '@thread_review_dashboard - /src/App.tsx',
          '@thread_review_dashboard - /src/nested/page.tsx',
        ].join('\n'),
      );
    });
  });

  it('copies project glob root-level filenames with spaces', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      writable: true,
      value: {
        writeText,
      },
    });

    renderWithPreviewContext(
      <SearchDetails
        mode="glob"
        tool={makeTool('glob', {
          location: 'project',
          project: 'Thread Review Dashboard',
          pattern: '*',
          path: '/workspace',
        })}
        result={makeResult(
          [
            'Found 2 files',
            'My Notes.md',
            'nested/page.html',
          ].join('\n'),
        )}
      />,
    );

    expect(screen.getByRole('button', { name: 'My Notes.md' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'nested/page.html' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Copy list' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        [
          '@thread_review_dashboard - /My Notes.md',
          '@thread_review_dashboard - /nested/page.html',
        ].join('\n'),
      );
    });
  });

  it('keeps single project glob filenames with spaces in the file list', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      writable: true,
      value: {
        writeText,
      },
    });

    renderWithPreviewContext(
      <SearchDetails
        mode="glob"
        tool={makeTool('glob', {
          location: 'project',
          project: 'Thread Review Dashboard',
          pattern: '*',
          path: '/workspace',
        })}
        result={makeResult(
          [
            'Found 1 files',
            'My Notes.md',
          ].join('\n'),
        )}
      />,
    );

    expect(screen.getByRole('button', { name: 'Copy list' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy output' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'My Notes.md' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Copy list' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        '@thread_review_dashboard - /My Notes.md',
      );
    });
  });

  it('resolves VM grep search results against the search path before appending suffixes', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      writable: true,
      value: {
        writeText,
      },
    });

    renderWithPreviewContext(
      <SearchDetails
        mode="grep"
        tool={makeTool('grep', {
          location: 'project',
          project: 'Thread Review Dashboard',
          pattern: 'query',
          path: '/src',
        })}
        result={makeResult(
          [
            'Found 1 matches',
            'App.tsx:42:const query = true',
          ].join('\n'),
        )}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy list' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        '@thread_review_dashboard - /src/App.tsx:42:const query = true',
      );
    });
  });

  it('preserves extra colons in VM grep matched text', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      writable: true,
      value: {
        writeText,
      },
    });

    renderWithPreviewContext(
      <SearchDetails
        mode="grep"
        tool={makeTool('grep', {
          location: 'project',
          project: 'Thread Review Dashboard',
          pattern: 'https',
          path: '/src',
        })}
        result={makeResult(
          [
            'Found 1 matches',
            'App.tsx:42:const url = "https://example.com"',
          ].join('\n'),
        )}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy list' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        '@thread_review_dashboard - /src/App.tsx:42:const url = "https://example.com"',
      );
    });
  });

  // Note: single-file grep roots (e.g. grepping `/src/App.tsx` directly, where
  // the result is a bare basename) are intentionally not special-cased — that
  // output is indistinguishable from a directory grep matching a top-level file,
  // and disambiguating it requires a heuristic. We optimize for the common
  // directory-search case; single-file grep resolution is deferred to a follow-up.

  it('opens VM search result links with the resolved project path', () => {
    const openPreviewTarget = vi.fn();

    renderWithPreviewContext(
      <SearchDetails
        mode="glob"
        tool={makeTool('glob', {
          location: 'project',
          project: 'Thread Review Dashboard',
          pattern: '*.tsx',
          path: '/src',
        })}
        result={makeResult(
          [
            'Found 1 files',
            'App.tsx',
          ].join('\n'),
        )}
      />,
      { openPreviewTarget },
    );

    fireEvent.click(screen.getByRole('button', { name: 'App.tsx' }));

    expect(openPreviewTarget).toHaveBeenCalledWith({
      kind: 'file',
      source: 'project',
      workspaceId: 'thread-ws',
      project: 'Thread Review Dashboard',
      path: '/src/App.tsx',
      filename: 'App.tsx',
    });
  });

  it('keeps failed VM grep diagnostics as plain output', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      writable: true,
      value: {
        writeText,
      },
    });

    renderWithPreviewContext(
      <SearchDetails
        mode="grep"
        tool={makeTool('grep', {
          location: 'project',
          project: 'Thread Review Dashboard',
          pattern: 'query',
          path: '/src',
        })}
        result={{
          type: 'tool_result',
          tool_use_id: 'tool_result',
          is_error: true,
          status: 'failed',
          content: 'FileNotFoundError: /workspace/missing',
        }}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Copy list' })).not.toBeInTheDocument();
    expect(screen.getByText('FileNotFoundError: /workspace/missing')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Copy output' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('FileNotFoundError: /workspace/missing');
    });
    expect(writeText).not.toHaveBeenCalledWith(
      expect.stringContaining('@thread_review_dashboard - /src/FileNotFoundError'),
    );
  });

  it('keeps non-match VM grep diagnostic-shaped lines as plain output', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      writable: true,
      value: {
        writeText,
      },
    });

    renderWithPreviewContext(
      <SearchDetails
        mode="grep"
        tool={makeTool('grep', {
          location: 'project',
          project: 'Thread Review Dashboard',
          pattern: 'query',
          path: '/src',
        })}
        result={makeResult('FileNotFoundError: /workspace/missing')}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Copy list' })).not.toBeInTheDocument();
    expect(screen.getByText('FileNotFoundError: /workspace/missing')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Copy output' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('FileNotFoundError: /workspace/missing');
    });
  });

  it('omits project glob bracketed notices from rendered and copied file lists', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      writable: true,
      value: {
        writeText,
      },
    });

    renderWithPreviewContext(
      <SearchDetails
        mode="glob"
        tool={makeTool('glob', {
          location: 'project',
          project: 'Thread Review Dashboard',
          pattern: '*.html',
          path: '/workspace',
        })}
        result={makeResult(
          [
            'Found 2 files',
            'test.html',
            '[1000 results limit reached; narrow your search]',
            'nested/page.html',
          ].join('\n'),
        )}
      />,
    );

    expect(screen.queryByText('[1000 results limit reached; narrow your search]')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Copy list' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        [
          '@thread_review_dashboard - /test.html',
          '@thread_review_dashboard - /nested/page.html',
        ].join('\n'),
      );
    });
  });

  it('keeps project glob no-result sentinels as plain output', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      writable: true,
      value: {
        writeText,
      },
    });

    renderWithPreviewContext(
      <SearchDetails
        mode="glob"
        tool={makeTool('glob', {
          location: 'project',
          project: 'Thread Review Dashboard',
          pattern: '*.html',
          path: '/workspace',
        })}
        result={makeResult('No files found matching pattern')}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Copy list' })).not.toBeInTheDocument();
    expect(screen.getByText('No files found matching pattern')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Copy output' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('No files found matching pattern');
    });
  });
});
