import type { AppLoadContext, EntryContext } from 'react-router';
import { ServerRouter } from 'react-router';
import { renderToReadableStream } from 'react-dom/server';
import { isbot } from 'isbot';

// Increase stream timeout for deferred data (default is 4950ms)
// Container boot can take 10+ seconds on cold start
export const streamTimeout = 60_000;

type RouterErrorMap = Record<string, unknown>;

function getRouterErrors(routerContext: EntryContext): RouterErrorMap | null {
  const maybeErrors = (routerContext as EntryContext & { errors?: unknown }).errors;
  if (!maybeErrors || typeof maybeErrors !== 'object') return null;
  return maybeErrors as RouterErrorMap;
}

function normalizeError(err: unknown): {
  name: string;
  message: string;
  stack?: string;
} {
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

function logRouteErrors(request: Request, routerContext: EntryContext): void {
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
  }
}

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  _loadContext: AppLoadContext
) {
  // React Router captures loader/action errors here; log them explicitly so
  // staging/prod tails include route-level stack traces.
  logRouteErrors(request, routerContext);

  const userAgent = request.headers.get('user-agent');

  const body = await renderToReadableStream(
    <ServerRouter context={routerContext} url={request.url} />,
    {
      signal: request.signal,
      onError(error: unknown) {
        // Log streaming render errors from inside the shell
        console.error(error);
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
