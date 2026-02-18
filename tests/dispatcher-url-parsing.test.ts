/**
 * Tests for dispatcher URL parsing and redirect logic.
 *
 * These test the pure functions extracted from the dispatcher:
 * - parseWorkerRoute: Parse hostname into script name, org slug, and dispatch name
 * - buildNewFormatUrl: Build new URL format from legacy URL
 */

import { describe, it, expect } from 'vitest';

// ============================================================================
// Extract pure functions from dispatcher for testing
// In production these are defined in workers/dispatcher/src/index.ts
// ============================================================================

/**
 * Parse worker route from hostname.
 * Returns script name and org slug for new format, or just script name for legacy.
 *
 * New flat format: {script}--{org-slug}.camelai.app
 * New flat format: {script}--{org-slug}.apps.camelai.dev
 * Legacy format: {script}.camelai.app
 */
function parseWorkerRoute(hostname: string): { scriptName: string; orgSlug: string | null; dispatchScriptName: string } | null {
  const parts = hostname.split('.');

  // .camelai.app domain
  if (hostname.endsWith('.camelai.app')) {
    if (parts.length < 3) return null;

    const firstPart = parts[0]!;

    // Check if first part contains org-slug separator (new flat format)
    // Format: {script}--{org-slug}
    if (firstPart.includes('--')) {
      const separatorIndex = firstPart.indexOf('--');
      const scriptName = firstPart.slice(0, separatorIndex);
      const orgSlug = firstPart.slice(separatorIndex + 2);
      if (!orgSlug || !scriptName) return null;
      const dispatchScriptName = `${scriptName}--${orgSlug}`;
      return { scriptName, orgSlug, dispatchScriptName };
    }

    // Legacy format: {script}.camelai.app or {script}.{env}.camelai.app
    const scriptName = firstPart;
    return { scriptName, orgSlug: null, dispatchScriptName: scriptName };
  }

  // .apps.camelai.dev domain (same-site for iframes)
  if (hostname.endsWith('.camelai.dev') && hostname.includes('.apps.')) {
    if (parts.length < 4) return null;

    const firstPart = parts[0]!;

    // Check if first part contains org-slug separator (new flat format)
    // Format: {script}--{org-slug}
    if (firstPart.includes('--')) {
      const separatorIndex = firstPart.indexOf('--');
      const scriptName = firstPart.slice(0, separatorIndex);
      const orgSlug = firstPart.slice(separatorIndex + 2);
      if (!orgSlug || !scriptName) return null;
      const dispatchScriptName = `${scriptName}--${orgSlug}`;
      return { scriptName, orgSlug, dispatchScriptName };
    }

    // Legacy format: {script}.apps.camelai.dev or {script}.apps.{env}.camelai.dev
    const scriptName = firstPart;
    return { scriptName, orgSlug: null, dispatchScriptName: scriptName };
  }

  return null;
}

/**
 * Build the new-format URL for a worker.
 * Uses flat format: {script}--{org-slug}.domain
 */
function buildNewFormatUrl(url: URL, scriptName: string, orgSlug: string): string {
  const hostname = url.hostname;
  const parts = hostname.split('.');

  // For .camelai.app domains
  if (hostname.endsWith('.camelai.app')) {
    // Legacy: script.camelai.app -> script--org-slug.camelai.app
    if (parts.length === 3) {
      const newHostname = `${scriptName}--${orgSlug}.camelai.app`;
      return `${url.protocol}//${newHostname}${url.pathname}${url.search}`;
    }
    // Legacy with env: script.staging.camelai.app -> script--org-slug.staging.camelai.app
    if (parts.length === 4 && (parts[1]?.startsWith('dev-') || parts[1] === 'staging')) {
      const envPrefix = parts[1];
      const newHostname = `${scriptName}--${orgSlug}.${envPrefix}.camelai.app`;
      return `${url.protocol}//${newHostname}${url.pathname}${url.search}`;
    }
  }

  // For .apps.camelai.dev domains
  if (hostname.endsWith('.camelai.dev') && hostname.includes('.apps.')) {
    // Legacy: script.apps.camelai.dev -> script--org-slug.apps.camelai.dev
    if (parts.length === 4 && parts[1] === 'apps') {
      const newHostname = `${scriptName}--${orgSlug}.apps.camelai.dev`;
      return `${url.protocol}//${newHostname}${url.pathname}${url.search}`;
    }
    // Legacy with env: script.apps.staging.camelai.dev -> script--org-slug.apps.staging.camelai.dev
    if (parts.length === 5 && parts[1] === 'apps') {
      const envPrefix = parts[2];
      const newHostname = `${scriptName}--${orgSlug}.apps.${envPrefix}.camelai.dev`;
      return `${url.protocol}//${newHostname}${url.pathname}${url.search}`;
    }
  }

  return url.toString();
}

// ============================================================================
// Tests
// ============================================================================

describe('parseWorkerRoute', () => {
  describe('vanity domain (.camelai.app)', () => {
    it('parses new flat format: script--org-slug.camelai.app', () => {
      const result = parseWorkerRoute('my-app--acme-85b.camelai.app');
      expect(result).toEqual({
        scriptName: 'my-app',
        orgSlug: 'acme-85b',
        dispatchScriptName: 'my-app--acme-85b',
      });
    });

    it('parses new flat format with env prefix: script--org-slug.staging.camelai.app', () => {
      const result = parseWorkerRoute('my-app--acme-85b.staging.camelai.app');
      expect(result).toEqual({
        scriptName: 'my-app',
        orgSlug: 'acme-85b',
        dispatchScriptName: 'my-app--acme-85b',
      });
    });

    it('parses new flat format with dev env prefix: script--org-slug.dev-miguel.camelai.app', () => {
      const result = parseWorkerRoute('my-app--acme-85b.dev-miguel.camelai.app');
      expect(result).toEqual({
        scriptName: 'my-app',
        orgSlug: 'acme-85b',
        dispatchScriptName: 'my-app--acme-85b',
      });
    });

    it('parses legacy format: script.camelai.app', () => {
      const result = parseWorkerRoute('my-app.camelai.app');
      expect(result).toEqual({
        scriptName: 'my-app',
        orgSlug: null,
        dispatchScriptName: 'my-app',
      });
    });

    it('parses legacy format with staging env prefix: script.staging.camelai.app', () => {
      const result = parseWorkerRoute('my-app.staging.camelai.app');
      expect(result).toEqual({
        scriptName: 'my-app',
        orgSlug: null,
        dispatchScriptName: 'my-app',
      });
    });

    it('parses legacy format with dev env prefix: script.dev-miguel.camelai.app', () => {
      const result = parseWorkerRoute('my-app.dev-miguel.camelai.app');
      expect(result).toEqual({
        scriptName: 'my-app',
        orgSlug: null,
        dispatchScriptName: 'my-app',
      });
    });
  });

  describe('same-site domain (.apps.camelai.dev)', () => {
    it('parses new flat format: script--org-slug.apps.camelai.dev', () => {
      const result = parseWorkerRoute('my-app--acme-85b.apps.camelai.dev');
      expect(result).toEqual({
        scriptName: 'my-app',
        orgSlug: 'acme-85b',
        dispatchScriptName: 'my-app--acme-85b',
      });
    });

    it('parses new flat format with env prefix: script--org-slug.apps.staging.camelai.dev', () => {
      const result = parseWorkerRoute('my-app--acme-85b.apps.staging.camelai.dev');
      expect(result).toEqual({
        scriptName: 'my-app',
        orgSlug: 'acme-85b',
        dispatchScriptName: 'my-app--acme-85b',
      });
    });

    it('parses legacy format: script.apps.camelai.dev', () => {
      const result = parseWorkerRoute('my-app.apps.camelai.dev');
      expect(result).toEqual({
        scriptName: 'my-app',
        orgSlug: null,
        dispatchScriptName: 'my-app',
      });
    });

    it('parses legacy format with staging env prefix: script.apps.staging.camelai.dev', () => {
      const result = parseWorkerRoute('my-app.apps.staging.camelai.dev');
      expect(result).toEqual({
        scriptName: 'my-app',
        orgSlug: null,
        dispatchScriptName: 'my-app',
      });
    });

    it('parses legacy format with dev env prefix: script.apps.dev-miguel.camelai.dev', () => {
      const result = parseWorkerRoute('my-app.apps.dev-miguel.camelai.dev');
      expect(result).toEqual({
        scriptName: 'my-app',
        orgSlug: null,
        dispatchScriptName: 'my-app',
      });
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

    it('returns null for malformed separator (empty script)', () => {
      expect(parseWorkerRoute('--acme-85b.camelai.app')).toBeNull();
    });

    it('returns null for malformed separator (empty org)', () => {
      expect(parseWorkerRoute('my-app--.camelai.app')).toBeNull();
    });
  });
});

describe('buildNewFormatUrl', () => {
  describe('vanity domain (.camelai.app)', () => {
    it('converts legacy to new flat format', () => {
      const url = new URL('https://my-app.camelai.app/some/path?query=1');
      const result = buildNewFormatUrl(url, 'my-app', 'acme-85b');
      expect(result).toBe('https://my-app--acme-85b.camelai.app/some/path?query=1');
    });

    it('converts legacy with staging env to new flat format', () => {
      const url = new URL('https://my-app.staging.camelai.app/');
      const result = buildNewFormatUrl(url, 'my-app', 'acme-85b');
      expect(result).toBe('https://my-app--acme-85b.staging.camelai.app/');
    });

    it('converts legacy with dev env to new flat format', () => {
      const url = new URL('https://my-app.dev-miguel.camelai.app/');
      const result = buildNewFormatUrl(url, 'my-app', 'acme-85b');
      expect(result).toBe('https://my-app--acme-85b.dev-miguel.camelai.app/');
    });
  });

  describe('same-site domain (.apps.camelai.dev)', () => {
    it('converts legacy to new flat format', () => {
      const url = new URL('https://my-app.apps.camelai.dev/api/data');
      const result = buildNewFormatUrl(url, 'my-app', 'acme-85b');
      expect(result).toBe('https://my-app--acme-85b.apps.camelai.dev/api/data');
    });

    it('converts legacy with env prefix to new flat format', () => {
      const url = new URL('https://my-app.apps.staging.camelai.dev/');
      const result = buildNewFormatUrl(url, 'my-app', 'acme-85b');
      expect(result).toBe('https://my-app--acme-85b.apps.staging.camelai.dev/');
    });
  });

  it('preserves path and query string', () => {
    const url = new URL('https://my-app.camelai.app/api/users?page=1&limit=10');
    const result = buildNewFormatUrl(url, 'my-app', 'acme-85b');
    expect(result).toBe('https://my-app--acme-85b.camelai.app/api/users?page=1&limit=10');
  });
});

describe('org slug generation', () => {
  // Test the slug generation logic (extracted from workers/main/src/auth.ts)
  function generateOrgSlug(name: string, idPrefix: string): string {
    const base = name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 20) || 'org';
    return `${base}-${idPrefix}`;
  }

  it('generates slug from simple org name', () => {
    expect(generateOrgSlug('Acme Corp', '85b')).toBe('acme-corp-85b');
  });

  it('handles special characters', () => {
    expect(generateOrgSlug('Acme & Co.', 'abc')).toBe('acme-co-abc');
  });

  it('handles multiple spaces', () => {
    expect(generateOrgSlug('My   Cool   Company', 'xyz')).toBe('my-cool-company-xyz');
  });

  it('truncates long names', () => {
    const longName = 'A Very Long Organization Name That Exceeds The Limit';
    const slug = generateOrgSlug(longName, '123');
    expect(slug).toBe('a-very-long-organiza-123');
    expect(slug.length).toBeLessThanOrEqual(24); // 20 + 1 + 3
  });

  it('handles empty name', () => {
    expect(generateOrgSlug('', 'abc')).toBe('org-abc');
  });

  it('handles name with only special characters', () => {
    expect(generateOrgSlug('!!!', 'abc')).toBe('org-abc');
  });
});
