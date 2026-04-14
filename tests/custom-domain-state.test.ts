import { describe, expect, it } from 'vitest';
import {
  getAppCustomDomainDiagnosticState,
  shouldRefreshAppCustomDomainState,
  shouldRetryAppCustomDomainProvisioning,
} from '@/lib/custom-domain-state';
import type { WorkerScript } from '@/types';

function makeScript(overrides: Partial<WorkerScript> = {}): WorkerScript {
  return {
    script_name: 'demo-app',
    workspace_id: 'ws_123',
    created_by: 'user_123',
    created_at: 1,
    updated_at: 1,
    is_public: true,
    preview_key: null,
    preview_updated_at: null,
    preview_status: null,
    preview_error: null,
    config_path: null,
    custom_domain_hostname: null,
    custom_domain_cf_hostname_id: null,
    custom_domain_status: null,
    custom_domain_ssl_status: null,
    custom_domain_error: null,
    custom_domain_updated_at: null,
    ...overrides,
  };
}

describe('custom domain state helpers', () => {
  it('refreshes immediately when the stored hostname belongs to an old domain', () => {
    const now = 120_000;
    const script = makeScript({
      custom_domain_hostname: 'demo-app.apps.old-example.com',
      custom_domain_status: 'pending',
      custom_domain_ssl_status: 'pending_validation',
      custom_domain_updated_at: now - 1_000,
    });

    expect(shouldRefreshAppCustomDomainState(script, 'apps.example.com', now)).toBe(true);
  });

  it('clears stale cached state when reporting a mismatched hostname', () => {
    const script = makeScript({
      custom_domain_hostname: 'demo-app.apps.old-example.com',
      custom_domain_cf_hostname_id: 'old-hostname-id',
      custom_domain_status: 'active',
      custom_domain_ssl_status: 'active',
      custom_domain_error: 'old error',
      custom_domain_updated_at: 1234,
    });

    expect(getAppCustomDomainDiagnosticState(script, 'apps.example.com')).toEqual({
      hostname: 'demo-app.apps.example.com',
      cf_hostname_id: null,
      status: null,
      ssl_status: null,
      error: null,
      updated_at: null,
    });
  });

  it('retries provisioning when the stored hostname belongs to an old domain', () => {
    const script = makeScript({
      custom_domain_hostname: 'demo-app.apps.old-example.com',
      custom_domain_cf_hostname_id: 'old-hostname-id',
      custom_domain_status: 'pending',
      custom_domain_ssl_status: 'pending_validation',
    });

    expect(shouldRetryAppCustomDomainProvisioning(script, 'apps.example.com')).toBe(true);
  });

  it('does not retry a matching hostname that is still provisioning normally', () => {
    const script = makeScript({
      custom_domain_hostname: 'demo-app.apps.example.com',
      custom_domain_cf_hostname_id: 'hostname-id',
      custom_domain_status: 'pending',
      custom_domain_ssl_status: 'pending_validation',
      custom_domain_error: null,
    });

    expect(shouldRetryAppCustomDomainProvisioning(script, 'apps.example.com')).toBe(false);
  });
});
