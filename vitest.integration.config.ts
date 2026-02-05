import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    globals: true,
    include: ['tests/integration/**/*.test.{ts,tsx}'],
    globalSetup: './tests/integration/global-setup.ts',
    testTimeout: 30000, // Integration tests may take longer
    hookTimeout: 60000, // Server startup may take time
    // Ensure tests run sequentially to avoid port conflicts
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
