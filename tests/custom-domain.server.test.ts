import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerScript } from '@/types';

const { getCustomHostnameStatus, findCustomHostnameByHostname } = vi.hoisted(() => ({
  getCustomHostnameStatus: vi.fn(),
  findCustomHostnameByHostname: vi.fn(),
}));

vi.mock('../workers/main/src/cf-api-proxy', () => ({
  getCustomHostnameStatus,
  findCustomHostnameByHostname,
}));

import { refreshWorkerScriptCustomDomainStates } from '../src/lib/custom-domain.server';

function makeScript(overrides: Partial<WorkerScript> = {}): WorkerScript {
  return {
    script_name: 'demo-app',
    workspace_id: 'ws_123',
    created_by: 'user_123',
    created_at: 1,
    updated_at: 2,
    is_public: true,
    preview_key: null,
    preview_updated_at: null,
    preview_status: 'pending',
    preview_error: null,
    config_path: null,
    project_id: null,
    custom_domain_hostname: 'demo-app.apps.example.com',
    custom_domain_cf_hostname_id: 'cf-hostname-1',
    custom_domain_status: 'pending',
    custom_domain_ssl_status: 'pending_validation',
    custom_domain_error: null,
    custom_domain_updated_at: null,
    ...overrides,
  };
}

describe('refreshWorkerScriptCustomDomainStates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fails open when a custom hostname refresh throws', async () => {
    const script = makeScript();
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    getCustomHostnameStatus.mockRejectedValueOnce(new Error('cloudflare is down'));

    const result = await refreshWorkerScriptCustomDomainStates(
      {
        ORG: {} as DurableObjectNamespace<any>,
        CF_ZONE_ID: 'zone-1',
        CF_API_TOKEN: 'token-1',
      },
      'org-1',
      [script],
      'apps.example.com'
    );

    expect(result).toEqual([script]);
    expect(findCustomHostnameByHostname).not.toHaveBeenCalled();
    expect(consoleWarn).toHaveBeenCalledOnce();

    consoleWarn.mockRestore();
  });
});
