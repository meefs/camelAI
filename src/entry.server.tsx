import type { AppLoadContext, EntryContext, HandleErrorFunction } from 'react-router';
import { isRouteErrorResponse, ServerRouter } from 'react-router';
import { renderToReadableStream } from 'react-dom/server';
import { isbot } from 'isbot';
import type { CloudflareLoadContext } from './lib/cloudflare.server';
import {
  normalizePathForObservability,
  recordErrorEvent,
} from '../workers/main/src/observability';

// Increase stream timeout for deferred data (default is 4950ms)
// Container boot can take 10+ seconds on cold start
export const streamTimeout = 60_000;

type RouterErrorMap = Record<string, unknown>;
const loggedErrors = new WeakSet<object>();

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

function wasSsrErrorAlreadyLogged(err: unknown): boolean {
  if ((typeof err !== 'object' || err === null) && typeof err !== 'function') return false;
  const key = err as object;
  if (loggedErrors.has(key)) return true;
  loggedErrors.add(key);
  return false;
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

/**
 * React Router represents both an unmatched URL and an intentional 404 loader
 * response as a route error response. These are expected HTTP outcomes, not SSR
 * application exceptions, and must not pollute ERROR_ANALYTICS.
 */
export function isExpectedSsrNotFound(err: unknown): boolean {
  return isRouteErrorResponse(err) && err.status === 404;
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
  const url = new URL(input.request.url);
  recordErrorEvent((context as Partial<CloudflareLoadContext>).cloudflare?.env, {
    event: 'ssr_error',
    component: 'react_router',
    operation: input.source,
    status: input.routeId ?? 'error',
    route: input.routeId,
    method: input.request.method,
    path: normalizePathForObservability(url.pathname),
    statusCode: input.status,
    error: Object.assign(new Error(input.details.message), {
      name: input.details.name,
      stack: input.details.stack,
    }),
  });
}

export const handleError: HandleErrorFunction = (error, { request, context, params }) => {
  if (request.signal.aborted || isExpectedSsrNotFound(error)) return;

  const unwrapped = unwrapRouteError(error);
  if (wasSsrErrorAlreadyLogged(unwrapped)) return;

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

export function logRouteErrors(
  request: Request,
  routerContext: EntryContext,
  loadContext: AppLoadContext
): void {
  const errors = getRouterErrors(routerContext);
  if (!errors) return;

  for (const [routeId, err] of Object.entries(errors)) {
    if (isExpectedSsrNotFound(err)) continue;

    const unwrapped = unwrapRouteError(err);
    if (wasSsrErrorAlreadyLogged(unwrapped)) continue;

    const details = normalizeError(unwrapped);
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
        // Log streaming render errors from inside the shell. The same Error can
        // also reach handleError; keep one analytics row per Error instance.
        const unwrapped = unwrapRouteError(error);
        if (!wasSsrErrorAlreadyLogged(unwrapped)) {
          const details = normalizeError(unwrapped);
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
        }
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
