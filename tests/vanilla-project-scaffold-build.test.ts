import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { defaultProjectScaffoldFiles } from '../workers/main/src/project-scaffold';

describe('vanilla scaffold generated build', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('copies the public app and emits a deploy manifest with binding metadata', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vanilla-scaffold-build-'));
    tempDirs.push(dir);
    const files = defaultProjectScaffoldFiles('Tiny Game', 'vanilla', 'tiny-game');
    for (const file of files) {
      const destination = path.join(dir, file.path.slice(1));
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, file.content);
    }

    const wranglerPath = path.join(dir, 'wrangler.jsonc');
    const wrangler = JSON.parse(readFileSync(wranglerPath, 'utf8'));
    writeFileSync(wranglerPath, `${JSON.stringify({
      ...wrangler,
      vars: { GAME_TITLE: 'Tiny Game' },
      kv_namespaces: [{ binding: 'SCORES', id: 'scores-id' }],
    }, null, 2)}\n`);

    execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: dir, stdio: 'pipe' });

    expect(existsSync(path.join(dir, 'build/client/index.html'))).toBe(true);
    expect(existsSync(path.join(dir, 'build/client/styles.css'))).toBe(true);
    expect(existsSync(path.join(dir, 'build/client/main.js'))).toBe(true);
    expect(readFileSync(path.join(dir, 'build/server/worker.js'), 'utf8')).toContain('env.ASSETS.fetch');
    const manifest = JSON.parse(readFileSync(path.join(dir, 'build/server/wrangler.json'), 'utf8'));
    expect(manifest).toMatchObject({
      main: 'worker.js',
      no_bundle: true,
      rules: [{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }],
      compatibility_date: '2026-06-01',
      assets: { directory: '../client', binding: 'ASSETS' },
      vars: { GAME_TITLE: 'Tiny Game' },
      kv_namespaces: [{ binding: 'SCORES', id: 'scores-id' }],
    });
  });
});
