import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';
import path from 'path';

export default defineWorkersConfig({
  resolve: {
    alias: {
      '../../../.open-next/worker.js': path.resolve(__dirname, 'workers/main/src/__mocks__/opennext-handler.ts'),
      // Mock MCP handler to avoid @modelcontextprotocol/sdk ajv compatibility issues in workers runtime
      './mcp-handler.js': path.resolve(__dirname, 'workers/main/src/__mocks__/mcp-handler.ts'),
    },
  },
  test: {
    include: ['workers/**/tests/**/*.test.ts'],
    poolOptions: {
      workers: {
        isolatedStorage: true,
        remoteBindings: false,
        wrangler: { configPath: './wrangler.test.jsonc' },
        miniflare: {
          compatibilityDate: '2025-12-01',
          compatibilityFlags: ['nodejs_compat'],
          cachePersist: false,
          d1Persist: false,
          durableObjectsPersist: false,
          kvPersist: false,
          r2Persist: false,
          workflowsPersist: false,
        },
      },
    },
  },
});
