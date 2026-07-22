import { afterEach, describe, expect, it, vi } from 'vitest';
import { UNSAFE_ErrorResponseImpl } from 'react-router';
import {
  handleError,
  isExpectedSsrNotFound,
  logRouteErrors,
} from '../src/entry.server';

function errorContext(observabilityWrite = vi.fn(), errorWrite = vi.fn()) {
  return {
    context: {
      cloudflare: {
        env: {
          OBSERVABILITY_EVENTS: { writeDataPoint: observabilityWrite },
          ERROR_ANALYTICS: { writeDataPoint: errorWrite },
        },
      },
    },
    observabilityWrite,
    errorWrite,
  };
}

function invokeHandleError(error: unknown, context: unknown, path: string) {
  handleError(error, {
    request: new Request(`https://camelai.dev${path}`),
    context,
    params: {},
  } as never);
}

describe('SSR observability', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not mirror unmatched-route 404s into error analytics', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { context, observabilityWrite, errorWrite } = errorContext();
    const routeMiss = new UNSAFE_ErrorResponseImpl(
      404,
      'Not Found',
      new Error('No route matches URL "/.env"'),
      true,
    );

    expect(isExpectedSsrNotFound(routeMiss)).toBe(true);
    invokeHandleError(routeMiss, context, '/.env');
    logRouteErrors(
      new Request('https://camelai.dev/.env'),
      { errors: { root: routeMiss } } as never,
      context as never,
    );

    expect(consoleError).not.toHaveBeenCalled();
    expect(observabilityWrite).not.toHaveBeenCalled();
    expect(errorWrite).not.toHaveBeenCalled();
  });

  it('still records genuine SSR exceptions exactly once', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { context, observabilityWrite, errorWrite } = errorContext();
    const error = new TypeError('SSR render exploded');

    const request = new Request(
      'https://camelai.dev/chat/018f64b8-0f6a-4b0f-9e70-8a5d9c0d4f5b',
    );
    invokeHandleError(error, context, new URL(request.url).pathname);
    logRouteErrors(
      request,
      { errors: { 'routes/chat': error } } as never,
      context as never,
    );

    expect(observabilityWrite).toHaveBeenCalledTimes(1);
    expect(errorWrite).toHaveBeenCalledTimes(1);
    const point = errorWrite.mock.calls[0]![0] as { blobs: string[] };
    expect(point.blobs[0]).toBe('ssr_error');
    expect(point.blobs[1]).toBe('react_router');
    expect(point.blobs[2]).toBe('handleError');
    expect(point.blobs[4]).toBe('TypeError');
    expect(point.blobs[5]).toBe('SSR render exploded');
    expect(point.blobs[12]).toBe('/chat/:uuid');
  });
});
