import { reactRouter } from '@react-router/dev/vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [
    cloudflare({
      viteEnvironment: { name: 'ssr' },
      auxiliaryWorkers: [
        {
          configPath: './workers/proxy/wrangler.jsonc',
        },
      ],
    }),
    reactRouter(),
    tsconfigPaths({ ignoreConfigErrors: true }),
  ],
  build: {
    // Target modern browsers that support ES2022+
    target: 'esnext',
    // Generate source maps for debugging
    sourcemap: true,
  },
  // Optimize dependencies
  optimizeDeps: {
    include: ['react', 'react-dom', 'react-router'],
    exclude: ['chiridion-wrangler'],
  },
  // Server configuration for development
  server: {
    port: 3001,
    strictPort: false,
    host: true, // Bind to 0.0.0.0 so Docker containers can reach via host.docker.internal
    allowedHosts: ['host.docker.internal'], // Allow requests from Docker containers
    watch: {
      ignored: ['**/packages/**', '**/workers/**', '**/sandbox/**'],
    },
  },
});
