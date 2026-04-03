import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: resolve(__dirname, 'renderer'),
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, '../src'),
      '@desktop': resolve(__dirname, 'renderer/src'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.DESKTOP_RENDERER_PORT || 4316),
  },
  build: {
    outDir: resolve(__dirname, 'renderer-dist'),
    emptyOutDir: true,
  },
  css: {
    postcss: resolve(__dirname, '..'),
  },
});
