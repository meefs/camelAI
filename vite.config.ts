import { reactRouter } from '@react-router/dev/vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig, type Plugin } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

// Plugin to suppress benign "terminated" errors from undici/miniflare
// These occur when WebSocket connections are aborted during HMR/navigation
function suppressUndiciTerminatedErrors(): Plugin {
  return {
    name: 'suppress-undici-terminated',
    configureServer() {
      // Only in development
      const originalListeners = process.listeners('uncaughtException');
      process.removeAllListeners('uncaughtException');

      process.on('uncaughtException', (err) => {
        const msg = String(err);
        // Suppress benign connection abort errors from undici/miniflare
        if (
          msg.includes('terminated') ||
          msg.includes('ECONNRESET') ||
          msg.includes('other side closed')
        ) {
          // Silently ignore - these are expected during HMR/navigation
          return;
        }
        // Re-throw other errors to original handlers
        for (const listener of originalListeners) {
          listener(err, 'uncaughtException');
        }
      });

      process.on('unhandledRejection', (reason) => {
        const msg = String(reason);
        if (
          msg.includes('terminated') ||
          msg.includes('ECONNRESET') ||
          msg.includes('other side closed')
        ) {
          return;
        }
        // Let other rejections propagate normally
        console.error('Unhandled rejection:', reason);
      });
    },
  };
}

export default defineConfig(({ command }) => {
  // Allow common tunnel hosts for local development (e.g., ngrok).
  // Additional hosts can be provided via VITE_ALLOWED_HOSTS=host1,host2.
  // Leading dot entries allow subdomains (e.g. ".ngrok-free.app").
  const extraAllowedHosts = (process.env.VITE_ALLOWED_HOSTS || '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);
  const allowedHosts = Array.from(new Set([
    'host.docker.internal',
    '.ngrok-free.app',
    '.ngrok-free.dev',
    '.ngrok.app',
    '.ngrok.io',
    ...extraAllowedHosts,
  ]));

  return {
    plugins: [
    suppressUndiciTerminatedErrors(),
    cloudflare({
      configPath: './wrangler.jsonc',
      viteEnvironment: { name: 'ssr' },
    }),
    reactRouter(),
    tsconfigPaths({ ignoreConfigErrors: true }),
    ],
    // Configure SSR environment to use Cloudflare's worker entry as the rollup input
    // This ensures Durable Object exports are included in the bundle
    environments: {
      ssr: {
        build: {
          rollupOptions: {
            input: 'virtual:cloudflare/worker-entry',
          },
        },
      },
    },
    build: {
      target: 'esnext',
      // Only enable source maps in development to avoid exposing server code in production
      sourcemap: command !== 'build',
    },
    optimizeDeps: {
      include: ['react', 'react-dom', 'react-dom/client', 'react-router'],
      // Disable dep discovery during builds to avoid WebSocket error in @cloudflare/vite-plugin
      ...(command === 'build' && { noDiscovery: true }),
    },
    server: {
      port: 3001,
      strictPort: false,
      host: true,
      allowedHosts,
      watch: {
        ignored: ['**/.sandbox-host/**'],
      },
    },
  };
});
