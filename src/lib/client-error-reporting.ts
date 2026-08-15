type ClientErrorSource =
  | 'window_error'
  | 'unhandled_rejection'
  | 'react_error_boundary'
  | 'react_recoverable_error';

export type ClientEventSource =
  | 'chat_runner'
  | 'chat_sse'
  | 'chat_new_thread'
  | 'workspace_status_stream'
  | 'version_skew';

export type ClientTelemetrySeverity =
  | 'debug'
  | 'info'
  | 'warn'
  | 'error';

type ClientErrorInput = {
  source: ClientErrorSource;
  error: unknown;
  componentStack?: string;
  routeId?: string;
  statusCode?: number;
};

type ClientEventInput = {
  source: ClientEventSource;
  event: string;
  message?: string;
  details?: unknown;
  routeId?: string;
  severity?: ClientTelemetrySeverity;
  status?: string;
  statusCode?: number;
  threadId?: string | null;
  workspaceId?: string | null;
  orgId?: string | null;
  userId?: string | null;
  durationMs?: number;
  count?: number;
  error?: unknown;
};

type SerializedClientError = {
  kind: 'error';
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

type SerializedClientEvent = {
  kind: 'event';
  source: ClientEventSource;
  event: string;
  severity: ClientTelemetrySeverity;
  status?: string;
  name: string;
  message: string;
  stack?: string;
  details?: string;
  path: string;
  url: string;
  routeId?: string;
  statusCode?: number;
  threadId?: string;
  workspaceId?: string;
  orgId?: string;
  userId?: string;
  durationMs?: number;
  count?: number;
  userAgent: string;
  viewport: string;
  timestamp: number;
};

const CLIENT_ERROR_ENDPOINT = '/api/client-errors';
const MAX_REPORTS_PER_PAGE = {
  error: 10,
  event: 40,
} as const;
const MAX_REPORTS_PER_SIGNATURE = {
  error: 2,
  event: 5,
} as const;
const AUTO_RELOAD_DELAY_MS = 250;

let initialized = false;
const reportCounts: Record<'error' | 'event', number> = {
  error: 0,
  event: 0,
};
const signatureCounts = new Map<string, number>();

export function initClientErrorReporting(): void {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;

  window.addEventListener('error', (event) => {
    const error = event.error ?? event.message;
    reportClientError({
      source: 'window_error',
      error,
    });
    scheduleClientErrorReload({ error });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const error = event.reason;
    reportClientError({
      source: 'unhandled_rejection',
      error,
    });
    scheduleClientErrorReload({ error });
  });
}

export function scheduleClientErrorReload(input: {
  error: unknown;
  statusCode?: number;
  recoverableOnly?: boolean;
}): boolean {
  if (typeof window === 'undefined') return false;
  if (input.statusCode && input.statusCode < 500) return false;

  const details = errorDetails(input.error);
  if (input.recoverableOnly !== false && !isAutoReloadRecoverable(details)) {
    return false;
  }

  const key = [
    'camelai:auto-reload',
    window.location.pathname,
    details.name,
    details.message,
  ].join(':');

  try {
    if (window.sessionStorage.getItem(key)) return false;
    window.sessionStorage.setItem(key, String(Date.now()));
  } catch {
    return false;
  }

  window.setTimeout(() => {
    window.location.reload();
  }, AUTO_RELOAD_DELAY_MS);
  return true;
}

export function reportClientError(input: ClientErrorInput): void {
  reportClientTelemetry(serializeClientError(input));
}

export function reportClientEvent(input: ClientEventInput): void {
  reportClientTelemetry(serializeClientEvent(input));
}

function reportClientTelemetry(
  payload: SerializedClientError | SerializedClientEvent,
): void {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return;
  const kind = payload.kind;
  const maxReportsForKind = MAX_REPORTS_PER_PAGE[kind];
  const maxReportsPerSignature = MAX_REPORTS_PER_SIGNATURE[kind];
  if (reportCounts[kind] >= maxReportsForKind) return;

  const signature = [
    payload.kind,
    payload.source,
    payload.kind === 'event' ? payload.event : 'client_error',
    payload.name,
    payload.message,
    payload.stack?.split('\n', 1)[0] ?? '',
    payload.path,
  ].join('|');
  const signatureCount = signatureCounts.get(signature) ?? 0;
  if (signatureCount >= maxReportsPerSignature) return;

  signatureCounts.set(signature, signatureCount + 1);
  reportCounts[kind] += 1;

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
  const stack = appendComponentStack(details.stack, input.componentStack);
  return {
    kind: 'error',
    source: input.source,
    name: limit(details.name, 128),
    message: limit(details.message, 2048),
    stack: stack ? limit(redactStack(stack), 4096) : undefined,
    path,
    url: `${window.location.origin}${path}`,
    routeId: input.routeId ? limit(input.routeId, 256) : undefined,
    statusCode: input.statusCode,
    userAgent: limit(navigator.userAgent, 512),
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    timestamp: Date.now(),
  };
}

function appendComponentStack(
  stack: string | undefined,
  componentStack: string | undefined,
): string | undefined {
  const trimmedComponentStack = componentStack?.trim();
  if (!trimmedComponentStack) return stack;
  return `${stack ?? ''}\n\nReact component stack:\n${trimmedComponentStack}`;
}

function serializeClientEvent(input: ClientEventInput): SerializedClientEvent {
  const details = errorDetails(input.error);
  const path = sanitizePath(window.location.pathname);
  return {
    kind: 'event',
    source: input.source,
    event: limit(input.event, 128),
    severity: input.severity ?? 'info',
    status: input.status ? limit(input.status, 128) : undefined,
    name: limit(details.name, 128),
    message: limit(input.message ?? details.message ?? input.event, 2048),
    stack: details.stack ? limit(redactStack(details.stack), 4096) : undefined,
    details: input.details === undefined ? undefined : limit(redactStack(stringifyUnknown(input.details)), 4096),
    path,
    url: `${window.location.origin}${path}`,
    routeId: input.routeId ? limit(input.routeId, 256) : undefined,
    statusCode: input.statusCode,
    threadId: input.threadId ? limit(input.threadId, 128) : undefined,
    workspaceId: input.workspaceId ? limit(input.workspaceId, 128) : undefined,
    orgId: input.orgId ? limit(input.orgId, 128) : undefined,
    userId: input.userId ? limit(input.userId, 128) : undefined,
    durationMs:
      typeof input.durationMs === 'number' && Number.isFinite(input.durationMs)
        ? input.durationMs
        : undefined,
    count:
      typeof input.count === 'number' && Number.isFinite(input.count)
        ? input.count
        : undefined,
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

function isAutoReloadRecoverable(error: {
  name: string;
  message: string;
  stack?: string;
}): boolean {
  // Hydration mismatches (React #418, "hydration failed") are intentionally
  // absent: React already recovers by client-rendering the tree, so a forced
  // reload only discards that recovery and re-runs every loader. Auto-reload
  // is reserved for asset-load failures, where a reload genuinely fixes the
  // page (deploy version skew, flaky networks).
  const text = `${error.name}\n${error.message}\n${error.stack ?? ''}`.toLowerCase();
  return [
    'chunkloaderror',
    'loading chunk',
    'failed to fetch dynamically imported module',
    'error loading dynamically imported module',
    'importing a module script failed',
    'module script load failed',
    'unable to preload css',
    'loading css chunk',
  ].some((needle) => text.includes(needle));
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

function redactStack(stack: string): string {
  return stack
    .replace(/https?:\/\/[^\s)]+/g, (match) => redactUrl(match))
    .replace(/\/[^\s)]+[?#][^\s)]*/g, (match) => match.split(/[?#]/, 1)[0]);
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return value.split(/[?#]/, 1)[0];
  }
}

function limit(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}
