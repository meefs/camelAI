type ClientErrorSource =
  | 'window_error'
  | 'unhandled_rejection'
  | 'react_error_boundary';

type ClientErrorInput = {
  source: ClientErrorSource;
  error: unknown;
  routeId?: string;
  statusCode?: number;
};

type SerializedClientError = {
  source: ClientErrorSource;
  name: string;
  message: string;
  stack?: string;
  path: string;
  url: string;
  routeId?: string;
  statusCode?: number;
  userAgent: string;
  viewport: string;
  timestamp: number;
};

const CLIENT_ERROR_ENDPOINT = '/api/client-errors';
const MAX_REPORTS_PER_PAGE = 10;
const MAX_REPORTS_PER_SIGNATURE = 2;

let initialized = false;
let reportCount = 0;
const signatureCounts = new Map<string, number>();

export function initClientErrorReporting(): void {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;

  window.addEventListener('error', (event) => {
    reportClientError({
      source: 'window_error',
      error: event.error ?? event.message,
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    reportClientError({
      source: 'unhandled_rejection',
      error: event.reason,
    });
  });
}

export function reportClientError(input: ClientErrorInput): void {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return;
  if (reportCount >= MAX_REPORTS_PER_PAGE) return;

  const payload = serializeClientError(input);
  const signature = [
    payload.source,
    payload.name,
    payload.message,
    payload.stack?.split('\n', 1)[0] ?? '',
    payload.path,
  ].join('|');
  const signatureCount = signatureCounts.get(signature) ?? 0;
  if (signatureCount >= MAX_REPORTS_PER_SIGNATURE) return;

  signatureCounts.set(signature, signatureCount + 1);
  reportCount += 1;

  const body = JSON.stringify(payload);
  const blob = new Blob([body], { type: 'application/json' });

  if (typeof navigator.sendBeacon === 'function') {
    const queued = navigator.sendBeacon(CLIENT_ERROR_ENDPOINT, blob);
    if (queued) return;
  }

  void fetch(CLIENT_ERROR_ENDPOINT, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    keepalive: true,
  }).catch(() => {
    // Avoid recursive reporting if telemetry itself fails.
  });
}

function serializeClientError(input: ClientErrorInput): SerializedClientError {
  const details = errorDetails(input.error);
  const path = sanitizePath(window.location.pathname);
  return {
    source: input.source,
    name: limit(details.name, 128),
    message: limit(details.message, 2048),
    stack: details.stack ? limit(details.stack, 4096) : undefined,
    path,
    url: `${window.location.origin}${path}`,
    routeId: input.routeId ? limit(input.routeId, 256) : undefined,
    statusCode: input.statusCode,
    userAgent: limit(navigator.userAgent, 512),
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    timestamp: Date.now(),
  };
}

function errorDetails(error: unknown): {
  name: string;
  message: string;
  stack?: string;
} {
  if (error instanceof Error) {
    return {
      name: error.name || 'Error',
      message: error.message || 'Unknown client error',
      stack: error.stack,
    };
  }

  if (typeof error === 'string') {
    return { name: 'Error', message: error || 'Unknown client error' };
  }

  if (error && typeof error === 'object') {
    const candidate = error as {
      name?: unknown;
      message?: unknown;
      stack?: unknown;
      status?: unknown;
      statusText?: unknown;
    };
    const message =
      typeof candidate.message === 'string'
        ? candidate.message
        : typeof candidate.statusText === 'string'
          ? candidate.statusText
          : stringifyUnknown(error);
    return {
      name: typeof candidate.name === 'string' ? candidate.name : 'Error',
      message,
      stack: typeof candidate.stack === 'string' ? candidate.stack : undefined,
    };
  }

  return { name: 'Error', message: stringifyUnknown(error) };
}

function stringifyUnknown(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function sanitizePath(pathname: string): string {
  if (!pathname.startsWith('/')) return '/';
  return pathname.slice(0, 512);
}

function limit(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}
