import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const DISPATCHER_CONFIGS = [
  'wrangler.jsonc',
  'wrangler.prod.jsonc',
  'wrangler.staging.jsonc',
  'wrangler.evals.jsonc',
  'wrangler.dev-miguel.jsonc',
  'wrangler.dev-illiana.jsonc',
];

describe('dispatcher build configuration', () => {
  for (const configName of DISPATCHER_CONFIGS) {
    it(`${configName} loads the database runner as text`, () => {
      const config = readFileSync(
        path.resolve('workers/dispatcher', configName),
        'utf8',
      );

      expect(config).toContain('"virtual:db-query-runner-source"');
      expect(config).toContain('"./src/db-query-runner-source.ts"');
      expect(config).toContain('"type": "Text"');
      expect(config).toContain('"**/db-query-runner.mjs"');
    });
  }

  it('keeps separate Vite and Wrangler adapters for the runner source', () => {
    const service = readFileSync(
      path.resolve('workers/main/src/db-query-service.ts'),
      'utf8',
    );
    const viteConfig = readFileSync(path.resolve('vite.config.ts'), 'utf8');
    const wranglerAdapter = readFileSync(
      path.resolve('workers/dispatcher/src/db-query-runner-source.ts'),
      'utf8',
    );

    expect(service).toContain('from "virtual:db-query-runner-source"');
    expect(viteConfig).toContain(
      "'workers/main/db-query-sandbox-assets/runner/db-query-runner.mjs'",
    );
    expect(viteConfig).toContain(')}?raw`');
    expect(wranglerAdapter).toContain("db-query-runner.mjs';");
  });
});
