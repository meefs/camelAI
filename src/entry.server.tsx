import type { AppLoadContext, EntryContext, HandleErrorFunction } from 'react-router';
import { isRouteErrorResponse, ServerRouter } from 'react-router';
import { renderToReadableStream } from 'react-dom/server';
import { isbot } from 'isbot';
import type { CloudflareLoadContext } from './lib/cloudflare.server';

// Increase stream timeout for deferred data (default is 4950ms)
// Container boot can take 10+ seconds on cold start
export const streamTimeout = 60_000;

type RouterErrorMap = Record<string, unknown>;
const loggedErrors = new WeakSet<Error>();
const MAX_ANALYTICS_BLOBS_BYTES = 15_500;
const ANALYTICS_BLOB_FIELD_BYTES = {
  source: 32,
  routeId: 512,
  name: 256,
  message: 4_096,
  url: 2_048,
} as const;
const textEncoder = new TextEncoder();

type NormalizedError = {
  name: string;
  message: string;
  stack?: string;
};

function getRouterErrors(routerContext: EntryContext): RouterErrorMap | null {
  const maybeErrors = (routerContext as EntryContext & { errors?: unknown }).errors;
  if (!maybeErrors || typeof maybeErrors !== 'object') return null;
  return maybeErrors as RouterErrorMap;
}

function unwrapRouteError(err: unknown): unknown {
  if (isRouteErrorResponse(err)) {
    const maybeInternal = err as typeof err & { error?: unknown };
    if (maybeInternal.error) {
      return maybeInternal.error;
    }
  }
  return err;
}

function normalizeError(err: unknown): NormalizedError {
  const unwrapped = unwrapRouteError(err);

  if (unwrapped instanceof Error) {
    return {
      name: unwrapped.name,
      message: unwrapped.message,
      stack: unwrapped.stack,
    };
  }

  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
    };
  }

  if (typeof err === 'string') {
    return { name: 'Error', message: err };
  }

  let message = String(err);
  try {
    message = JSON.stringify(err);
  } catch {
    // Fallback to String(err) for circular/non-serializable values.
  }

  return {
    name: 'UnknownError',
    message,
  };
}

function getErrorStatus(err: unknown): number | undefined {
  if (!isRouteErrorResponse(err)) return undefined;
  return err.status;
}

function getErrorAnalytics(context: AppLoadContext): AnalyticsEngineDataset | undefined {
  return (context as Partial<CloudflareLoadContext>).cloudflare?.env.ERROR_ANALYTICS;
}

function getUtf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function truncateUtf8(value: string | undefined, maxBytes: number): string {
  if (!value || maxBytes <= 0) return '';
  if (getUtf8ByteLength(value) <= maxBytes) return value;

  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (getUtf8ByteLength(value.slice(0, mid)) <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return value.slice(0, low);
}

function buildAnalyticsBlobs(input: {
  source: 'handleError' | 'route' | 'stream';
  routeId?: string;
  details: NormalizedError;
  request: Request;
}): string[] {
  const source = truncateUtf8(input.source, ANALYTICS_BLOB_FIELD_BYTES.source);
  const routeId = truncateUtf8(input.routeId, ANALYTICS_BLOB_FIELD_BYTES.routeId);
  const name = truncateUtf8(input.details.name, ANALYTICS_BLOB_FIELD_BYTES.name);
  const message = truncateUtf8(input.details.message, ANALYTICS_BLOB_FIELD_BYTES.message);
  const url = truncateUtf8(input.request.url, ANALYTICS_BLOB_FIELD_BYTES.url);

  const usedBytes =
    getUtf8ByteLength(source) +
    getUtf8ByteLength(routeId) +
    getUtf8ByteLength(name) +
    getUtf8ByteLength(message) +
    getUtf8ByteLength(url);
  const remainingBytes = Math.max(0, MAX_ANALYTICS_BLOBS_BYTES - usedBytes);
  const stack = truncateUtf8(input.details.stack, remainingBytes);

  return [source, routeId, name, message, url, stack];
}

function captureSsrError(
  context: AppLoadContext,
  input: {
    source: 'handleError' | 'route' | 'stream';
    request: Request;
    details: NormalizedError;
    routeId?: string;
    status?: number;
  }
): void {
  try {
    getErrorAnalytics(context)?.writeDataPoint({
      blobs: buildAnalyticsBlobs(input),
      doubles: [input.status ?? 0],
      indexes: [input.source],
    });
  } catch (analyticsError) {
    console.warn('[SSR error analytics failed]', analyticsError);
  }
}

export const handleError: HandleErrorFunction = (error, { request, context, params }) => {
  if (request.signal.aborted) return;

  const unwrapped = unwrapRouteError(error);
  if (unwrapped instanceof Error) {
    if (loggedErrors.has(unwrapped)) return;
    loggedErrors.add(unwrapped);
  }

  const details = normalizeError(unwrapped);
  console.error('[SSR handleError]', {
    url: request.url,
    method: request.method,
    params,
    name: details.name,
    message: details.message,
    stack: details.stack,
  });
  captureSsrError(context, {
    source: 'handleError',
    request,
    details,
    status: getErrorStatus(error),
  });
};

function logRouteErrors(
  request: Request,
  routerContext: EntryContext,
  loadContext: AppLoadContext
): void {
  const errors = getRouterErrors(routerContext);
  if (!errors) return;

  for (const [routeId, err] of Object.entries(errors)) {
    const details = normalizeError(err);
    console.error('[SSR route error]', {
      url: request.url,
      routeId,
      name: details.name,
      message: details.message,
      stack: details.stack,
    });
    captureSsrError(loadContext, {
      source: 'route',
      request,
      details,
      routeId,
      status: getErrorStatus(err),
    });
  }
}

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  loadContext: AppLoadContext
) {
  // React Router captures loader/action errors here; log them explicitly so
  // staging/prod tails include route-level stack traces.
  logRouteErrors(request, routerContext, loadContext);

  const userAgent = request.headers.get('user-agent');

  const body = await renderToReadableStream(
    <ServerRouter context={routerContext} url={request.url} />,
    {
      signal: request.signal,
      onError(error: unknown) {
        // Log streaming render errors from inside the shell
        const details = normalizeError(error);
        console.error('[SSR stream error]', {
          url: request.url,
          name: details.name,
          message: details.message,
          stack: details.stack,
        });
        captureSsrError(loadContext, {
          source: 'stream',
          request,
          details,
        });
        responseStatusCode = 500;
      },
    }
  );

  // Wait for all content to be ready for bots/crawlers
  if (userAgent && isbot(userAgent)) {
    await body.allReady;
  }

  responseHeaders.set('Content-Type', 'text/html');

  return new Response(body, {
    headers: responseHeaders,
    status: responseStatusCode,
  });
}
