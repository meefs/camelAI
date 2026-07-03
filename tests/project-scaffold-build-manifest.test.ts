import { execFileSync } from 'node:child_process';
import {
  chmodSync,
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

// Executes the react-router scaffold's generated /scripts/build-manifest.mjs against a
// fixture project with a stub esbuild, and asserts the deploy manifest and esbuild
// invocation. This guards the DO-binding regression where the generated build discarded
// the wrangler.jsonc `main` worker module and dropped durable_objects/migrations/vars
// from build/server/wrangler.json.

const STUB_ESBUILD = [
  '#!/usr/bin/env node',
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  'const args = process.argv.slice(2);',
  'fs.writeFileSync("esbuild-args.json", JSON.stringify(args, null, 2));',
  'const outArg = args.find((arg) => arg.startsWith("--outfile="));',
  'if (outArg) {',
  '  const outfile = outArg.slice("--outfile=".length);',
  '  fs.mkdirSync(path.dirname(outfile), { recursive: true });',
  '  fs.writeFileSync(outfile, "// stub bundle\\n");',
  '}',
  '',
].join('\n');

function generatedScaffoldScript(
  template: 'react-router' | 'worker',
  scriptPath: string,
): string {
  const files = defaultProjectScaffoldFiles('Demo App', template, 'demo-app');
  const file = files.find((candidate) => candidate.path === scriptPath);
  if (!file) throw new Error(`scaffold is missing ${scriptPath}`);
  return file.content;
}

function generatedBuildManifestScript(): string {
  return generatedScaffoldScript('react-router', '/scripts/build-manifest.mjs');
}

interface RunResult {
  status: number;
  stderr: string;
}

function setupProject(dir: string, wranglerConfig: Record<string, unknown>): void {
  mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(path.join(dir, 'scripts', 'build-manifest.mjs'), generatedBuildManifestScript());
  writeFileSync(path.join(dir, 'wrangler.jsonc'), `${JSON.stringify(wranglerConfig, null, 2)}\n`);
  const stubPath = path.join(dir, 'node_modules', '.bin', 'esbuild');
  writeFileSync(stubPath, STUB_ESBUILD);
  chmodSync(stubPath, 0o755);
}

function runBuildManifest(dir: string): RunResult {
  try {
    execFileSync(process.execPath, ['scripts/build-manifest.mjs'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stderr?: string };
    return { status: failure.status ?? 1, stderr: failure.stderr ?? '' };
  }
}

function readManifest(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(dir, 'build', 'server', 'wrangler.json'), 'utf8'));
}

function readEsbuildArgs(dir: string): string[] {
  return JSON.parse(readFileSync(path.join(dir, 'esbuild-args.json'), 'utf8'));
}

describe('react-router scaffold build-manifest.mjs (generated script execution)', () => {
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-build-manifest-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bundles config.main as the worker entry and passes through DO config to the manifest', () => {
    const dir = makeTempDir();
    setupProject(dir, {
      name: 'demo-app',
      main: './workers/app.ts',
      compatibility_date: '2026-06-01',
      compatibility_flags: ['nodejs_compat'],
      assets: { directory: './public/', binding: 'ASSETS' },
      durable_objects: {
        bindings: [{ name: 'LEADERBOARD_DO', class_name: 'LeaderboardDO' }],
      },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['LeaderboardDO'] }],
      bindings: [{ type: 'plain_text', name: 'EXISTING', text: 'kept' }],
      vars: { APP_TITLE: 'Space Match', MAX_PLAYERS: 8 },
      kv_namespaces: [{ binding: 'SCORES_KV', id: 'kv-1' }],
      r2_buckets: [{ binding: 'ASSETS_BUCKET', bucket_name: 'space-assets' }],
    });

    const result = runBuildManifest(dir);
    expect(result.status).toBe(0);

    const esbuildArgs = readEsbuildArgs(dir);
    expect(esbuildArgs[0]).toBe('./workers/app.ts');
    expect(esbuildArgs).toContain('--alias:virtual:react-router/server-build=./build/server/index.js');
    expect(esbuildArgs).toContain('--define:import.meta.env.MODE="production"');
    expect(esbuildArgs).toContain('--outfile=build/server/worker.js');
    expect(esbuildArgs).toContain('--external:cloudflare:*');

    const manifest = readManifest(dir);
    expect(manifest).toMatchObject({
      name: 'demo-app',
      main_module: 'worker.js',
      compatibility_date: '2026-06-01',
      compatibility_flags: ['nodejs_compat'],
      assets: { directory: '../client', binding: 'ASSETS' },
      durable_objects: {
        bindings: [{ name: 'LEADERBOARD_DO', class_name: 'LeaderboardDO' }],
      },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['LeaderboardDO'] }],
      // Idiomatic KV/R2 arrays are forwarded verbatim; the deploy pipeline
      // (project-worker-bundle) lifts them into typed bindings.
      kv_namespaces: [{ binding: 'SCORES_KV', id: 'kv-1' }],
      r2_buckets: [{ binding: 'ASSETS_BUCKET', bucket_name: 'space-assets' }],
    });
    // vars become env-var bindings (merged after any explicit config.bindings);
    // a top-level vars key would be a no-op on the direct-deploy path.
    expect(manifest.bindings).toEqual([
      { type: 'plain_text', name: 'EXISTING', text: 'kept' },
      { type: 'plain_text', name: 'APP_TITLE', text: 'Space Match' },
      { type: 'json', name: 'MAX_PLAYERS', json: 8 },
    ]);
    expect(manifest).not.toHaveProperty('vars');
  });

  it('keeps the generated-wrapper path when main is absent and no DO config is declared', () => {
    const dir = makeTempDir();
    setupProject(dir, {
      name: 'demo-app',
      compatibility_date: '2026-06-01',
      compatibility_flags: ['nodejs_compat'],
      assets: { directory: './public/', binding: 'ASSETS' },
    });

    const result = runBuildManifest(dir);
    expect(result.status).toBe(0);

    const esbuildArgs = readEsbuildArgs(dir);
    expect(esbuildArgs[0]).toBe('build/server/_cf_worker_entry.js');
    expect(esbuildArgs.join(' ')).not.toContain('--alias:virtual:react-router/server-build');
    // The temporary wrapper entry is cleaned up after bundling.
    expect(existsSync(path.join(dir, 'build', 'server', '_cf_worker_entry.js'))).toBe(false);

    const manifest = readManifest(dir);
    expect(Object.keys(manifest).sort()).toEqual([
      'assets',
      'compatibility_date',
      'compatibility_flags',
      'main_module',
      'name',
    ]);
  });

  it('fails loudly when Durable Objects are declared without a main worker module', () => {
    const dir = makeTempDir();
    setupProject(dir, {
      name: 'demo-app',
      compatibility_date: '2026-06-01',
      durable_objects: {
        bindings: [{ name: 'LEADERBOARD_DO', class_name: 'LeaderboardDO' }],
      },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['LeaderboardDO'] }],
    });

    const result = runBuildManifest(dir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'wrangler.jsonc declares Durable Objects but no main worker module exports their classes',
    );
    expect(result.stderr).toContain('./workers/app.ts');
    expect(existsSync(path.join(dir, 'build', 'server', 'wrangler.json'))).toBe(false);
  });
});

describe('minimal worker scaffold write-build-manifest.mjs (generated script execution)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function setupWorkerProject(wranglerConfig: Record<string, unknown>): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-write-manifest-'));
    tempDirs.push(dir);
    mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    writeFileSync(
      path.join(dir, 'scripts', 'write-build-manifest.mjs'),
      generatedScaffoldScript('worker', '/scripts/write-build-manifest.mjs'),
    );
    writeFileSync(path.join(dir, 'wrangler.jsonc'), `${JSON.stringify(wranglerConfig, null, 2)}\n`);
    return dir;
  }

  it('spreads the config, drops main, and converts vars into env-var bindings', () => {
    const dir = setupWorkerProject({
      name: 'demo-app',
      main: 'src/index.ts',
      compatibility_date: '2026-06-01',
      durable_objects: {
        bindings: [{ name: 'COUNTER_DO', class_name: 'CounterDO' }],
      },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['CounterDO'] }],
      bindings: [{ type: 'plain_text', name: 'EXISTING', text: 'kept' }],
      vars: { APP_TITLE: 'Demo API', MAX_ITEMS: 5 },
    });

    execFileSync(process.execPath, ['scripts/write-build-manifest.mjs'], {
      cwd: dir,
      encoding: 'utf8',
    });

    const manifest = readManifest(dir);
    expect(manifest).toMatchObject({
      name: 'demo-app',
      main_module: 'index.js',
      compatibility_date: '2026-06-01',
      durable_objects: {
        bindings: [{ name: 'COUNTER_DO', class_name: 'CounterDO' }],
      },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['CounterDO'] }],
    });
    // vars become env-var bindings (merged after any explicit config.bindings);
    // a top-level vars key would be a no-op on the direct-deploy path.
    expect(manifest.bindings).toEqual([
      { type: 'plain_text', name: 'EXISTING', text: 'kept' },
      { type: 'plain_text', name: 'APP_TITLE', text: 'Demo API' },
      { type: 'json', name: 'MAX_ITEMS', json: 5 },
    ]);
    expect(manifest).not.toHaveProperty('vars');
    expect(manifest).not.toHaveProperty('main');
  });

  it('omits bindings entirely when the config has no vars or bindings', () => {
    const dir = setupWorkerProject({
      name: 'demo-app',
      main: 'src/index.ts',
      compatibility_date: '2026-06-01',
    });

    execFileSync(process.execPath, ['scripts/write-build-manifest.mjs'], {
      cwd: dir,
      encoding: 'utf8',
    });

    const manifest = readManifest(dir);
    expect(manifest).toEqual({
      name: 'demo-app',
      main_module: 'index.js',
      compatibility_date: '2026-06-01',
    });
  });
});
