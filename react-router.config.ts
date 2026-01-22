import type { Config } from '@react-router/dev/config';

export default {
  // Enable SSR for Cloudflare Workers
  ssr: true,

  // App directory contains routes
  appDirectory: 'src',

  // Enable Vite environment API for proper Cloudflare Workers SSR
  future: {
    unstable_optimizeDeps: true,
    v8_viteEnvironmentApi: true,
  },
} satisfies Config;
