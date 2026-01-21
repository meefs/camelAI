import { reactRouter } from '@react-router/dev/vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: 'ssr' } }),
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
    watch: {
      ignored: ['**/packages/**', '**/workers/**', '**/sandbox/**'],
    },
  },
});
