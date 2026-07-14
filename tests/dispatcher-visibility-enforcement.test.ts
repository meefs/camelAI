import { describe, expect, it } from 'vitest';
import {
  getWorkerAccessInfo,
  resolveMissingRegistryMode,
  shouldFailOpenForMissingRegistry,
} from '../workers/dispatcher/src/access-control';

function createKv(seed: Record<string, string>) {
  return {
    async get(key: string): Promise<string | null> {
      return seed[key] ?? null;
    },
  };
}

describe('dispatcher visibility enforcement', () => {
  it('preserves usage guard suspension metadata from the registry', async () => {
    const kv = createKv({
      'script:my-app--acme-85b': JSON.stringify({
        org_id: 'org-1',
        org_slug: 'acme-85b',
        is_public: true,
        usage_guard_status: 'suspended',
        usage_guard_reason: 'sustained_sqlite_usage',
      }),
    });

    const access = await getWorkerAccessInfo(kv, 'my-app--acme-85b', 'my-app', 'acme-85b');
    expect(access).toMatchObject({
      usage_guard_status: 'suspended',
      usage_guard_reason: 'sustained_sqlite_usage',
    });
  });
  it('reads private visibility from canonical script--org key', async () => {
    const kv = createKv({
      'script:my-app--acme-85b': JSON.stringify({
        org_id: 'org-1',
        org_slug: 'acme-85b',
        is_public: false,
      }),
    });

    const access = await getWorkerAccessInfo(kv, 'my-app--acme-85b', 'my-app', 'acme-85b');

    expect(access).not.toBeNull();
    expect(access?.org_id).toBe('org-1');
    expect(access?.is_public).toBe(false);
    expect(access?.is_legacy).toBe(false);
  });

  it('prefers private when canonical and swapped keys disagree', async () => {
    const kv = createKv({
      'script:my-app--acme-85b': JSON.stringify({
        org_id: 'org-1',
        org_slug: 'acme-85b',
        is_public: true,
      }),
      'script:acme-85b--my-app': JSON.stringify({
        org_id: 'org-1',
        org_slug: 'acme-85b',
        is_public: false,
      }),
    });

    const access = await getWorkerAccessInfo(kv, 'my-app--acme-85b', 'my-app', 'acme-85b');

    expect(access).not.toBeNull();
    expect(access?.is_public).toBe(false);
  });

  it('supports temporary migration fallback when only swapped key exists', async () => {
    const kv = createKv({
      'script:acme-85b--my-app': JSON.stringify({
        org_id: 'org-1',
        org_slug: 'acme-85b',
        is_public: false,
      }),
    });

    const access = await getWorkerAccessInfo(kv, 'my-app--acme-85b', 'my-app', 'acme-85b');

    expect(access).not.toBeNull();
    expect(access?.is_public).toBe(false);
    expect(access?.is_legacy).toBe(false);
  });

  it('falls back to legacy script_org metadata if new key is absent', async () => {
    const kv = createKv({
      'script_org:my-app': JSON.stringify({
        org_id: 'org-1',
        org_slug: 'acme-85b',
        is_public: false,
      }),
    });

    const access = await getWorkerAccessInfo(kv, 'my-app--acme-85b', 'my-app', 'acme-85b');

    expect(access).not.toBeNull();
    expect(access?.is_public).toBe(false);
    expect(access?.is_legacy).toBe(true);
  });
});

describe('missing registry mode', () => {
  it('defaults to open (temporary migration behavior)', () => {
    expect(resolveMissingRegistryMode(undefined)).toBe('open');
    expect(resolveMissingRegistryMode('')).toBe('open');
    expect(resolveMissingRegistryMode('unknown')).toBe('open');
  });

  it('supports explicit legacy-open mode', () => {
    expect(resolveMissingRegistryMode('legacy-open')).toBe('legacy-open');
    expect(resolveMissingRegistryMode('legacy_open')).toBe('legacy-open');
  });

  it('supports explicit closed mode for strict enforcement', () => {
    expect(resolveMissingRegistryMode('closed')).toBe('closed');
    expect(resolveMissingRegistryMode('fail-closed')).toBe('closed');
  });
});

describe('missing registry dispatch policy', () => {
  it('opens for all routes in open mode', () => {
    expect(shouldFailOpenForMissingRegistry('open', null)).toBe(true);
    expect(shouldFailOpenForMissingRegistry('open', 'acme-85b')).toBe(true);
  });

  it('opens only legacy routes in legacy-open mode', () => {
    expect(shouldFailOpenForMissingRegistry('legacy-open', null)).toBe(true);
    expect(shouldFailOpenForMissingRegistry('legacy-open', 'acme-85b')).toBe(false);
  });

  it('never opens in closed mode', () => {
    expect(shouldFailOpenForMissingRegistry('closed', null)).toBe(false);
    expect(shouldFailOpenForMissingRegistry('closed', 'acme-85b')).toBe(false);
  });
});
