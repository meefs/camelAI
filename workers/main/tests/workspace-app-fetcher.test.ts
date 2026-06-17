import { describe, expect, it, vi } from 'vitest';
import {
  applyWorkspaceAppPath,
  buildWorkspaceAppHostIndex,
  buildWorkspaceAppUrl,
  fetchWorkspaceAppViaDispatch,
  isLocalAppHostname,
  isWorkspaceAppHostname,
  performWorkspaceAppFetch,
  PLATFORM_DISPATCH_LEGACY_SCRIPT_HEADER,
  PLATFORM_DISPATCH_SCRIPT_HEADER,
  PLATFORM_DISPATCH_SCRIPT_NAME_HEADER,
  shouldUseDispatchInterceptionForScreenshot,
} from '../src/workspace-app-fetcher';

describe('workspace app fetcher', () => {
  it('indexes vanity, iframe, legacy, and custom app hostnames for a workspace', async () => {
    const orgStub = {
      getInfo: vi.fn(async () => ({ slug: 'alpha12' })),
      listWorkerScriptsByWorkspace: vi.fn(async () => ([
        {
          script_name: 'webhook-api',
          workspace_id: 'workspace1',
          is_public: false,
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
    expect(isWorkspaceAppHostname(index, 'hooks.example.com')).toBe(true);
    expect(isWorkspaceAppHostname(index, 'other-org-app-beta99.staging.camelai.app')).toBe(false);
  });

  it('routes workspace app requests through the dispatcher service binding', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    const index = {
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

    const response = await fetchWorkspaceAppViaDispatch(
      env as any,
      { orgId: 'org1', workspaceId: 'workspace1' },
      new Request('https://private-app-alpha12.staging.camelai.app/api/webhook', {
        method: 'POST',
        body: '{"ok":true}',
      }),
      index,
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const forwarded = fetchMock.mock.calls[0]?.[0] as Request;
    expect(forwarded.url).toBe('https://private-app-alpha12.staging.camelai.app/api/webhook');
    expect(forwarded.method).toBe('POST');
    expect(forwarded.headers.get(PLATFORM_DISPATCH_SCRIPT_HEADER)).toBe('private-app--alpha12');
    expect(forwarded.headers.get(PLATFORM_DISPATCH_SCRIPT_NAME_HEADER)).toBe('private-app');
    expect(forwarded.headers.get(PLATFORM_DISPATCH_LEGACY_SCRIPT_HEADER)).toBe('private-app');
    expect(forwarded.headers.get('Host')).toBe('private-app-alpha12.staging.camelai.app');
  });

  it('strips caller Host spoofing and forged platform dispatch headers', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    const index = {
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
      DISPATCHER: { fetchWorkspaceApp: fetchMock },
      ORG: { idFromName: () => 'org-id', get: () => ({}) },
    };

    await fetchWorkspaceAppViaDispatch(
      env as any,
      { orgId: 'org1', workspaceId: 'workspace1' },
      new Request('https://private-app-alpha12.staging.camelai.app/api/webhook', {
        headers: {
          Host: 'victim-app-beta99.staging.camelai.app',
          [PLATFORM_DISPATCH_SCRIPT_HEADER]: 'victim-app--beta99',
          [PLATFORM_DISPATCH_SCRIPT_NAME_HEADER]: 'victim-app',
        },
      }),
      index,
    );

    const forwarded = fetchMock.mock.calls[0]?.[0] as Request;
    expect(forwarded.headers.get('Host')).toBe('private-app-alpha12.staging.camelai.app');
    expect(forwarded.headers.get(PLATFORM_DISPATCH_SCRIPT_HEADER)).toBe('private-app--alpha12');
    expect(forwarded.headers.get(PLATFORM_DISPATCH_SCRIPT_NAME_HEADER)).toBe('private-app');
  });

  it('returns dispatcher 404 responses without legacy fallback in the main worker', async () => {
    const fetchMock = vi.fn(async () => new Response('not found', { status: 404 }));
    const index = {
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

    const response = await fetchWorkspaceAppViaDispatch(
      env as any,
      { orgId: 'org1', workspaceId: 'workspace1' },
      new Request('https://private-app-alpha12.staging.camelai.app/missing'),
      index,
    );

    expect(response.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('follows redirects within workspace app hostnames', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { Location: '/dashboard/' },
      }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const index = {
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

    const response = await fetchWorkspaceAppViaDispatch(
      env as any,
      { orgId: 'org1', workspaceId: 'workspace1' },
      new Request('https://private-app-alpha12.staging.camelai.app/dashboard'),
      index,
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const redirected = fetchMock.mock.calls[1]?.[0] as Request;
    expect(redirected.url).toBe('https://private-app-alpha12.staging.camelai.app/dashboard/');
    expect(redirected.method).toBe('GET');
  });

  it('routes self-host workspace app fetches through the dispatcher service binding', async () => {
    const fetchMock = vi.fn(async () => new Response('selfhost ok', { status: 200 }));
    const index = {
      hostnames: new Set(['private-app-alpha12.localhost']),
      routesByHostname: new Map([
        ['private-app-alpha12.localhost', {
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

    const response = await fetchWorkspaceAppViaDispatch(
      env as any,
      { orgId: 'org1', workspaceId: 'workspace1' },
      new Request('http://private-app-alpha12.localhost/api'),
      index,
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const forwarded = fetchMock.mock.calls[0]?.[0] as Request;
    expect(forwarded.url).toBe('http://private-app-alpha12.localhost/api');
  });

  it('passes through non-workspace URLs without using dispatch', async () => {
    const hostIndex = { hostnames: new Set(['private-app-alpha12.staging.camelai.app']), routesByHostname: new Map() };
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await performWorkspaceAppFetch(
      {} as any,
      { orgId: 'org1', workspaceId: 'workspace1' },
      'https://example.com/hook',
      undefined,
      { getHostIndex: async () => hostIndex },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('builds self-host preview URLs with the platform HTTP listener port', async () => {
    const orgStub = {
      getInfo: vi.fn(async () => ({ slug: 'alpha12' })),
      getWorkerScript: vi.fn(async () => ({
        script_name: 'private-app',
        workspace_id: 'workspace1',
        is_public: false,
      })),
    };
    const env = {
      ORG: {
        idFromName: () => 'org-id',
        get: () => orgStub,
      },
      WORKER_BASE_URL: 'http://localhost:3001',
      LOCAL_APP_VANITY_DOMAIN: 'localhost',
    };

    await expect(buildWorkspaceAppUrl(env as any, {
      orgId: 'org1',
      workspaceId: 'workspace1',
    }, 'private-app')).resolves.toBe('http://private-app-alpha12.localhost:3001/');
  });

  it('uses dispatch interception for private local apps when DISPATCHER is configured', () => {
    expect(shouldUseDispatchInterceptionForScreenshot(false, { DISPATCHER: { fetchWorkspaceApp: vi.fn() } })).toBe(true);
    expect(shouldUseDispatchInterceptionForScreenshot(false, {})).toBe(false);
    expect(shouldUseDispatchInterceptionForScreenshot(true, { DISPATCHER: { fetchWorkspaceApp: vi.fn() } })).toBe(false);
  });

  it('detects local app hostnames for platform URL finalization', () => {
    const env = {
      WORKER_BASE_URL: 'http://localhost:3001',
      LOCAL_APP_VANITY_DOMAIN: 'apps.example.test',
    };
    expect(isLocalAppHostname('demo.localhost', env as any)).toBe(true);
    expect(isLocalAppHostname('demo.apps.example.test', env as any)).toBe(true);
    expect(isLocalAppHostname('demo.staging.camelai.app', env as any)).toBe(false);
  });

  it('keeps workspace app paths on the validated app origin', () => {
    const base = 'https://private-app-alpha12.staging.camelai.app';
    expect(applyWorkspaceAppPath(base, '/dashboard').toString()).toBe(
      'https://private-app-alpha12.staging.camelai.app/dashboard',
    );
    expect(applyWorkspaceAppPath(base, 'dashboard?q=1#top').toString()).toBe(
      'https://private-app-alpha12.staging.camelai.app/dashboard?q=1#top',
    );
    expect(() => applyWorkspaceAppPath(base, '//example.com')).toThrow(
      'Workspace app path must stay on the app origin',
    );
    expect(() => applyWorkspaceAppPath(base, 'https://example.com')).toThrow(
      'Workspace app path must stay on the app origin',
    );
  });

  it('strips sensitive headers when following redirects off workspace app hostnames', async () => {
    const dispatchFetchMock = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { Location: 'https://example.com/landing' },
    }));
    const externalFetchMock = vi.fn(async () => new Response('external', { status: 200 }));
    vi.stubGlobal('fetch', externalFetchMock);
    const index = {
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
        fetchWorkspaceApp: dispatchFetchMock,
      },
      ORG: {
        idFromName: () => 'org-id',
        get: () => ({}),
      },
    };

    const response = await fetchWorkspaceAppViaDispatch(
      env as any,
      { orgId: 'org1', workspaceId: 'workspace1' },
      new Request('https://private-app-alpha12.staging.camelai.app/start', {
        headers: {
          Authorization: 'Bearer secret-token',
          Cookie: 'session=abc123',
        },
      }),
      index,
    );

    expect(response.status).toBe(200);
    expect(externalFetchMock).toHaveBeenCalledTimes(1);
    const externalRequest = externalFetchMock.mock.calls[0]?.[0] as Request;
    expect(externalRequest.url).toBe('https://example.com/landing');
    expect(externalRequest.headers.get('Authorization')).toBeNull();
    expect(externalRequest.headers.get('Cookie')).toBeNull();
    vi.unstubAllGlobals();
  });
});
