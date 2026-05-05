import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  root: 'sandbox/create-worker/renderer',
  plugins: [react(), tsconfigPaths({ root: __dirname, ignoreConfigErrors: true })],
  build: {
    outDir: '../renderer-dist',
    emptyOutDir: true,
  },
  css: {
    postcss: __dirname,
  },
});
