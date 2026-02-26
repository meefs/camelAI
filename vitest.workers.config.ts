import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';
import path from 'path';

export default defineWorkersConfig({
  resolve: {
    alias: [
      { find: '@', replacement: path.resolve(__dirname, './src') },
      { find: '../../../.open-next/worker.js', replacement: path.resolve(__dirname, 'workers/main/src/__mocks__/opennext-handler.ts') },
      // Mock MCP handler to avoid @modelcontextprotocol/sdk ajv compatibility issues in workers runtime
      // Match any path ending in mcp-handler.js from the workers/main/src directory
      { find: /.*\/mcp-handler\.js$/, replacement: path.resolve(__dirname, 'workers/main/src/__mocks__/mcp-handler.ts') },
    ],
  },
  test: {
    include: ['workers/**/tests/**/*.test.ts'],
    poolOptions: {
      workers: {
        isolatedStorage: false,
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
