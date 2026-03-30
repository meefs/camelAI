import { describe, expect, it } from 'vitest';
import {
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
});
