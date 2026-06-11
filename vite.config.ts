import { reactRouter } from '@react-router/dev/vite';
import { cloudflare, type WorkerConfig } from '@cloudflare/vite-plugin';
import path from 'node:path';
import { defineConfig, type DepOptimizationOptions, type Plugin } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

const camelaiBuildId =
  process.env.CAMELAI_BUILD_ID ||
  process.env.GITHUB_SHA ||
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

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

function withLocalDevVars(config: WorkerConfig): Partial<WorkerConfig> | void {
  const localAuthBypass = process.env.LOCAL_AUTH_BYPASS;
  const localAuthUserEmail = process.env.LOCAL_AUTH_USER_EMAIL;
  const localAuthUserName = process.env.LOCAL_AUTH_USER_NAME;
  const workerBaseUrl = process.env.WORKER_BASE_URL;
  const sandboxProxySecret = process.env.SANDBOX_PROXY_SECRET;
  const projectRuntimeServiceUrl = process.env.PROJECT_RUNTIME_SERVICE_URL;
  const projectRuntimeDockerProxyBaseUrl =
    process.env.PROJECT_RUNTIME_DOCKER_PROXY_BASE_URL;
  const projectRuntimeProxySecret = process.env.PROJECT_RUNTIME_PROXY_SECRET;

  if (
    !localAuthBypass &&
    !localAuthUserEmail &&
    !localAuthUserName &&
    !workerBaseUrl &&
    !sandboxProxySecret &&
    !projectRuntimeServiceUrl &&
    !projectRuntimeDockerProxyBaseUrl &&
    !projectRuntimeProxySecret
  ) {
    return;
  }

  return {
    vars: {
      ...(config.vars ?? {}),
      ...(localAuthBypass ? { LOCAL_AUTH_BYPASS: localAuthBypass } : {}),
      ...(localAuthUserEmail
        ? { LOCAL_AUTH_USER_EMAIL: localAuthUserEmail }
        : {}),
      ...(localAuthUserName ? { LOCAL_AUTH_USER_NAME: localAuthUserName } : {}),
      ...(workerBaseUrl ? { WORKER_BASE_URL: workerBaseUrl } : {}),
      ...(sandboxProxySecret
        ? { SANDBOX_PROXY_SECRET: sandboxProxySecret }
        : {}),
      ...(projectRuntimeServiceUrl
        ? { PROJECT_RUNTIME_SERVICE_URL: projectRuntimeServiceUrl }
        : {}),
      ...(projectRuntimeDockerProxyBaseUrl
        ? { PROJECT_RUNTIME_DOCKER_PROXY_BASE_URL: projectRuntimeDockerProxyBaseUrl }
        : {}),
      ...(projectRuntimeProxySecret
        ? { PROJECT_RUNTIME_PROXY_SECRET: projectRuntimeProxySecret }
        : {}),
    },
  };
}

export default defineConfig(({ command }) => {
  const smithyCoreConfigNodeEntry = path.resolve(
    'node_modules/@smithy/core/dist-es/submodules/config/index.js',
  );
  const clientOptimizeDepsInclude = [
    'react',
    'react-dom',
    'react-dom/client',
    'react-router',
    'react/jsx-runtime',
    'react/jsx-dev-runtime',
  ];

  // SSR startup was repeatedly discovering and re-hashing deps, which left the
  // module runner requesting stale files from node_modules/.vite/deps_ssr.
  // Keep SSR dep optimization deterministic and only prebundle the small set of
  // interop-sensitive deps that actually need it.
  const ssrOptimizeDeps: DepOptimizationOptions = {
    include: [
      'cookie',
      'react',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'react-dom/server',
      'unenv/mock/proxy-cjs',
    ],
    noDiscovery: true,
    holdUntilCrawlEnd: true,
    ignoreOutdatedRequests: true,
  };

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
      config: withLocalDevVars,
      viteEnvironment: { name: 'ssr' },
    }),
    reactRouter(),
    tsconfigPaths({ ignoreConfigErrors: true }),
    ],
    // Configure SSR environment to use Cloudflare's worker entry as the rollup input
    // This ensures Durable Object exports are included in the bundle
    environments: {
      ssr: {
        optimizeDeps: ssrOptimizeDeps,
        build: {
          rollupOptions: {
            input: 'virtual:cloudflare/worker-entry',
          },
        },
      },
    },
    ssr: {
      optimizeDeps: ssrOptimizeDeps,
    },
    resolve: {
      alias: [
        {
          find: '@smithy/core/config',
          replacement: smithyCoreConfigNodeEntry,
        },
      ],
    },
    build: {
      target: 'esnext',
      // Only enable source maps in development to avoid exposing server code in production
      sourcemap: command !== 'build',
    },
    define: {
      'import.meta.env.VITE_CAMELAI_BUILD_ID': JSON.stringify(camelaiBuildId),
    },
    optimizeDeps: {
      include: clientOptimizeDepsInclude,
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
