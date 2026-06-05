import { describe, expect, it } from 'vitest';
import {
  getPreferredAppUrl,
  isAppCustomDomainReady,
} from '@/lib/app-url';
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
    project_id: null,
    custom_domain_hostname: null,
    custom_domain_cf_hostname_id: null,
    custom_domain_status: null,
    custom_domain_ssl_status: null,
    custom_domain_error: null,
    custom_domain_updated_at: null,
    ...overrides,
  };
}

describe('app URL selection', () => {
  it('uses the custom domain only when hostname and SSL are both active', () => {
    const script = makeScript({
      custom_domain_hostname: 'demo-app.apps.example.com',
      custom_domain_status: 'active',
      custom_domain_ssl_status: 'active',
    });

    expect(isAppCustomDomainReady(script, 'apps.example.com')).toBe(true);
    expect(
      getPreferredAppUrl(script, {
        hostname: 'camelai.dev',
        orgSlug: 'abc123',
        orgCustomDomain: 'apps.example.com',
      })
    ).toBe('https://demo-app.apps.example.com');
  });

  it('falls back to the default app URL while Cloudflare is still provisioning', () => {
    const script = makeScript({
      custom_domain_hostname: 'demo-app.apps.example.com',
      custom_domain_status: 'pending',
      custom_domain_ssl_status: 'pending_validation',
    });

    expect(isAppCustomDomainReady(script, 'apps.example.com')).toBe(false);
    expect(
      getPreferredAppUrl(script, {
        hostname: 'camelai.dev',
        orgSlug: 'abc123',
        orgCustomDomain: 'apps.example.com',
      })
    ).toBe('https://demo-app-abc123.camelai.app');
  });

  it('uses an active exact apex custom domain', () => {
    const script = makeScript({
      custom_domain_hostname: 'example.com',
      custom_domain_status: 'active',
      custom_domain_ssl_status: 'active',
    });

    expect(isAppCustomDomainReady(script)).toBe(true);
    expect(
      getPreferredAppUrl(script, {
        hostname: 'camelai.dev',
        orgSlug: 'abc123',
      })
    ).toBe('https://example.com');
  });
});
