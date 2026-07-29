import { describe, expect, it } from 'vitest';
import { buildAppLabel, getAppIframeUrl, getAppUrl } from '@/lib/app-url';

function isCompactOrgSlug(slug: string): boolean {
  return /^[a-z0-9]{6,}$/.test(slug);
}

interface ParsedWorkerRoute {
  scriptName: string;
  orgSlug: string;
  dispatchScriptName: string;
}

function parseScriptSlug(segment: string): ParsedWorkerRoute | null {
  if (segment.includes('--')) {
    const separatorIndex = segment.indexOf('--');
    const scriptName = segment.slice(0, separatorIndex);
    const orgSlug = segment.slice(separatorIndex + 2);
    if (!orgSlug || !scriptName) return null;
    return { scriptName, orgSlug, dispatchScriptName: `${scriptName}--${orgSlug}` };
  }

  const lastHyphen = segment.lastIndexOf('-');
  if (lastHyphen <= 0) return null;
  const orgSlug = segment.slice(lastHyphen + 1);
  if (!isCompactOrgSlug(orgSlug)) return null;
  const scriptName = segment.slice(0, lastHyphen);
  return { scriptName, orgSlug, dispatchScriptName: `${scriptName}--${orgSlug}` };
}

function parseWorkerRoute(hostname: string): ParsedWorkerRoute | null {
  const parts = hostname.split('.');
  if (hostname.endsWith('.camelai.app')) {
    return parts.length >= 3 ? parseScriptSlug(parts[0]!) : null;
  }
  if (hostname.endsWith('.camelai.dev') && hostname.includes('.apps.')) {
    return parts.length >= 4 ? parseScriptSlug(parts[0]!) : null;
  }
  return null;
}

describe('dispatcher URL parsing', () => {
  it('parses compact org slugs from vanity and iframe hosts', () => {
    const expected = {
      scriptName: 'my-app',
      orgSlug: 'k7m2p3',
      dispatchScriptName: 'my-app--k7m2p3',
    };
    expect(parseWorkerRoute('my-app-k7m2p3.camelai.app')).toEqual(expected);
    expect(parseWorkerRoute('my-app-k7m2p3.apps.camelai.dev')).toEqual(expected);
    expect(parseWorkerRoute('my-app-k7m2p3.staging.camelai.app')).toEqual(expected);
    expect(parseWorkerRoute('my-app-k7m2p3.apps.staging.camelai.dev')).toEqual(expected);
  });

  it('uses a double separator for org slugs containing hyphens', () => {
    const expected = {
      scriptName: 'my-app',
      orgSlug: 'acme-85b',
      dispatchScriptName: 'my-app--acme-85b',
    };
    expect(parseWorkerRoute('my-app--acme-85b.camelai.app')).toEqual(expected);
    expect(parseWorkerRoute('my-app--acme-85b.apps.camelai.dev')).toEqual(expected);
  });

  it('rejects hosts without an org slug', () => {
    expect(parseWorkerRoute('my-app.camelai.app')).toBeNull();
    expect(parseWorkerRoute('my-app.apps.camelai.dev')).toBeNull();
  });

  it('rejects unrelated and apex hosts', () => {
    expect(parseWorkerRoute('camelai.app')).toBeNull();
    expect(parseWorkerRoute('camelai.dev')).toBeNull();
    expect(parseWorkerRoute('my-app.example.com')).toBeNull();
  });
});

describe('canonical app URL generation', () => {
  it('builds compact-slug vanity and iframe URLs', () => {
    expect(buildAppLabel('my-app', 'k7m2p3')).toBe('my-app-k7m2p3');
    expect(getAppUrl('my-app', 'camelai.dev', 'k7m2p3'))
      .toBe('https://my-app-k7m2p3.camelai.app');
    expect(getAppIframeUrl('my-app', 'camelai.dev', 'k7m2p3'))
      .toBe('https://my-app-k7m2p3.apps.camelai.dev');
  });

  it('builds hyphenated-slug vanity and iframe URLs', () => {
    expect(buildAppLabel('my-app', 'acme-85b')).toBe('my-app--acme-85b');
    expect(getAppUrl('my-app', 'camelai.dev', 'acme-85b'))
      .toBe('https://my-app--acme-85b.camelai.app');
    expect(getAppIframeUrl('my-app', 'camelai.dev', 'acme-85b'))
      .toBe('https://my-app--acme-85b.apps.camelai.dev');
  });

  it('preserves environment-specific domains', () => {
    expect(getAppUrl('my-app', 'staging.camelai.dev', 'k7m2p3'))
      .toBe('https://my-app-k7m2p3.staging.camelai.app');
    expect(getAppIframeUrl('my-app', 'staging.camelai.dev', 'k7m2p3'))
      .toBe('https://my-app-k7m2p3.apps.staging.camelai.dev');
  });
});
