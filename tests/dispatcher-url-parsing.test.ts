/**
 * Tests for dispatcher URL parsing, redirect logic, and app URL generation.
 *
 * These test the pure functions extracted from the dispatcher and app-url utility:
 * - parseWorkerRoute: Parse hostname into script name, org slug, and dispatch name
 * - buildNewFormatUrl: Build canonical URL format from legacy URL
 * - buildAppLabel: Build hostname label for app URLs
 */

import { describe, it, expect } from 'vitest';
import { buildAppLabel, getAppUrl, getAppIframeUrl } from '@/lib/app-url';

// ============================================================================
// Extract pure functions from dispatcher for testing
// In production these are defined in workers/dispatcher/src/index.ts
// ============================================================================

function isNewStyleSlug(slug: string): boolean {
  return /^[a-z0-9]{6,}$/.test(slug);
}

interface ParsedWorkerRoute {
  scriptName: string;
  orgSlug: string | null;
  dispatchScriptName: string;
  legacyFallback?: { scriptName: string; dispatchScriptName: string };
}

function parseScriptSlug(segment: string): ParsedWorkerRoute | null {
  // Old format: double-hyphen separator (e.g. "my-app--ms-workspace-b3c")
  if (segment.includes('--')) {
    const separatorIndex = segment.indexOf('--');
    const scriptName = segment.slice(0, separatorIndex);
    const orgSlug = segment.slice(separatorIndex + 2);
    if (!orgSlug || !scriptName) return null;
    return { scriptName, orgSlug, dispatchScriptName: `${scriptName}--${orgSlug}` };
  }

  // New format: last hyphen is the separator, slug is 6+ alphanumeric (e.g. "my-app-k7m2p3")
  // Includes legacyFallback for ambiguity resolution at runtime.
  const lastHyphen = segment.lastIndexOf('-');
  if (lastHyphen > 0) {
    const candidate = segment.slice(lastHyphen + 1);
    if (isNewStyleSlug(candidate)) {
      const scriptName = segment.slice(0, lastHyphen);
      return {
        scriptName,
        orgSlug: candidate,
        dispatchScriptName: `${scriptName}--${candidate}`,
        legacyFallback: { scriptName: segment, dispatchScriptName: segment },
      };
    }
  }

  return null;
}

function parseWorkerRoute(hostname: string): ParsedWorkerRoute | null {
  const parts = hostname.split('.');

  if (hostname.endsWith('.camelai.app')) {
    if (parts.length < 3) return null;
    const firstPart = parts[0]!;
    const parsed = parseScriptSlug(firstPart);
    if (parsed) return parsed;
    return { scriptName: firstPart, orgSlug: null, dispatchScriptName: firstPart };
  }

  if (hostname.endsWith('.camelai.dev') && hostname.includes('.apps.')) {
    if (parts.length < 4) return null;
    const firstPart = parts[0]!;
    const parsed = parseScriptSlug(firstPart);
    if (parsed) return parsed;
    return { scriptName: firstPart, orgSlug: null, dispatchScriptName: firstPart };
  }

  return null;
}

function buildNewFormatUrl(url: URL, scriptName: string, orgSlug: string): string {
  const hostname = url.hostname;
  const parts = hostname.split('.');
  const separator = isNewStyleSlug(orgSlug) ? '-' : '--';
  const label = `${scriptName}${separator}${orgSlug}`;

  if (hostname.endsWith('.camelai.app')) {
    if (parts.length === 3) {
      return `${url.protocol}//${label}.camelai.app${url.pathname}${url.search}`;
    }
    if (parts.length === 4 && (parts[1]?.startsWith('dev-') || parts[1] === 'staging')) {
      return `${url.protocol}//${label}.${parts[1]}.camelai.app${url.pathname}${url.search}`;
    }
  }

  if (hostname.endsWith('.camelai.dev') && hostname.includes('.apps.')) {
    if (parts.length === 4 && parts[1] === 'apps') {
      return `${url.protocol}//${label}.apps.camelai.dev${url.pathname}${url.search}`;
    }
    if (parts.length === 5 && parts[1] === 'apps') {
      return `${url.protocol}//${label}.apps.${parts[2]}.camelai.dev${url.pathname}${url.search}`;
    }
  }

  return url.toString();
}

// ============================================================================
// Tests
// ============================================================================

describe('parseWorkerRoute', () => {
  describe('new single-hyphen format (new-style 6+ alphanumeric slugs)', () => {
    it('parses script-slug.camelai.app', () => {
      const result = parseWorkerRoute('my-app-k7m2p3.camelai.app');
      expect(result).toMatchObject({
        scriptName: 'my-app',
        orgSlug: 'k7m2p3',
        dispatchScriptName: 'my-app--k7m2p3',
      });
      // Single-hyphen parses always include a legacyFallback for ambiguity resolution
      expect(result!.legacyFallback).toEqual({
        scriptName: 'my-app-k7m2p3',
        dispatchScriptName: 'my-app-k7m2p3',
      });
    });

    it('parses simple script name with slug', () => {
      const result = parseWorkerRoute('hello-ab12cd.camelai.app');
      expect(result).toMatchObject({
        scriptName: 'hello',
        orgSlug: 'ab12cd',
        dispatchScriptName: 'hello--ab12cd',
      });
    });

    it('parses multi-hyphen script name with slug', () => {
      const result = parseWorkerRoute('my-cool-app-x9y8z7.camelai.app');
      expect(result).toMatchObject({
        scriptName: 'my-cool-app',
        orgSlug: 'x9y8z7',
        dispatchScriptName: 'my-cool-app--x9y8z7',
      });
    });

    it('parses new format with env prefix', () => {
      const result = parseWorkerRoute('my-app-k7m2p3.staging.camelai.app');
      expect(result).toMatchObject({
        scriptName: 'my-app',
        orgSlug: 'k7m2p3',
        dispatchScriptName: 'my-app--k7m2p3',
      });
    });

    it('parses new format on iframe domain', () => {
      const result = parseWorkerRoute('my-app-k7m2p3.apps.camelai.dev');
      expect(result).toMatchObject({
        scriptName: 'my-app',
        orgSlug: 'k7m2p3',
        dispatchScriptName: 'my-app--k7m2p3',
      });
    });

    it('parses new format on iframe domain with env prefix', () => {
      const result = parseWorkerRoute('my-app-k7m2p3.apps.staging.camelai.dev');
      expect(result).toMatchObject({
        scriptName: 'my-app',
        orgSlug: 'k7m2p3',
        dispatchScriptName: 'my-app--k7m2p3',
      });
    });

    it('handles collision suffix slugs (7+ chars)', () => {
      const result = parseWorkerRoute('my-app-k7m2p32.camelai.app');
      expect(result).toMatchObject({
        scriptName: 'my-app',
        orgSlug: 'k7m2p32',
        dispatchScriptName: 'my-app--k7m2p32',
      });
    });
  });

  describe('old double-hyphen format (backwards compat)', () => {
    it('parses script--org-slug.camelai.app', () => {
      const result = parseWorkerRoute('my-app--acme-85b.camelai.app');
      expect(result).toEqual({
        scriptName: 'my-app',
        orgSlug: 'acme-85b',
        dispatchScriptName: 'my-app--acme-85b',
      });
    });

    it('parses old format with env prefix', () => {
      const result = parseWorkerRoute('my-app--acme-85b.staging.camelai.app');
      expect(result).toEqual({
        scriptName: 'my-app',
        orgSlug: 'acme-85b',
        dispatchScriptName: 'my-app--acme-85b',
      });
    });

    it('parses old format with dev env prefix', () => {
      const result = parseWorkerRoute('my-app--acme-85b.dev-miguel.camelai.app');
      expect(result).toEqual({
        scriptName: 'my-app',
        orgSlug: 'acme-85b',
        dispatchScriptName: 'my-app--acme-85b',
      });
    });

    it('parses old format on iframe domain', () => {
      const result = parseWorkerRoute('my-app--acme-85b.apps.camelai.dev');
      expect(result).toEqual({
        scriptName: 'my-app',
        orgSlug: 'acme-85b',
        dispatchScriptName: 'my-app--acme-85b',
      });
    });

    it('parses old format on iframe domain with env prefix', () => {
      const result = parseWorkerRoute('my-app--acme-85b.apps.staging.camelai.dev');
      expect(result).toEqual({
        scriptName: 'my-app',
        orgSlug: 'acme-85b',
        dispatchScriptName: 'my-app--acme-85b',
      });
    });
  });

  describe('legacy format (no org slug)', () => {
    it('parses script.camelai.app', () => {
      const result = parseWorkerRoute('my-app.camelai.app');
      expect(result).toEqual({
        scriptName: 'my-app',
        orgSlug: null,
        dispatchScriptName: 'my-app',
      });
    });

    it('parses script.staging.camelai.app', () => {
      const result = parseWorkerRoute('my-app.staging.camelai.app');
      expect(result).toEqual({
        scriptName: 'my-app',
        orgSlug: null,
        dispatchScriptName: 'my-app',
      });
    });

    it('parses script.apps.camelai.dev', () => {
      const result = parseWorkerRoute('my-app.apps.camelai.dev');
      expect(result).toEqual({
        scriptName: 'my-app',
        orgSlug: null,
        dispatchScriptName: 'my-app',
      });
    });

    it('treats short trailing segment as part of script name, not a slug', () => {
      // "my-app" ends with "app" (3 chars) - not a valid new-style slug (needs 6+)
      const result = parseWorkerRoute('my-app.camelai.app');
      expect(result?.orgSlug).toBeNull();
      expect(result?.scriptName).toBe('my-app');
    });

    it('treats 5-char trailing segment as part of script name', () => {
      // "hello-world" ends with "world" (5 chars) - too short for new-style slug
      const result = parseWorkerRoute('hello-world.camelai.app');
      expect(result?.orgSlug).toBeNull();
      expect(result?.scriptName).toBe('hello-world');
    });
  });

  describe('ambiguous hostnames (legacy scripts ending with 6+ alphanumeric segment)', () => {
    // These are legacy scripts like "report-alpha12" where "alpha12" looks like
    // a new-style slug. The parser returns a legacyFallback so the dispatcher
    // can resolve the ambiguity at runtime via KV lookup.

    it('parses ambiguous hostname with legacyFallback', () => {
      const result = parseWorkerRoute('report-alpha12.camelai.app');
      // Primary parse: script="report", slug="alpha12"
      expect(result).toEqual({
        scriptName: 'report',
        orgSlug: 'alpha12',
        dispatchScriptName: 'report--alpha12',
        legacyFallback: { scriptName: 'report-alpha12', dispatchScriptName: 'report-alpha12' },
      });
    });

    it('parses ambiguous hostname on iframe domain', () => {
      const result = parseWorkerRoute('report-alpha12.apps.camelai.dev');
      expect(result!.legacyFallback).toEqual({
        scriptName: 'report-alpha12',
        dispatchScriptName: 'report-alpha12',
      });
    });

    it('multi-hyphen legacy script with ambiguous tail', () => {
      const result = parseWorkerRoute('my-cool-app123.camelai.app');
      // "app123" is 6 alphanumeric chars -> ambiguous
      expect(result!.scriptName).toBe('my-cool');
      expect(result!.orgSlug).toBe('app123');
      expect(result!.legacyFallback).toEqual({
        scriptName: 'my-cool-app123',
        dispatchScriptName: 'my-cool-app123',
      });
    });

    it('double-hyphen format has no legacyFallback (unambiguous)', () => {
      const result = parseWorkerRoute('my-app--k7m2p3.camelai.app');
      expect(result!.legacyFallback).toBeUndefined();
    });

    it('legacy format (no slug match) has no legacyFallback', () => {
      const result = parseWorkerRoute('my-app.camelai.app');
      expect(result!.legacyFallback).toBeUndefined();
    });

    it('new slug from buildAppLabel has legacyFallback (expected since format is ambiguous at parse time)', () => {
      // When we generate "my-app-k7m2p3", the parser can't know if this is
      // script="my-app" + slug="k7m2p3" or a legacy script "my-app-k7m2p3".
      // The legacyFallback exists but at runtime KV will resolve to the correct one.
      const label = buildAppLabel('my-app', 'k7m2p3');
      const result = parseWorkerRoute(`${label}.camelai.app`);
      expect(result!.orgSlug).toBe('k7m2p3');
      expect(result!.legacyFallback).toBeDefined();
    });
  });

  describe('invalid hostnames', () => {
    it('returns null for apex domain', () => {
      expect(parseWorkerRoute('camelai.app')).toBeNull();
    });

    it('returns null for main app domain', () => {
      expect(parseWorkerRoute('camelai.dev')).toBeNull();
    });

    it('returns null for unrelated domains', () => {
      expect(parseWorkerRoute('example.com')).toBeNull();
    });

    it('treats malformed double-hyphen (empty script) as legacy format', () => {
      // Falls through to legacy path — would 404 at dispatch level
      const result = parseWorkerRoute('--acme-85b.camelai.app');
      expect(result?.orgSlug).toBeNull();
    });

    it('treats malformed double-hyphen (empty org) as legacy format', () => {
      const result = parseWorkerRoute('my-app--.camelai.app');
      expect(result?.orgSlug).toBeNull();
    });
  });
});

describe('buildNewFormatUrl', () => {
  describe('new-style slugs use single hyphen', () => {
    it('converts legacy to single-hyphen format', () => {
      const url = new URL('https://my-app.camelai.app/some/path?query=1');
      const result = buildNewFormatUrl(url, 'my-app', 'k7m2p3');
      expect(result).toBe('https://my-app-k7m2p3.camelai.app/some/path?query=1');
    });

    it('converts legacy with staging env', () => {
      const url = new URL('https://my-app.staging.camelai.app/');
      const result = buildNewFormatUrl(url, 'my-app', 'k7m2p3');
      expect(result).toBe('https://my-app-k7m2p3.staging.camelai.app/');
    });

    it('converts legacy iframe domain', () => {
      const url = new URL('https://my-app.apps.camelai.dev/api/data');
      const result = buildNewFormatUrl(url, 'my-app', 'k7m2p3');
      expect(result).toBe('https://my-app-k7m2p3.apps.camelai.dev/api/data');
    });
  });

  describe('old-style slugs use double hyphen', () => {
    it('converts legacy to double-hyphen format', () => {
      const url = new URL('https://my-app.camelai.app/some/path?query=1');
      const result = buildNewFormatUrl(url, 'my-app', 'acme-85b');
      expect(result).toBe('https://my-app--acme-85b.camelai.app/some/path?query=1');
    });

    it('converts legacy with dev env', () => {
      const url = new URL('https://my-app.dev-miguel.camelai.app/');
      const result = buildNewFormatUrl(url, 'my-app', 'acme-85b');
      expect(result).toBe('https://my-app--acme-85b.dev-miguel.camelai.app/');
    });

    it('converts legacy iframe domain with env', () => {
      const url = new URL('https://my-app.apps.staging.camelai.dev/');
      const result = buildNewFormatUrl(url, 'my-app', 'acme-85b');
      expect(result).toBe('https://my-app--acme-85b.apps.staging.camelai.dev/');
    });
  });

  it('preserves path and query string', () => {
    const url = new URL('https://my-app.camelai.app/api/users?page=1&limit=10');
    const result = buildNewFormatUrl(url, 'my-app', 'k7m2p3');
    expect(result).toBe('https://my-app-k7m2p3.camelai.app/api/users?page=1&limit=10');
  });
});

describe('buildAppLabel', () => {
  it('uses single hyphen for new-style slugs (6+ alphanumeric)', () => {
    expect(buildAppLabel('my-app', 'k7m2p3')).toBe('my-app-k7m2p3');
  });

  it('uses single hyphen for collision suffix slugs (7+ chars)', () => {
    expect(buildAppLabel('my-app', 'k7m2p32')).toBe('my-app-k7m2p32');
  });

  it('uses double hyphen for old-style slugs (contain hyphens)', () => {
    expect(buildAppLabel('my-app', 'acme-85b')).toBe('my-app--acme-85b');
  });

  it('uses double hyphen for old-style slugs (short alphanumeric)', () => {
    // 5-char slugs are old-style (new-style requires 6+)
    expect(buildAppLabel('my-app', 'abc12')).toBe('my-app--abc12');
  });
});

describe('getAppUrl', () => {
  it('uses single hyphen for new-style slugs', () => {
    expect(getAppUrl('my-app', 'camelai.dev', 'k7m2p3')).toBe('https://my-app-k7m2p3.camelai.app');
  });

  it('uses double hyphen for old-style slugs', () => {
    expect(getAppUrl('my-app', 'camelai.dev', 'acme-85b')).toBe('https://my-app--acme-85b.camelai.app');
  });

  it('returns legacy format without org slug', () => {
    expect(getAppUrl('my-app', 'camelai.dev')).toBe('https://my-app.camelai.app');
  });
});

describe('getAppIframeUrl', () => {
  it('uses single hyphen for new-style slugs', () => {
    expect(getAppIframeUrl('my-app', 'camelai.dev', 'k7m2p3')).toBe('https://my-app-k7m2p3.apps.camelai.dev');
  });

  it('uses double hyphen for old-style slugs', () => {
    expect(getAppIframeUrl('my-app', 'camelai.dev', 'acme-85b')).toBe('https://my-app--acme-85b.apps.camelai.dev');
  });
});

describe('round-trip: buildAppLabel -> parseWorkerRoute', () => {
  it('new-style slug round-trips correctly', () => {
    const label = buildAppLabel('logo-maker', 'k7m2p3');
    const result = parseWorkerRoute(`${label}.camelai.app`);
    expect(result).toMatchObject({
      scriptName: 'logo-maker',
      orgSlug: 'k7m2p3',
      dispatchScriptName: 'logo-maker--k7m2p3',
    });
  });

  it('old-style slug round-trips correctly', () => {
    const label = buildAppLabel('logo-maker', 'ms-workspace-b3c');
    const result = parseWorkerRoute(`${label}.camelai.app`);
    expect(result).toMatchObject({
      scriptName: 'logo-maker',
      orgSlug: 'ms-workspace-b3c',
      dispatchScriptName: 'logo-maker--ms-workspace-b3c',
    });
  });

  it('multi-hyphen script with new slug round-trips correctly', () => {
    const label = buildAppLabel('my-cool-app', 'ab12cd');
    const result = parseWorkerRoute(`${label}.camelai.app`);
    expect(result).toMatchObject({
      scriptName: 'my-cool-app',
      orgSlug: 'ab12cd',
      dispatchScriptName: 'my-cool-app--ab12cd',
    });
  });
});

// ============================================================================
// Real-world backwards compatibility scenarios
// ============================================================================

describe('backwards compatibility: old deployed workers keep old URLs', () => {
  // These test cases use real-world-style org slugs from existing production orgs.
  // Old orgs have slugs like "ms-workspace-b3c" (name-based with ID prefix).
  // New orgs have slugs like "k7m2p3" (6-char hash of UUID).

  describe('chat preview pane URLs (vanity + iframe)', () => {
    it('old org shows double-hyphen vanity URL', () => {
      const url = getAppUrl('logo-maker', 'camelai.dev', 'ms-workspace-b3c');
      expect(url).toBe('https://logo-maker--ms-workspace-b3c.camelai.app');
    });

    it('old org shows double-hyphen iframe URL', () => {
      const url = getAppIframeUrl('logo-maker', 'camelai.dev', 'ms-workspace-b3c');
      expect(url).toBe('https://logo-maker--ms-workspace-b3c.apps.camelai.dev');
    });

    it('new org shows single-hyphen vanity URL', () => {
      const url = getAppUrl('logo-maker', 'camelai.dev', 'k7m2p3');
      expect(url).toBe('https://logo-maker-k7m2p3.camelai.app');
    });

    it('new org shows single-hyphen iframe URL', () => {
      const url = getAppIframeUrl('logo-maker', 'camelai.dev', 'k7m2p3');
      expect(url).toBe('https://logo-maker-k7m2p3.apps.camelai.dev');
    });
  });

  describe('buildAppLabel produces correct hostname labels', () => {
    // Old-style slugs (contain hyphens or are <6 chars) -> double hyphen
    it('old slug: acme-corp-85b', () => {
      expect(buildAppLabel('my-app', 'acme-corp-85b')).toBe('my-app--acme-corp-85b');
    });

    it('old slug: ms-workspace-b3c', () => {
      expect(buildAppLabel('todo-list', 'ms-workspace-b3c')).toBe('todo-list--ms-workspace-b3c');
    });

    it('old slug: org-abc', () => {
      expect(buildAppLabel('dashboard', 'org-abc')).toBe('dashboard--org-abc');
    });

    it('old slug: short pure alphanumeric (5 chars)', () => {
      expect(buildAppLabel('app', 'abc12')).toBe('app--abc12');
    });

    // New-style slugs (6+ alphanumeric, no hyphens) -> single hyphen
    it('new slug: k7m2p3 (6 chars)', () => {
      expect(buildAppLabel('my-app', 'k7m2p3')).toBe('my-app-k7m2p3');
    });

    it('new slug: ab12cd (6 chars)', () => {
      expect(buildAppLabel('todo-list', 'ab12cd')).toBe('todo-list-ab12cd');
    });

    it('new slug with collision suffix: k7m2p32 (7 chars)', () => {
      expect(buildAppLabel('dashboard', 'k7m2p32')).toBe('dashboard-k7m2p32');
    });

    it('new slug with collision suffix: ab12cd99 (8 chars)', () => {
      expect(buildAppLabel('app', 'ab12cd99')).toBe('app-ab12cd99');
    });
  });

  describe('dispatcher parses both old and new URLs to correct dispatch names', () => {
    // The dispatch script name in WfP namespace always uses "--"
    // regardless of the URL format. This is critical for backwards compat.

    it('old URL resolves to same dispatch name as before', () => {
      const result = parseWorkerRoute('logo-maker--ms-workspace-b3c.camelai.app');
      expect(result!.dispatchScriptName).toBe('logo-maker--ms-workspace-b3c');
      expect(result!.scriptName).toBe('logo-maker');
      expect(result!.orgSlug).toBe('ms-workspace-b3c');
    });

    it('new URL resolves to double-hyphen dispatch name', () => {
      const result = parseWorkerRoute('logo-maker-k7m2p3.camelai.app');
      expect(result!.dispatchScriptName).toBe('logo-maker--k7m2p3');
      expect(result!.scriptName).toBe('logo-maker');
      expect(result!.orgSlug).toBe('k7m2p3');
    });

    it('old and new URLs for same script resolve to different dispatch names (different orgs)', () => {
      const oldResult = parseWorkerRoute('todo-app--acme-85b.camelai.app');
      const newResult = parseWorkerRoute('todo-app-k7m2p3.camelai.app');

      // Different orgs, different dispatch names
      expect(oldResult!.dispatchScriptName).toBe('todo-app--acme-85b');
      expect(newResult!.dispatchScriptName).toBe('todo-app--k7m2p3');
    });
  });

  describe('staging/dev environments preserve format distinction', () => {
    it('old slug on staging vanity', () => {
      expect(getAppUrl('my-app', 'staging.camelai.dev', 'acme-85b'))
        .toBe('https://my-app--acme-85b.staging.camelai.app');
    });

    it('new slug on staging vanity', () => {
      expect(getAppUrl('my-app', 'staging.camelai.dev', 'k7m2p3'))
        .toBe('https://my-app-k7m2p3.staging.camelai.app');
    });

    it('old slug on dev iframe', () => {
      expect(getAppIframeUrl('my-app', 'dev-miguel.camelai.dev', 'acme-85b'))
        .toBe('https://my-app--acme-85b.apps.dev-miguel.camelai.dev');
    });

    it('new slug on dev iframe', () => {
      expect(getAppIframeUrl('my-app', 'dev-miguel.camelai.dev', 'k7m2p3'))
        .toBe('https://my-app-k7m2p3.apps.dev-miguel.camelai.dev');
    });
  });

  describe('dispatcher redirect: legacy URL -> correct format per slug style', () => {
    it('redirects legacy URL to double-hyphen for old-style slug', () => {
      const url = new URL('https://my-app.camelai.app/page');
      const result = buildNewFormatUrl(url, 'my-app', 'acme-85b');
      expect(result).toBe('https://my-app--acme-85b.camelai.app/page');
    });

    it('redirects legacy URL to single-hyphen for new-style slug', () => {
      const url = new URL('https://my-app.camelai.app/page');
      const result = buildNewFormatUrl(url, 'my-app', 'k7m2p3');
      expect(result).toBe('https://my-app-k7m2p3.camelai.app/page');
    });
  });

  describe('full round-trip: URL generation -> parsing -> dispatch', () => {
    const scenarios = [
      { script: 'logo-maker', slug: 'ms-workspace-b3c', label: 'old org with hyphenated slug' },
      { script: 'logo-maker', slug: 'acme-corp-85b', label: 'old org with corp slug' },
      { script: 'my-cool-app', slug: 'k7m2p3', label: 'new org with hash slug' },
      { script: 'dashboard', slug: 'ab12cd', label: 'new org with another hash slug' },
      { script: 'app', slug: 'k7m2p32', label: 'new org with collision suffix slug' },
      { script: 'hello-world-app', slug: 'x9y8z7', label: 'multi-hyphen script + new slug' },
    ];

    for (const { script, slug, label } of scenarios) {
      it(`${label}: ${script} + ${slug}`, () => {
        // 1. Generate preview URL (what Chat.tsx shows)
        const vanityUrl = getAppUrl(script, 'camelai.dev', slug);
        const iframeUrl = getAppIframeUrl(script, 'camelai.dev', slug);

        // 2. Parse it back (what dispatcher does)
        const vanityHostname = new URL(vanityUrl).hostname;
        const iframeHostname = new URL(iframeUrl).hostname;

        const vanityResult = parseWorkerRoute(vanityHostname);
        const iframeResult = parseWorkerRoute(iframeHostname);

        // 3. Verify round-trip
        expect(vanityResult).not.toBeNull();
        expect(vanityResult!.scriptName).toBe(script);
        expect(vanityResult!.orgSlug).toBe(slug);
        // Dispatch name always uses "--"
        expect(vanityResult!.dispatchScriptName).toBe(`${script}--${slug}`);

        expect(iframeResult).not.toBeNull();
        expect(iframeResult!.scriptName).toBe(script);
        expect(iframeResult!.orgSlug).toBe(slug);
        expect(iframeResult!.dispatchScriptName).toBe(`${script}--${slug}`);
      });
    }
  });
});
