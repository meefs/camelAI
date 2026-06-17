import { describe, expect, it, vi } from 'vitest';
import {
  buildWorkspaceAppHostIndex,
  isWorkspaceAppHostname,
  normalizeSecureFetchRequest,
  performSecureFetch,
} from '../src/secure-fetch';

describe('secure fetch', () => {
  it('indexes vanity, iframe, legacy, and custom app hostnames for a workspace', async () => {
    const orgStub = {
      getInfo: vi.fn(async () => ({ slug: 'alpha12' })),
      listWorkerScriptsByWorkspace: vi.fn(async () => ([
        {
          script_name: 'webhook-api',
          custom_domain_hostname: 'hooks.example.com',
          custom_domain_status: 'active',
          custom_domain_ssl_status: 'active',
        },
      ])),
    };
    const env = {
      ORG: {
        idFromName: () => 'org-id',
        get: () => orgStub,
      },
      WORKER_BASE_URL: 'https://staging.camelai.dev',
    };

    const index = await buildWorkspaceAppHostIndex(env as any, {
      orgId: 'org1',
      workspaceId: 'workspace1',
    });

    expect(isWorkspaceAppHostname(index, 'webhook-api-alpha12.staging.camelai.app')).toBe(true);
    expect(isWorkspaceAppHostname(index, 'webhook-api-alpha12.apps.staging.camelai.dev')).toBe(true);
    expect(isWorkspaceAppHostname(index, 'webhook-api.staging.camelai.app')).toBe(true);
    expect(isWorkspaceAppHostname(index, 'hooks.example.com')).toBe(true);
    expect(isWorkspaceAppHostname(index, 'other-org-app-beta99.staging.camelai.app')).toBe(false);
  });

  it('uses dispatch binding when fetching a workspace app URL', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    const hostIndex = {
      hostnames: new Set(['private-app-alpha12.staging.camelai.app']),
      routesByHostname: new Map([
        ['private-app-alpha12.staging.camelai.app', {
          scriptName: 'private-app',
          orgSlug: 'alpha12',
          dispatchScriptName: 'private-app--alpha12',
          legacyDispatchScriptName: 'private-app',
          workspaceId: 'workspace1',
          orgId: 'org1',
          isPublic: false,
        }],
      ]),
    };
    const env = {
      DISPATCHER: {
        fetchWorkspaceApp: fetchMock,
      },
      ORG: {
        idFromName: () => 'org-id',
        get: () => ({}),
      },
    };

    const response = await performSecureFetch(
      env as any,
      { orgId: 'org1', workspaceId: 'workspace1' },
      'https://private-app-alpha12.staging.camelai.app/api/webhook',
      { method: 'POST', body: '{"ok":true}' },
      {
        getHostIndex: async () => hostIndex,
      },
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const forwarded = fetchMock.mock.calls[0]?.[0] as Request;
    expect(forwarded.url).toBe('https://private-app-alpha12.staging.camelai.app/api/webhook');
  });

  it('passes through non-workspace URLs without dispatch', async () => {
    const hostIndex = { hostnames: new Set(['private-app-alpha12.staging.camelai.app']), routesByHostname: new Map() };
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await performSecureFetch(
      {} as any,
      { orgId: 'org1', workspaceId: 'workspace1' },
      'https://example.com/hook',
      undefined,
      {
        getHostIndex: async () => hostIndex,
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('normalizes Request input with init overrides', () => {
    const request = normalizeSecureFetchRequest(
      new Request('https://example.com/a', { method: 'GET' }),
      { method: 'POST', body: 'payload' },
    );

    expect(request.url).toBe('https://example.com/a');
    expect(request.method).toBe('POST');
  });
});
