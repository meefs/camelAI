import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const archiveTool = path.resolve(
  'workers/main/analysis-sandbox-assets/archive-tool.py',
);
const temporaryDirectories: string[] = [];
let python = '';

function findPython(): string {
  for (const command of ['python3', 'python']) {
    const result = spawnSync(command, ['--version'], { encoding: 'utf8' });
    if (result.status === 0) return command;
  }
  throw new Error('Python is required for archive-tool tests');
}

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'camelai-archive-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

function createZip(
  archivePath: string,
  entries: Array<{ name: string; content: string; symlink?: boolean }>,
): void {
  const result = spawnSync(
    python,
    [
      '-c',
      [
        'import json, stat, sys, zipfile',
        'archive_path, payload = sys.argv[1], json.loads(sys.argv[2])',
        'with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as archive:',
        '  for entry in payload:',
        '    if entry.get("symlink"):',
        '      info = zipfile.ZipInfo(entry["name"])',
        '      info.create_system = 3',
        '      info.external_attr = (stat.S_IFLNK | 0o777) << 16',
        '      archive.writestr(info, entry["content"])',
        '    else:',
        '      archive.writestr(entry["name"], entry["content"])',
      ].join('\n'),
      archivePath,
      JSON.stringify(entries),
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'failed to create test ZIP');
  }
}

function runArchiveTool(options: {
  action: 'list' | 'read' | 'extract';
  archivePath: string;
  cwd: string;
  entry?: string;
  destination?: string;
  offset?: number;
  limit?: number;
}) {
  const result = spawnSync(python, [archiveTool], {
    cwd: options.cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      CAMELAI_ARCHIVE_ACTION: options.action,
      CAMELAI_ARCHIVE_PATH: options.archivePath,
      CAMELAI_ARCHIVE_ALLOWED_ROOT: path.dirname(options.archivePath),
      CAMELAI_ARCHIVE_ENTRY: options.entry ?? '',
      CAMELAI_ARCHIVE_DESTINATION: options.destination ?? '.',
      CAMELAI_ARCHIVE_OFFSET: String(options.offset ?? 0),
      CAMELAI_ARCHIVE_LIMIT: String(options.limit ?? 200),
      SCRATCH: path.join(options.cwd, '.scratch'),
    },
  });
  const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
  return { ...result, parsed };
}

beforeAll(() => {
  python = findPython();
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('archive-tool', () => {
  it('lists, reads, and extracts a valid ZIP into a project subdirectory', () => {
    const root = makeTemporaryDirectory();
    const uploads = path.join(root, 'uploads');
    const project = path.join(root, 'project');
    mkdirSync(uploads);
    mkdirSync(project);
    const archivePath = path.join(uploads, 'source.zip');
    createZip(archivePath, [
      { name: 'package.json', content: '{"scripts":{"build":"vite build"}}' },
      { name: 'src/index.ts', content: 'export const answer = 42;\n' },
    ]);

    const listed = runArchiveTool({ action: 'list', archivePath, cwd: project });
    expect(listed.status).toBe(0);
    expect(listed.parsed).toMatchObject({
      ok: true,
      action: 'list',
      format: 'zip',
      entryCount: 2,
      fileCount: 2,
      extractable: true,
      hasMore: false,
    });
    expect(listed.parsed.entries).toEqual([
      expect.objectContaining({ path: 'package.json', type: 'file', extractable: true }),
      expect.objectContaining({ path: 'src/index.ts', type: 'file', extractable: true }),
    ]);

    const read = runArchiveTool({
      action: 'read',
      archivePath,
      cwd: project,
      entry: 'package.json',
    });
    expect(read.status).toBe(0);
    expect(read.parsed).toMatchObject({
      ok: true,
      action: 'read',
      entry: 'package.json',
      content: '{"scripts":{"build":"vite build"}}',
      truncated: false,
    });

    const extracted = runArchiveTool({
      action: 'extract',
      archivePath,
      cwd: project,
      destination: 'imported',
    });
    expect(extracted.status).toBe(0);
    expect(extracted.parsed).toMatchObject({
      ok: true,
      action: 'extract',
      destination: 'imported',
      entryCount: 2,
    });
    expect(readFileSync(path.join(project, 'imported/package.json'), 'utf8')).toBe(
      '{"scripts":{"build":"vite build"}}',
    );
    expect(readFileSync(path.join(project, 'imported/src/index.ts'), 'utf8')).toBe(
      'export const answer = 42;\n',
    );
  });

  it('reports traversal entries and refuses extraction without writing outside the project', () => {
    const root = makeTemporaryDirectory();
    const uploads = path.join(root, 'uploads');
    const project = path.join(root, 'project');
    mkdirSync(uploads);
    mkdirSync(project);
    writeFileSync(path.join(project, 'existing.txt'), 'keep');
    const archivePath = path.join(uploads, 'traversal.zip');
    createZip(archivePath, [
      { name: '../escape.txt', content: 'escaped' },
      { name: 'safe.txt', content: 'safe' },
    ]);

    const listed = runArchiveTool({ action: 'list', archivePath, cwd: project });
    expect(listed.status).toBe(0);
    expect(listed.parsed.extractable).toBe(false);
    expect(listed.parsed.issues).toEqual(
      expect.arrayContaining([expect.stringContaining('parent traversal is not allowed')]),
    );

    const extracted = runArchiveTool({ action: 'extract', archivePath, cwd: project });
    expect(extracted.status).toBe(1);
    expect(extracted.parsed).toMatchObject({ ok: false });
    expect(extracted.parsed.error).toContain('not safe to extract');
    expect(readFileSync(path.join(project, 'existing.txt'), 'utf8')).toBe('keep');
    expect(() => readFileSync(path.join(root, 'escape.txt'), 'utf8')).toThrow();
    expect(() => readFileSync(path.join(project, 'safe.txt'), 'utf8')).toThrow();
  });

  it('identifies symlinks during inspection and rejects them during extraction', () => {
    const root = makeTemporaryDirectory();
    const uploads = path.join(root, 'uploads');
    const project = path.join(root, 'project');
    mkdirSync(uploads);
    mkdirSync(project);
    const archivePath = path.join(uploads, 'symlink.zip');
    createZip(archivePath, [
      { name: 'link', content: '../../outside', symlink: true },
    ]);

    const listed = runArchiveTool({ action: 'list', archivePath, cwd: project });
    expect(listed.status).toBe(0);
    expect(listed.parsed).toMatchObject({ extractable: false, issueCount: 1 });
    expect(listed.parsed.entries).toEqual([
      expect.objectContaining({
        path: 'link',
        type: 'symlink',
        extractable: false,
        issues: ['symbolic links are not allowed'],
      }),
    ]);

    const extracted = runArchiveTool({ action: 'extract', archivePath, cwd: project });
    expect(extracted.status).toBe(1);
    expect(extracted.parsed.error).toContain('symbolic links are not allowed');
  });

  it('rejects file and parent-path conflicts regardless of ZIP entry order', () => {
    const root = makeTemporaryDirectory();
    const uploads = path.join(root, 'uploads');
    const project = path.join(root, 'project');
    mkdirSync(uploads);
    mkdirSync(project);
    const archivePath = path.join(uploads, 'conflict.zip');
    createZip(archivePath, [
      { name: 'folder/child.txt', content: 'child first' },
      { name: 'folder', content: 'parent file second' },
    ]);

    const listed = runArchiveTool({ action: 'list', archivePath, cwd: project });
    expect(listed.status).toBe(0);
    expect(listed.parsed.extractable).toBe(false);
    expect(listed.parsed.issues).toEqual(
      expect.arrayContaining([expect.stringContaining("parent path 'folder' is also a file")]),
    );

    const extracted = runArchiveTool({ action: 'extract', archivePath, cwd: project });
    expect(extracted.status).toBe(1);
    expect(extracted.parsed.error).toContain("parent path 'folder' is also a file");
  });
});
