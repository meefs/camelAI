import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const CODE_MODE_COMPATIBILITY_DATE = '2025-12-01';

const fetchWorkerModule = `
import { WorkerEntrypoint } from "cloudflare:workers";

export class FetchTest extends WorkerEntrypoint {
  async run() {
    const response = await fetch("https://example.com");
    return { text: String(response.status) };
  }
}
`;

describe('code mode outbound fetch', () => {
  it('allows fetch from dynamic workers when globalOutbound is not blocked', async () => {
    const loader = env.CODE_MODE_LOADER as WorkerLoader & {
      load?: (code: WorkerLoaderWorkerCode) => WorkerStub;
    };
    expect(loader?.load, 'CODE_MODE_LOADER binding is required').toBeTypeOf('function');

    const worker = loader.load!({
      compatibilityDate: CODE_MODE_COMPATIBILITY_DATE,
      mainModule: 'index.js',
      modules: {
        'index.js': { js: fetchWorkerModule },
      },
    });

    const runner = worker.getEntrypoint('FetchTest') as unknown as {
      run(): Promise<{ text?: unknown }>;
    };
    const result = await runner.run();

    expect(result.text).toBe('200');
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
        'index.js': { js: fetchWorkerModule },
      },
      globalOutbound: null,
    });

    const runner = worker.getEntrypoint('FetchTest') as unknown as {
      run(): Promise<{ text?: unknown }>;
    };

    try {
      await runner.run();
      expect.unreachable('fetch should be blocked when globalOutbound is null');
    } catch (error) {
      expect(String(error)).toMatch(/not permitted to access the internet/i);
    }
  });
});
