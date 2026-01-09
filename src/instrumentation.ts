import { getCloudflareContext } from '@opennextjs/cloudflare';

interface CloudflareEnv {
  ERROR_ANALYTICS?: AnalyticsEngineDataset;
}

export async function onRequestError(
  error: Error & { digest?: string },
  request: {
    path: string;
    method: string;
    headers: Record<string, string>;
  },
  context: {
    routerKind: 'Pages Router' | 'App Router';
    routePath: string;
    routeType: 'render' | 'route' | 'action' | 'middleware';
    revalidateReason: 'on-demand' | 'stale' | undefined;
  }
): Promise<void> {
  const timestamp = Date.now();
  const errorMessage = error.message || 'Unknown error';
  const errorDigest = error.digest || 'no-digest';
  const errorStack = error.stack || '';

  // Always log to console for wrangler tail visibility
  console.error('[SSR Error]', {
    digest: errorDigest,
    message: errorMessage,
    path: request.path,
    method: request.method,
    routePath: context.routePath,
    routeType: context.routeType,
    routerKind: context.routerKind,
    stack: errorStack,
  });

  // Try to write to Analytics Engine
  try {
    const { env } = getCloudflareContext() as { env: CloudflareEnv };

    if (env?.ERROR_ANALYTICS) {
      env.ERROR_ANALYTICS.writeDataPoint({
        // Indexed field for filtering (1 max)
        indexes: [context.routeType], // 'render' | 'route' | 'action' | 'middleware'
        // String fields (20 max)
        blobs: [
          errorDigest,           // blob1: error digest for deduplication
          errorMessage.slice(0, 1000), // blob2: error message (truncated)
          request.path,          // blob3: request path
          request.method,        // blob4: HTTP method
          context.routePath,     // blob5: route pattern
          context.routerKind,    // blob6: 'App Router' | 'Pages Router'
          errorStack.slice(0, 2000), // blob7: stack trace (truncated)
        ],
        // Numeric fields (20 max)
        doubles: [
          timestamp,             // double1: timestamp for time-series
          1,                     // double2: count (for aggregation)
        ],
      });
    }
  } catch (analyticsError) {
    // Don't let analytics failures break the error handling
    console.error('[Analytics Error]', analyticsError);
  }
};

export async function register() {
  // Instrumentation registration hook
  // Can be used for other setup if needed
}
