import { reactRouter } from '@react-router/dev/vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

// Dev config with auxiliary workers for local development
// Build uses vite.config.ts which excludes auxiliary workers
// (React Router expects a Vite manifest which plain Cloudflare Workers don't produce)

export default defineConfig({
  plugins: [
    cloudflare({
      configPath: './wrangler.jsonc',
      viteEnvironment: { name: 'ssr' },
    }),
    reactRouter(),
    tsconfigPaths({ ignoreConfigErrors: true }),
  ],
  build: {
    target: 'esnext',
    sourcemap: true,
  },
  optimizeDeps: {
    include: ['react', 'react-dom', 'react-dom/client', 'react-router'],
  },
  server: {
    port: 3001,
    strictPort: false,
    host: true,
    allowedHosts: ['host.docker.internal'],
    watch: {
      ignored: ['**/packages/**', '**/workers/**', '**/sandbox/**'],
    },
  },
});
