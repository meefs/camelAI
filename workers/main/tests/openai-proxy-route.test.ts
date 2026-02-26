import { describe, it, expect, vi } from 'vitest';
import { handleOpenAIProxy } from '../src/routes/openai-proxy.js';

function buildRouteContext(req: Request, env: Record<string, unknown>) {
  return {
    req,
    env: env as never,
    ctx: { waitUntil: (_p: Promise<unknown>) => undefined } as never,
    url: new URL(req.url),
    match: [] as unknown as RegExpMatchArray,
  };
}

describe('openai-proxy route', () => {
  it('rejects request without sandbox proxy auth', async () => {
    const req = new Request('https://camelai.dev/api/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: '@cf/meta/llama-3.1-8b-instruct', messages: [] }),
    });

    const res = await handleOpenAIProxy(buildRouteContext(req, {
      SANDBOX_PROXY_SECRET: 'test-secret',
      SANDBOX_HOST: { fetch: vi.fn() } as unknown as Fetcher,
    }));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized: sandbox proxy auth required' });
  });

  it('forwards OpenAI-compatible request through SANDBOX_HOST with identity context', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? new URL(input)
        : input instanceof URL
          ? input
          : new URL(input.url);
      expect(url.pathname).toBe('/v1/workspaces/org-1/ws-1/openai-proxy/v1/chat/completions');
      expect(url.search).toBe('?stream=true');
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('x-chiridion-user-id')).toBe('user-1');
      expect(new Headers(init?.headers).get('x-chiridion-thread-id')).toBe('thread-1');

      const forwardedBody = JSON.parse(await new Response(init?.body ?? null).text());
      expect(forwardedBody).toEqual({
        model: '@cf/meta/llama-3.1-8b-instruct',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      });

      return new Response('data: {"id":"chatcmpl_test"}\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });

    const req = new Request('https://camelai.dev/api/openai/v1/chat/completions?stream=true', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-sandbox-secret': 'test-secret',
        'x-chiridion-org-id': 'org-1',
        'x-chiridion-workspace-id': 'ws-1',
        'x-chiridion-user-id': 'user-1',
        'x-chiridion-thread-id': 'thread-1',
      },
      body: JSON.stringify({
        model: '@cf/meta/llama-3.1-8b-instruct',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      }),
    });

    const res = await handleOpenAIProxy(buildRouteContext(req, {
      SANDBOX_PROXY_SECRET: 'test-secret',
      SANDBOX_HOST: { fetch: fetchMock } as unknown as Fetcher,
    }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(await res.text()).toBe('data: {"id":"chatcmpl_test"}\n\n');
  });
});
