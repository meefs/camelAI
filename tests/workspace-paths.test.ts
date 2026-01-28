import { describe, expect, it, vi } from 'vitest';

// Mock cloudflare-specific modules before importing workspace utils
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
}));
vi.mock('@cloudflare/containers', () => ({
  Container: class {},
}));

const {
  normalizeWhitespace,
  hasNormalizableWhitespace,
  normalizeWorkspacePath,
  toContainerPath,
  resolveContainerPath,
} = await import('@/routes/api/workspaces.utils');

describe('normalizeWhitespace', () => {
  it('replaces non-breaking space (U+00A0) with regular space', () => {
    const input = 'Screenshot 2026-01-23 at 12.39.52\u00a0PM.png';
    expect(normalizeWhitespace(input)).toBe(
      'Screenshot 2026-01-23 at 12.39.52 PM.png'
    );
  });

  it('replaces figure space (U+2007) with regular space', () => {
    expect(normalizeWhitespace('a\u2007b')).toBe('a b');
  });

  it('replaces narrow no-break space (U+202F) with regular space', () => {
    expect(normalizeWhitespace('a\u202Fb')).toBe('a b');
  });

  it('handles multiple NBSP in one string', () => {
    expect(normalizeWhitespace('\u00a0foo\u00a0bar\u00a0')).toBe(' foo bar ');
  });

  it('leaves regular spaces untouched', () => {
    expect(normalizeWhitespace('hello world')).toBe('hello world');
  });

  it('returns empty string unchanged', () => {
    expect(normalizeWhitespace('')).toBe('');
  });

  it('handles mixed regular and non-breaking spaces (macOS screenshot)', () => {
    const input = 'Screenshot 2026-01-23 at 12.39.52\u00a0PM.png';
    const result = normalizeWhitespace(input);
    expect(result).toBe('Screenshot 2026-01-23 at 12.39.52 PM.png');
    for (const char of result) {
      if (/\s/.test(char)) {
        expect(char.charCodeAt(0)).toBe(0x20);
      }
    }
  });
});

describe('hasNormalizableWhitespace', () => {
  it('returns true for NBSP', () => {
    expect(hasNormalizableWhitespace('foo\u00a0bar')).toBe(true);
  });

  it('returns true for regular space (triggers resolution attempt)', () => {
    expect(hasNormalizableWhitespace('foo bar')).toBe(true);
  });

  it('returns false for paths without any spaces', () => {
    expect(hasNormalizableWhitespace('/app/index.html')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(hasNormalizableWhitespace('')).toBe(false);
  });
});

describe('normalizeWorkspacePath', () => {
  it('returns root for empty input', () => {
    expect(normalizeWorkspacePath('')).toBe('/');
    expect(normalizeWorkspacePath(null)).toBe('/');
    expect(normalizeWorkspacePath(undefined)).toBe('/');
  });

  it('preserves simple paths', () => {
    expect(normalizeWorkspacePath('/app/index.html')).toBe('/app/index.html');
  });

  it('adds leading slash', () => {
    expect(normalizeWorkspacePath('app/index.html')).toBe('/app/index.html');
  });

  it('resolves dot segments', () => {
    expect(normalizeWorkspacePath('/app/./index.html')).toBe('/app/index.html');
  });

  it('resolves parent segments', () => {
    expect(normalizeWorkspacePath('/app/sub/../index.html')).toBe(
      '/app/index.html'
    );
  });

  it('throws on traversal past root', () => {
    expect(() => normalizeWorkspacePath('/../etc/passwd')).toThrow(
      'Path escapes workspace root'
    );
  });

  it('preserves spaces in filenames', () => {
    expect(normalizeWorkspacePath('/Screenshot 2026-01-23.png')).toBe(
      '/Screenshot 2026-01-23.png'
    );
  });

  it('preserves non-breaking spaces in filenames', () => {
    expect(normalizeWorkspacePath('/file\u00a0name.txt')).toBe(
      '/file\u00a0name.txt'
    );
  });
});

describe('toContainerPath', () => {
  it('maps root to /home/claude', () => {
    expect(toContainerPath('/')).toBe('/home/claude');
  });

  it('prepends /home/claude to workspace paths', () => {
    expect(toContainerPath('/app/index.html')).toBe(
      '/home/claude/app/index.html'
    );
  });

  it('preserves spaces in container paths', () => {
    expect(toContainerPath('/Screenshot 2026-01-23.png')).toBe(
      '/home/claude/Screenshot 2026-01-23.png'
    );
  });
});

describe('resolveContainerPath', () => {
  function mockContainer(
    filesByDir: Record<
      string,
      Array<{ name: string; type: string; absolutePath?: string }>
    >
  ) {
    return {
      listFiles: vi.fn(async (dirPath: string) => {
        const files = filesByDir[dirPath];
        if (!files) {
          throw new Error(`ENOENT: no such directory '${dirPath}'`);
        }
        return { files, count: files.length };
      }),
    } as unknown as Parameters<typeof resolveContainerPath>[0];
  }

  it('returns null for paths without spaces (no resolution needed)', async () => {
    const container = mockContainer({});
    const result = await resolveContainerPath(container, '/app/index.html');
    expect(result).toBeNull();
    expect(container.listFiles).not.toHaveBeenCalled();
  });

  it('resolves macOS screenshot NBSP filename via directory listing', async () => {
    const container = mockContainer({
      '/home/claude': [
        {
          name: 'Screenshot 2026-01-23 at 12.39.52\u00a0PM.png',
          type: 'file',
        },
      ],
    });

    // Tool call reports path with regular space
    const result = await resolveContainerPath(
      container,
      '/Screenshot 2026-01-23 at 12.39.52 PM.png'
    );

    expect(result).toBe(
      '/home/claude/Screenshot 2026-01-23 at 12.39.52\u00a0PM.png'
    );
  });

  it('prefers exact match over normalized match', async () => {
    const container = mockContainer({
      '/home/claude': [
        { name: 'my file.txt', type: 'file' },
        { name: 'my\u00a0file.txt', type: 'file' },
      ],
    });

    const result = await resolveContainerPath(container, '/my file.txt');
    expect(result).toBe('/home/claude/my file.txt');
  });

  it('returns null when no match found', async () => {
    const container = mockContainer({
      '/home/claude': [{ name: 'other-file.txt', type: 'file' }],
    });

    const result = await resolveContainerPath(
      container,
      '/nonexistent file.txt'
    );
    expect(result).toBeNull();
  });

  it('returns null when multiple ambiguous normalized matches exist', async () => {
    const container = mockContainer({
      '/home/claude': [
        { name: 'file\u00a0name.txt', type: 'file' },
        { name: 'file\u202fname.txt', type: 'file' },
      ],
    });

    const result = await resolveContainerPath(container, '/file name.txt');
    expect(result).toBeNull();
  });

  it('resolves nested paths segment by segment', async () => {
    const container = mockContainer({
      '/home/claude': [{ name: 'my\u00a0folder', type: 'directory' }],
      '/home/claude/my\u00a0folder': [
        { name: 'my\u00a0file.txt', type: 'file' },
      ],
    });

    const result = await resolveContainerPath(
      container,
      '/my folder/my file.txt'
    );
    expect(result).toBe('/home/claude/my\u00a0folder/my\u00a0file.txt');
  });

  it('returns null if intermediate segment is not a directory', async () => {
    const container = mockContainer({
      '/home/claude': [{ name: 'not-a-dir', type: 'file' }],
    });

    const result = await resolveContainerPath(
      container,
      '/not-a-dir/child.txt'
    );
    expect(result).toBeNull();
  });

  it('returns /home/claude for root path', async () => {
    const container = mockContainer({});
    const result = await resolveContainerPath(container, '/');
    expect(result).toBe('/home/claude');
  });

  it('returns null when listFiles throws', async () => {
    const container = mockContainer({});
    const result = await resolveContainerPath(
      container,
      '/some dir/file.txt'
    );
    expect(result).toBeNull();
  });

  it('uses absolutePath from listing entry when available', async () => {
    const container = mockContainer({
      '/home/claude': [
        {
          name: 'Screenshot\u00a0PM.png',
          type: 'file',
          absolutePath: '/home/claude/Screenshot\u00a0PM.png',
        },
      ],
    });

    const result = await resolveContainerPath(
      container,
      '/Screenshot PM.png'
    );
    expect(result).toBe('/home/claude/Screenshot\u00a0PM.png');
  });
});
