import { beforeEach, describe, expect, it, vi } from 'vitest';

const getEnvMock = vi.fn();
const getSessionMock = vi.fn();

vi.mock('@/lib/cloudflare.server', () => ({
  getEnv: getEnvMock,
}));

vi.mock('@/lib/auth.server', () => ({
  getSession: getSessionMock,
}));

const { action } = await import('@/routes/api/client-errors');

function makeRequest(body: unknown, headers?: Record<string, string>): Request {
  return new Request('https://staging.camelai.dev/api/client-errors', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-ray': 'ray-123-SJC',
      ...(headers ?? {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /api/client-errors', () => {
  const observabilityWrite = vi.fn();
  const errorWrite = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    getEnvMock.mockReturnValue({
      OBSERVABILITY_EVENTS: { writeDataPoint: observabilityWrite },
      ERROR_ANALYTICS: { writeDataPoint: errorWrite },
    });
    getSessionMock.mockResolvedValue({
      session: {
        user_id: 'user_123',
        org_id: 'org_123',
        workspace_id: 'workspace_123',
      },
    });
  });

  it('records sanitized client errors in Cloudflare analytics', async () => {
    const response = await action({
      request: makeRequest({
        source: 'react_error_boundary',
        name: 'TypeError',
        message: 'Cannot read properties of undefined',
        stack:
          'TypeError: Cannot read properties\n    at Component (https://staging.camelai.dev/assets/app.js?token=secret#frag:1:1)',
        path: '/chat/018f64b8-0f6a-4b0f-9e70-8a5d9c0d4f5b?token=secret',
        routeId: 'root',
        statusCode: 500,
        userAgent: 'Mozilla/5.0',
        viewport: '1440x900',
        timestamp: Date.now(),
      }),
      context: {},
      params: {},
    } as never);

    expect(response.status).toBe(204);
    expect(observabilityWrite).toHaveBeenCalledTimes(1);
    expect(errorWrite).toHaveBeenCalledTimes(1);

    const errorPoint = errorWrite.mock.calls[0][0];
    expect(errorPoint.blobs[0]).toBe('client_error');
    expect(errorPoint.blobs[1]).toBe('browser');
    expect(errorPoint.blobs[2]).toBe('react_error_boundary');
    expect(errorPoint.blobs[4]).toBe('TypeError');
    expect(errorPoint.blobs[5]).toBe('Cannot read properties of undefined');
    expect(errorPoint.blobs[7]).toBe('workspace_123');
    expect(errorPoint.blobs[8]).toBe('org_123');
    expect(errorPoint.blobs[9]).toBe('user_123');
    expect(errorPoint.blobs[10]).toBe('ray-123-SJC');
    expect(errorPoint.blobs[11]).toBe('root');
    expect(errorPoint.blobs[12]).toBe('/chat/:uuid');
    expect(errorPoint.blobs[13]).not.toContain('token=secret');
    expect(errorPoint.blobs[13]).not.toContain('#frag');
    expect(errorPoint.blobs[13]).toContain('Fingerprint: client:');
    expect(errorPoint.blobs[13]).toContain('Viewport: 1440x900');
    expect(errorPoint.doubles[2]).toBe(500);
    expect(errorPoint.indexes[0]).toMatch(/^client:[0-9a-f]{8}$/);
  });

  it('records client chat lifecycle events in observability without error analytics', async () => {
    const response = await action({
      request: makeRequest({
        kind: 'event',
        source: 'chat_websocket',
        event: 'ws_closed',
        severity: 'warn',
        status: 'closed',
        message: 'Chat websocket closed.',
        threadId: 'thread_123',
        workspaceId: 'workspace_client',
        details: {
          code: 1006,
          reason: 'closed',
          reconnectAttempts: 5,
        },
        path: '/chat/018f64b8-0f6a-4b0f-9e70-8a5d9c0d4f5b',
        routeId: 'chat',
        timestamp: Date.now(),
      }),
      context: {},
      params: {},
    } as never);

    expect(response.status).toBe(204);
    expect(observabilityWrite).toHaveBeenCalledTimes(1);
    expect(errorWrite).not.toHaveBeenCalled();

    const eventPoint = observabilityWrite.mock.calls[0][0];
    expect(eventPoint.blobs[0]).toBe('ws_closed');
    expect(eventPoint.blobs[1]).toBe('warn');
    expect(eventPoint.blobs[2]).toBe('browser');
    expect(eventPoint.blobs[3]).toBe('chat_websocket');
    expect(eventPoint.blobs[4]).toBe('closed');
    expect(eventPoint.blobs[7]).toBe('/chat/:uuid');
    expect(eventPoint.blobs[8]).toBe('thread_123');
    expect(eventPoint.blobs[9]).toBe('workspace_123');
    expect(eventPoint.blobs[10]).toBe('org_123');
    expect(eventPoint.blobs[11]).toBe('user_123');
    expect(eventPoint.blobs[16]).toBe('Chat websocket closed.');
    expect(eventPoint.blobs[17]).toContain('Details: {"code":1006,"reason":"closed","reconnectAttempts":5}');
  });

  it('drops unauthenticated telemetry without recording analytics', async () => {
    getSessionMock.mockResolvedValue(null);

    const response = await action({
      request: makeRequest({
        kind: 'event',
        source: 'chat_websocket',
        event: 'ws_closed',
        threadId: 'thread_123',
      }),
      context: {},
      params: {},
    } as never);

    expect(response.status).toBe(204);
    expect(observabilityWrite).not.toHaveBeenCalled();
    expect(errorWrite).not.toHaveBeenCalled();
  });

  it('rejects invalid JSON payloads', async () => {
    const response = await action({
      request: makeRequest('{not-json'),
      context: {},
      params: {},
    } as never);

    expect(response.status).toBe(400);
    expect(errorWrite).not.toHaveBeenCalled();
  });

  it('rejects oversized payloads before recording', async () => {
    const response = await action({
      request: makeRequest('x'.repeat(17 * 1024), {
        'content-length': String(17 * 1024),
      }),
      context: {},
      params: {},
    } as never);

    expect(response.status).toBe(413);
    expect(errorWrite).not.toHaveBeenCalled();
  });

  it('enforces payload limits by bytes without trusting content-length', async () => {
    const response = await action({
      request: makeRequest('😀'.repeat(5_000), {}),
      context: {},
      params: {},
    } as never);

    expect(response.status).toBe(413);
    expect(errorWrite).not.toHaveBeenCalled();
  });
});
