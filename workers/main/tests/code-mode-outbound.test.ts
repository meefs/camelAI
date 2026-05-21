import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { codeModeWorkerModule } from '../src/code-mode-runner';

const CODE_MODE_COMPATIBILITY_DATE = '2025-12-01';

function createMinimalCodeModeEnv() {
  return {
    TOOLS: {
      listTools: async () => [],
      callTool: async () => ({}),
    },
    CONNECTIONS: {
      list: async () => [],
      get: async () => null,
      tools: async () => [],
      methods: async () => [],
      find: async () => null,
      test: async () => ({ ok: true }),
      __invoke: async () => ({}),
    },
  };
}

describe('code mode outbound fetch', () => {
  it('allows fetch from js_exec dynamic workers when globalOutbound is not blocked', async () => {
    const loader = env.CODE_MODE_LOADER as WorkerLoader & {
      load?: (code: WorkerLoaderWorkerCode) => WorkerStub;
    };
    expect(loader?.load, 'CODE_MODE_LOADER binding is required').toBeTypeOf('function');

    const worker = loader.load!({
      compatibilityDate: CODE_MODE_COMPATIBILITY_DATE,
      mainModule: 'index.js',
      modules: {
        'index.js': {
          js: codeModeWorkerModule(
            'const response = await fetch("https://example.com");\nresponse.status;',
          ),
        },
      },
      env: createMinimalCodeModeEnv(),
    });

    const runner = worker.getEntrypoint('CodeModeRunner') as unknown as {
      run(): Promise<{ text?: unknown }>;
    };
    const result = await runner.run();

    expect(String(result.text ?? '')).toContain('200');
  });

  it('blocks fetch when globalOutbound is explicitly null', async () => {
    const loader = env.CODE_MODE_LOADER as WorkerLoader & {
      load?: (code: WorkerLoaderWorkerCode) => WorkerStub;
    };
    expect(loader?.load, 'CODE_MODE_LOADER binding is required').toBeTypeOf('function');

    const worker = loader.load!({
      compatibilityDate: CODE_MODE_COMPATIBILITY_DATE,
      mainModule: 'index.js',
      modules: {
        'index.js': {
          js: `
            import { WorkerEntrypoint } from "cloudflare:workers";

            export class FetchTest extends WorkerEntrypoint {
              async run() {
                await fetch("https://example.com");
                return { ok: true };
              }
            }
          `,
        },
      },
      globalOutbound: null,
    });

    const runner = worker.getEntrypoint('FetchTest') as unknown as {
      run(): Promise<{ ok?: boolean }>;
    };

    await expect(runner.run()).rejects.toThrow();
  });
});
