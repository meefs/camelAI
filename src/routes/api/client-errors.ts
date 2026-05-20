import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import { getSession } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import {
  normalizePathForObservability,
  recordErrorEvent,
} from '../../../workers/main/src/observability';

const MAX_CLIENT_ERROR_BODY_BYTES = 16 * 1024;

type ClientErrorPayload = {
  source?: unknown;
  name?: unknown;
  message?: unknown;
  stack?: unknown;
  path?: unknown;
  url?: unknown;
  routeId?: unknown;
  statusCode?: unknown;
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

  const text = await request.text();
  if (text.length > MAX_CLIENT_ERROR_BODY_BYTES) {
    return Response.json({ error: 'Payload too large' }, { status: 413 });
  }

  const payload = parsePayload(text);
  if (!payload) {
    return Response.json({ error: 'Invalid payload' }, { status: 400 });
  }

  const env = getEnv(context);
  const session = await getSession(request, context).catch(() => null);
  const path = normalizeClientPath(payload, request);
  const source = safeString(payload.source, 64) || 'client_error';
  const name = safeString(payload.name, 128) || 'Error';
  const message = safeString(payload.message, 2048) || 'Unknown client error';
  const stack = safeString(payload.stack, 4096);
  const routeId = safeString(payload.routeId, 256);
  const statusCode = safeStatusCode(payload.statusCode);
  const timestamp = safeTimestamp(payload.timestamp);
  const userAgent = safeString(payload.userAgent, 512);
  const viewport = safeString(payload.viewport, 64);

  const stackWithContext = [
    stack,
    userAgent ? `User agent: ${userAgent}` : '',
    viewport ? `Viewport: ${viewport}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const error = Object.assign(new Error(message), {
    name,
    stack: stackWithContext || undefined,
  });

  recordErrorEvent(env, {
    event: 'client_error',
    component: 'browser',
    operation: source,
    status: routeId || 'error',
    route: routeId,
    method: request.method,
    path,
    userId: session?.session.user_id,
    orgId: session?.session.org_id,
    workspaceId: session?.session.workspace_id,
    requestId: request.headers.get('cf-ray') ?? undefined,
    statusCode,
    timestamp,
    sampleIndex: session?.session.user_id ?? path,
    error,
  });

  return new Response(null, { status: 204 });
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

function safeTimestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return Date.now();
  const now = Date.now();
  const earliest = now - 24 * 60 * 60 * 1000;
  const latest = now + 5 * 60 * 1000;
  return value >= earliest && value <= latest ? value : now;
}
