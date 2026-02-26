import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  resolveGatewaySettings,
  resolveVirtualModel,
  runViaGatewayHTTP,
  stripTopLevelModel,
} from '../src/ai-virtual-binding.js';

describe('resolveGatewaySettings', () => {
  it('returns gateway settings from required env vars', () => {
    const settings = resolveGatewaySettings({
      CF_ACCOUNT_ID: 'acct',
      CF_GATEWAY_NAME: 'chiridion',
      CF_GATEWAY_TOKEN: 'token',
    });

    expect(settings).toEqual({
      accountID: 'acct',
      gatewayID: 'chiridion',
      authToken: 'token',
    });
  });

  it('uses AI_GATEWAY_AUTH_TOKEN when set', () => {
    const settings = resolveGatewaySettings({
      CF_ACCOUNT_ID: 'acct',
      CF_GATEWAY_NAME: 'chiridion',
      CF_GATEWAY_TOKEN: 'token',
      AI_GATEWAY_AUTH_TOKEN: 'override-token',
    });

    expect(settings?.authToken).toBe('override-token');
  });

  it('returns undefined when required gateway config is missing', () => {
    expect(resolveGatewaySettings({
      CF_ACCOUNT_ID: 'acct',
      CF_GATEWAY_NAME: 'chiridion',
      CF_GATEWAY_TOKEN: '',
    })).toBeUndefined();
  });
});

describe('stripTopLevelModel', () => {
  it('removes top-level model field from object input', () => {
    expect(stripTopLevelModel({
      model: '@cf/bad/override',
      messages: [{ role: 'user', content: 'hello' }],
    })).toEqual({
      messages: [{ role: 'user', content: 'hello' }],
    });
  });

  it('returns input unchanged when no model field exists', () => {
    const input = { messages: [{ role: 'user', content: 'hello' }] };
    expect(stripTopLevelModel(input)).toBe(input);
  });
});

describe('resolveVirtualModel', () => {
  it('uses AI_VIRTUAL_MODEL when configured', () => {
    expect(resolveVirtualModel({ AI_VIRTUAL_MODEL: 'smart' })).toBe('smart');
  });

  it('falls back to dynamic/auto when unset', () => {
    expect(resolveVirtualModel({ AI_VIRTUAL_MODEL: '' })).toBe('dynamic/auto');
  });
});

describe('runViaGatewayHTTP', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls compat chat completions endpoint and hardcodes model to dynamic/auto', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        id: 'chatcmpl_1',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    );

    const result = await runViaGatewayHTTP(
      {
        accountID: 'acct_1',
        gatewayID: 'gw_1',
        authToken: 'tok_1',
      },
      { orgId: 'org_1', workspaceId: 'ws_1', userId: 'user_1' },
      {
        model: '@cf/ignored/hint',
        messages: [{ role: 'user', content: 'hello' }],
      },
      'dynamic/auto',
    );

    expect(result).toEqual({
      id: 'chatcmpl_1',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gateway.ai.cloudflare.com/v1/acct_1/gw_1/compat/chat/completions');
    expect(init.method).toBe('POST');

    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer tok_1');
    const metadata = headers.get('cf-aig-metadata');
    expect(metadata).toContain('"uid":"org_1:ws_1:user_1"');
    expect(metadata).toContain('"userId":"user_1"');

    expect(init.body).toBeDefined();
    const body = JSON.parse(String(init.body)) as { model?: string; messages?: unknown[] };
    expect(body.model).toBe('dynamic/auto');
    expect(Array.isArray(body.messages)).toBe(true);
  });

  it('throws gateway error message for non-2xx responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        error: { message: 'gateway rejected request' },
      }), { status: 400, headers: { 'Content-Type': 'application/json' } })
    );

    await expect(
      runViaGatewayHTTP(
        {
          accountID: 'acct_1',
          gatewayID: 'gw_1',
          authToken: 'tok_1',
        },
        { orgId: 'org_1', workspaceId: 'ws_1' },
        { messages: [{ role: 'user', content: 'hello' }] },
        'dynamic/auto',
      )
    ).rejects.toThrow('gateway rejected request');
  });

  it('passes through streaming responses when stream=true', async () => {
    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"id":"evt_1"}\n\n'));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(streamBody, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
      })
    );

    const result = await runViaGatewayHTTP(
      {
        accountID: 'acct_1',
        gatewayID: 'gw_1',
        authToken: 'tok_1',
      },
      { orgId: 'org_1', workspaceId: 'ws_1' },
      {
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      },
      'dynamic/auto',
    );

    expect(result).toBeInstanceOf(ReadableStream);

    const reader = (result as ReadableStream<Uint8Array>).getReader();
    let combined = '';
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      combined += decoder.decode(value, { stream: true });
    }
    combined += decoder.decode();

    expect(combined).toContain('data: {"id":"evt_1"}');
    expect(combined).toContain('data: [DONE]');
  });
});
