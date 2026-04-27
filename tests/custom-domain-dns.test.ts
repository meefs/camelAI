import { describe, expect, it } from 'vitest';
import {
  buildCustomDomainDnsCheck,
  getCustomHostnameDnsTarget,
  getCustomHostnameFallbackOrigin,
} from '@/lib/custom-domain-dns';

describe('custom domain DNS target helpers', () => {
  it('uses the configured cname target when present', () => {
    expect(
      getCustomHostnameDnsTarget({
        cnameTarget: 'customers.camelai.app',
        fallbackOrigin: 'custom-domains.camelai.app',
      })
    ).toBe('customers.camelai.app');
  });

  it('falls back to the configured fallback origin when no cname target is set', () => {
    expect(
      getCustomHostnameDnsTarget({
        fallbackOrigin: 'custom-domains.staging.camelai.app',
      })
    ).toBe('custom-domains.staging.camelai.app');
  });

  it('falls back to the default production hostname when no env is configured', () => {
    expect(getCustomHostnameFallbackOrigin(undefined)).toBe('custom-domains.camelai.app');
    expect(getCustomHostnameDnsTarget({})).toBe('custom-domains.camelai.app');
  });

  it('ignores blank values', () => {
    expect(
      getCustomHostnameDnsTarget({
        cnameTarget: '   ',
        fallbackOrigin: ' custom-domains.camelai.app ',
      })
    ).toBe('custom-domains.camelai.app');
  });

  it('marks a resolved matching DNS check as ok', () => {
    expect(
      buildCustomDomainDnsCheck({
        queried: 'demo-app.apps.example.com',
        expectedTarget: 'custom-domains.camelai.app',
        lookup: { status: 'resolved', target: 'custom-domains.camelai.app.' },
      })
    ).toEqual({
      queried: 'demo-app.apps.example.com',
      resolved_target: 'custom-domains.camelai.app',
      expected_target: 'custom-domains.camelai.app',
      ok: true,
      status: 'ok',
      error: null,
      http_status: null,
    });
  });

  it('marks a missing DNS record as missing rather than unavailable', () => {
    expect(
      buildCustomDomainDnsCheck({
        queried: 'app.example.com',
        expectedTarget: 'custom-domains.camelai.app',
        lookup: { status: 'missing' },
      })
    ).toEqual({
      queried: 'app.example.com',
      resolved_target: null,
      expected_target: 'custom-domains.camelai.app',
      ok: false,
      status: 'missing',
      error: null,
      http_status: null,
    });
  });

  it('marks resolver failures as unavailable instead of a DNS mismatch', () => {
    expect(
      buildCustomDomainDnsCheck({
        queried: 'demo-app.apps.example.com',
        expectedTarget: 'custom-domains.camelai.app',
        lookup: {
          status: 'unavailable',
          error: 'DoH query failed with HTTP 429',
          http_status: 429,
        },
      })
    ).toEqual({
      queried: 'demo-app.apps.example.com',
      resolved_target: null,
      expected_target: 'custom-domains.camelai.app',
      ok: null,
      status: 'unavailable',
      error: 'DoH query failed with HTTP 429',
      http_status: 429,
    });
  });
});
