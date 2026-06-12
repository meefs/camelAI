import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import { getSession } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import {
  normalizePathForObservability,
  recordObservabilityEvent,
  recordErrorEvent,
} from '../../../workers/main/src/observability';

const MAX_CLIENT_ERROR_BODY_BYTES = 16 * 1024;

type ClientErrorPayload = {
  kind?: unknown;
  source?: unknown;
  event?: unknown;
  severity?: unknown;
  status?: unknown;
  name?: unknown;
  message?: unknown;
  stack?: unknown;
  details?: unknown;
  path?: unknown;
  url?: unknown;
  routeId?: unknown;
  statusCode?: unknown;
  threadId?: unknown;
  workspaceId?: unknown;
  orgId?: unknown;
  userId?: unknown;
  durationMs?: unknown;
  count?: unknown;
  userAgent?: unknown;
  viewport?: unknown;
  timestamp?: unknown;
};

export async function loader(_args: LoaderFunctionArgs) {
  return Response.json({ error: 'Method not allowed' }, { status: 405 });
}

export async function action({ request, context }: ActionFunctionArgs) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (contentLength > MAX_CLIENT_ERROR_BODY_BYTES) {
    return Response.json({ error: 'Payload too large' }, { status: 413 });
  }

  const text = await readLimitedText(request, MAX_CLIENT_ERROR_BODY_BYTES);
  if (text === null) {
    return Response.json({ error: 'Payload too large' }, { status: 413 });
  }

  const payload = parsePayload(text);
  if (!payload) {
    return Response.json({ error: 'Invalid payload' }, { status: 400 });
  }

  const env = getEnv(context);
  const session = await getSession(request, context).catch(() => null);
  if (!session?.session) {
    return new Response(null, { status: 204 });
  }

  const sessionIdentity = session.session;
  const kind = safeKind(payload.kind);
  const path = normalizeClientPath(payload, request);
  const source = safeString(payload.source, 64) || 'client_error';
  const event = safeString(payload.event, 128) || (kind === 'event' ? 'client_event' : 'client_error');
  const severity = safeSeverity(payload.severity) ?? (kind === 'event' ? 'info' : 'error');
  const status = safeString(payload.status, 128) || undefined;
  const name = safeString(payload.name, 128) || 'Error';
  const message =
    safeString(payload.message, 2048) ||
    (kind === 'event' ? event : 'Unknown client error');
  const stack = redactStack(safeString(payload.stack, 4096));
  const details = redactStack(safeJson(payload.details, 4096));
  const routeId = safeString(payload.routeId, 256);
  const statusCode = safeStatusCode(payload.statusCode);
  const threadId = safeString(payload.threadId, 128);
  const workspaceId = sessionIdentity.workspace_id;
  const orgId = sessionIdentity.org_id;
  const userId = sessionIdentity.user_id;
  const durationMs = safeNumber(payload.durationMs);
  const count = safeNumber(payload.count);
  const timestamp = safeTimestamp(payload.timestamp);
  const userAgent = safeString(payload.userAgent, 512);
  const viewport = safeString(payload.viewport, 64);

  const fingerprint = createErrorFingerprint({
    source: kind === 'event' ? `${source}:${event}` : source,
    name,
    message,
    path,
    stack: [stack, details].filter(Boolean).join('\n'),
  });
  const contextDetails = [
    stack,
    details ? `Details: ${details}` : '',
    `Fingerprint: ${fingerprint}`,
    userAgent ? `User agent: ${userAgent}` : '',
    viewport ? `Viewport: ${viewport}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const requestId = request.headers.get('cf-ray') ?? crypto.randomUUID();

  if (kind === 'event') {
    recordObservabilityEvent(env, {
      event,
      severity,
      component: 'browser',
      operation: source,
      status: status || routeId || 'event',
      route: routeId,
      method: request.method,
      path,
      threadId: threadId || null,
      workspaceId: workspaceId || null,
      orgId: orgId || null,
      userId: userId || null,
      requestId,
      errorName: name,
      errorMessage: message,
      errorStack: contextDetails || null,
      durationMs,
      statusCode,
      count,
      timestamp,
      sampleIndex: fingerprint,
    });
  } else {
    const error = Object.assign(new Error(message), {
      name,
      stack: contextDetails || undefined,
    });

    recordErrorEvent(env, {
      event: 'client_error',
      component: 'browser',
      operation: source,
      status: status || routeId || 'error',
      route: routeId,
      method: request.method,
      path,
      threadId: threadId || undefined,
      userId: userId || undefined,
      orgId: orgId || undefined,
      workspaceId: workspaceId || undefined,
      requestId,
      statusCode,
      durationMs,
      count,
      timestamp,
      sampleIndex: fingerprint,
      error,
    });
  }

  return new Response(null, { status: 204 });
}

async function readLimitedText(
  request: Request,
  maxBytes: number,
): Promise<string | null> {
  if (!request.body) return '';

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(body);
}

function parsePayload(text: string): ClientErrorPayload | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as ClientErrorPayload;
  } catch {
    return null;
  }
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

function createErrorFingerprint(input: {
  source: string;
  name: string;
  message: string;
  path: string;
  stack: string;
}): string {
  const firstFrame = input.stack.split('\n').find((line) => line.trim()) ?? '';
  const basis = [
    input.source,
    input.name,
    normalizeMessageForGrouping(input.message),
    input.path,
    firstFrame.trim(),
  ].join('|');
  return `client:${hashString(basis)}`;
}

function normalizeMessageForGrouping(message: string): string {
  return message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, ':uuid')
    .replace(/\b[0-9a-f]{24,}\b/gi, ':hex')
    .replace(/\d{5,}/g, ':number');
}

function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function normalizeClientPath(
  payload: ClientErrorPayload,
  request: Request,
): string {
  const rawPath = safeString(payload.path, 512);
  if (rawPath.startsWith('/')) {
    try {
      return normalizePathForObservability(new URL(rawPath, request.url).pathname);
    } catch {
      // Fall through to safer fields if the browser sent a malformed path.
    }
  }

  const rawUrl = safeString(payload.url, 1024);
  if (rawUrl) {
    try {
      return normalizePathForObservability(new URL(rawUrl).pathname);
    } catch {
      // Fall through to referer/request path.
    }
  }

  const referer = request.headers.get('referer');
  if (referer) {
    try {
      return normalizePathForObservability(new URL(referer).pathname);
    } catch {
      // Fall through to endpoint path.
    }
  }

  return normalizePathForObservability(new URL(request.url).pathname);
}

function safeString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/\0/g, '').trim();
  return normalized.length > maxLength
    ? normalized.slice(0, maxLength)
    : normalized;
}

function safeStatusCode(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.trunc(value)
    : undefined;
}

function safeKind(value: unknown): 'error' | 'event' {
  return value === 'event' ? 'event' : 'error';
}

function safeSeverity(
  value: unknown,
): 'debug' | 'info' | 'warn' | 'error' | undefined {
  return value === 'debug' ||
    value === 'info' ||
    value === 'warn' ||
    value === 'error'
    ? value
    : undefined;
}

function safeJson(value: unknown, maxLength: number): string {
  if (value === undefined || value === null) return '';
  let normalized = '';
  if (typeof value === 'string') {
    normalized = value;
  } else {
    try {
      normalized = JSON.stringify(value);
    } catch {
      normalized = String(value);
    }
  }
  normalized = normalized.replace(/\0/g, '').trim();
  return normalized.length > maxLength
    ? normalized.slice(0, maxLength)
    : normalized;
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function safeTimestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return Date.now();
  const now = Date.now();
  const earliest = now - 24 * 60 * 60 * 1000;
  const latest = now + 5 * 60 * 1000;
  return value >= earliest && value <= latest ? value : now;
}
