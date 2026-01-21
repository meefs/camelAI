import type { Config } from '@react-router/dev/config';

export default {
  // Enable SSR for Cloudflare Workers
  ssr: true,

  // Build configuration
  buildDirectory: 'build',

  // App directory contains routes
  appDirectory: 'src',

  // Server module mode for Cloudflare Workers
  serverModuleFormat: 'esm',

  // Use flat routes convention
  future: {
    unstable_optimizeDeps: true,
  },
} satisfies Config;
