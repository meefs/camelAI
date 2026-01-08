import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
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
