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
 * Check if a string looks like an environment prefix.
 */
function isEnvPrefix(s: string): boolean {
  return s.startsWith('dev-') || s === 'staging' || s === 'prod';
}

/**
 * Parse worker route from hostname.
 * Returns script name and org slug for new format, or just script name for legacy.
 */
function parseWorkerRoute(hostname: string): { scriptName: string; orgSlug: string | null; dispatchScriptName: string } | null {
  const parts = hostname.split('.');

  // .chiridion.app domain
  if (hostname.endsWith('.chiridion.app')) {
    // Legacy: {script}.chiridion.app (3 parts)
    if (parts.length === 3) {
      const scriptName = parts[0]!;
      return { scriptName, orgSlug: null, dispatchScriptName: scriptName };
    }
    // 4 parts: either new format {script}.{org-slug}.chiridion.app
    //          or legacy with env {script}.{env}.chiridion.app
    if (parts.length === 4) {
      const scriptName = parts[0]!;
      const second = parts[1]!;
      if (isEnvPrefix(second)) {
        // Legacy with env prefix
        return { scriptName, orgSlug: null, dispatchScriptName: scriptName };
      }
      // New format
      const orgSlug = second;
      const dispatchScriptName = `${orgSlug}--${scriptName}`;
      return { scriptName, orgSlug, dispatchScriptName };
    }
    // 5+ parts: new format with env {script}.{org-slug}.{env}.chiridion.app
    if (parts.length >= 5) {
      const scriptName = parts[0]!;
      const orgSlug = parts[1]!;
      const dispatchScriptName = `${orgSlug}--${scriptName}`;
      return { scriptName, orgSlug, dispatchScriptName };
    }
  }

  // .apps.chiridion.ai domain (same-site for iframes)
  if (hostname.endsWith('.chiridion.ai') && hostname.includes('.apps.')) {
    // Legacy: {script}.apps.chiridion.ai (4 parts)
    if (parts.length === 4 && parts[1] === 'apps') {
      const scriptName = parts[0]!;
      return { scriptName, orgSlug: null, dispatchScriptName: scriptName };
    }
    // 5 parts: either new format {script}.{org-slug}.apps.chiridion.ai
    //          or legacy with env {script}.apps.{env}.chiridion.ai
    if (parts.length === 5) {
      const scriptName = parts[0]!;
      const second = parts[1]!;
      if (second === 'apps') {
        // Legacy with env prefix: {script}.apps.{env}.chiridion.ai
        return { scriptName, orgSlug: null, dispatchScriptName: scriptName };
      }
      // New format: {script}.{org-slug}.apps.chiridion.ai
      const orgSlug = second;
      const dispatchScriptName = `${orgSlug}--${scriptName}`;
      return { scriptName, orgSlug, dispatchScriptName };
    }
    // 6+ parts: new format with env {script}.{org-slug}.apps.{env}.chiridion.ai
    if (parts.length >= 6) {
      const scriptName = parts[0]!;
      const orgSlug = parts[1]!;
      const dispatchScriptName = `${orgSlug}--${scriptName}`;
      return { scriptName, orgSlug, dispatchScriptName };
    }
  }

  return null;
}

/**
 * Build the new-format URL for a worker.
 */
function buildNewFormatUrl(url: URL, scriptName: string, orgSlug: string): string {
  const hostname = url.hostname;
  const parts = hostname.split('.');

  // For .chiridion.app domains
  if (hostname.endsWith('.chiridion.app')) {
    if (parts.length === 3) {
      const newHostname = `${scriptName}.${orgSlug}.chiridion.app`;
      return `${url.protocol}//${newHostname}${url.pathname}${url.search}`;
    }
    if (parts.length === 4 && (parts[1]?.startsWith('dev-') || parts[1] === 'staging')) {
      const envPrefix = parts[1];
      const newHostname = `${scriptName}.${orgSlug}.${envPrefix}.chiridion.app`;
      return `${url.protocol}//${newHostname}${url.pathname}${url.search}`;
    }
  }

  // For .apps.chiridion.ai domains
  if (hostname.endsWith('.chiridion.ai') && hostname.includes('.apps.')) {
    if (parts.length === 4 && parts[1] === 'apps') {
      const newHostname = `${scriptName}.${orgSlug}.apps.chiridion.ai`;
      return `${url.protocol}//${newHostname}${url.pathname}${url.search}`;
    }
    if (parts.length === 5 && parts[1] === 'apps') {
      const envPrefix = parts[2];
      const newHostname = `${scriptName}.${orgSlug}.apps.${envPrefix}.chiridion.ai`;
      return `${url.protocol}//${newHostname}${url.pathname}${url.search}`;
    }
  }

  return url.toString();
}

// ============================================================================
// Tests
// ============================================================================

describe('parseWorkerRoute', () => {
  describe('vanity domain (.chiridion.app)', () => {
    it('parses new format: script.org-slug.chiridion.app', () => {
      const result = parseWorkerRoute('my-app.acme-85b.chiridion.app');
      expect(result).toEqual({
        scriptName: 'my-app',
        orgSlug: 'acme-85b',
        dispatchScriptName: 'acme-85b--my-app',
      });
    });

    it('parses new format with env prefix: script.org-slug.staging.chiridion.app', () => {
      const result = parseWorkerRoute('my-app.acme-85b.staging.chiridion.app');
      expect(result).toEqual({
        scriptName: 'my-app',
        orgSlug: 'acme-85b',
        dispatchScriptName: 'acme-85b--my-app',
      });
    });

    it('parses new format with dev env prefix: script.org-slug.dev-miguel.chiridion.app', () => {
      const result = parseWorkerRoute('my-app.acme-85b.dev-miguel.chiridion.app');
      expect(result).toEqual({
        scriptName: 'my-app',
        orgSlug: 'acme-85b',
        dispatchScriptName: 'acme-85b--my-app',
      });
    });

    it('parses legacy format: script.chiridion.app', () => {
      const result = parseWorkerRoute('my-app.chiridion.app');
      expect(result).toEqual({
        scriptName: 'my-app',
        orgSlug: null,
        dispatchScriptName: 'my-app',
      });
    });

    it('parses legacy format with staging env prefix: script.staging.chiridion.app', () => {
      // When org-slug position has an env prefix, treat as legacy
      const result = parseWorkerRoute('my-app.staging.chiridion.app');
      expect(result).toEqual({
        scriptName: 'my-app',
        orgSlug: null,
        dispatchScriptName: 'my-app',
      });
    });

    it('parses legacy format with dev env prefix: script.dev-miguel.chiridion.app', () => {
      const result = parseWorkerRoute('my-app.dev-miguel.chiridion.app');
      expect(result).toEqual({
        scriptName: 'my-app',
        orgSlug: null,
        dispatchScriptName: 'my-app',
      });
    });
  });

  describe('same-site domain (.apps.chiridion.ai)', () => {
    it('parses new format: script.org-slug.apps.chiridion.ai', () => {
      const result = parseWorkerRoute('my-app.acme-85b.apps.chiridion.ai');
      expect(result).toEqual({
        scriptName: 'my-app',
        orgSlug: 'acme-85b',
        dispatchScriptName: 'acme-85b--my-app',
      });
    });

    it('parses new format with env prefix: script.org-slug.apps.staging.chiridion.ai', () => {
      const result = parseWorkerRoute('my-app.acme-85b.apps.staging.chiridion.ai');
      expect(result).toEqual({
        scriptName: 'my-app',
        orgSlug: 'acme-85b',
        dispatchScriptName: 'acme-85b--my-app',
      });
    });

    it('parses legacy format: script.apps.chiridion.ai', () => {
      const result = parseWorkerRoute('my-app.apps.chiridion.ai');
      expect(result).toEqual({
        scriptName: 'my-app',
        orgSlug: null,
        dispatchScriptName: 'my-app',
      });
    });

    it('parses legacy format with staging env prefix: script.apps.staging.chiridion.ai', () => {
      const result = parseWorkerRoute('my-app.apps.staging.chiridion.ai');
      expect(result).toEqual({
        scriptName: 'my-app',
        orgSlug: null,
        dispatchScriptName: 'my-app',
      });
    });

    it('parses legacy format with dev env prefix: script.apps.dev-miguel.chiridion.ai', () => {
      const result = parseWorkerRoute('my-app.apps.dev-miguel.chiridion.ai');
      expect(result).toEqual({
        scriptName: 'my-app',
        orgSlug: null,
        dispatchScriptName: 'my-app',
      });
    });
  });

  describe('invalid hostnames', () => {
    it('returns null for apex domain', () => {
      expect(parseWorkerRoute('chiridion.app')).toBeNull();
    });

    it('returns null for main app domain', () => {
      expect(parseWorkerRoute('chiridion.ai')).toBeNull();
    });

    it('returns null for unrelated domains', () => {
      expect(parseWorkerRoute('example.com')).toBeNull();
    });
  });
});

describe('buildNewFormatUrl', () => {
  describe('vanity domain (.chiridion.app)', () => {
    it('converts legacy to new format', () => {
      const url = new URL('https://my-app.chiridion.app/some/path?query=1');
      const result = buildNewFormatUrl(url, 'my-app', 'acme-85b');
      expect(result).toBe('https://my-app.acme-85b.chiridion.app/some/path?query=1');
    });

    it('converts legacy with staging env to new format', () => {
      const url = new URL('https://my-app.staging.chiridion.app/');
      const result = buildNewFormatUrl(url, 'my-app', 'acme-85b');
      expect(result).toBe('https://my-app.acme-85b.staging.chiridion.app/');
    });

    it('converts legacy with dev env to new format', () => {
      const url = new URL('https://my-app.dev-miguel.chiridion.app/');
      const result = buildNewFormatUrl(url, 'my-app', 'acme-85b');
      expect(result).toBe('https://my-app.acme-85b.dev-miguel.chiridion.app/');
    });
  });

  describe('same-site domain (.apps.chiridion.ai)', () => {
    it('converts legacy to new format', () => {
      const url = new URL('https://my-app.apps.chiridion.ai/api/data');
      const result = buildNewFormatUrl(url, 'my-app', 'acme-85b');
      expect(result).toBe('https://my-app.acme-85b.apps.chiridion.ai/api/data');
    });

    it('converts legacy with env prefix to new format', () => {
      const url = new URL('https://my-app.apps.staging.chiridion.ai/');
      const result = buildNewFormatUrl(url, 'my-app', 'acme-85b');
      expect(result).toBe('https://my-app.acme-85b.apps.staging.chiridion.ai/');
    });
  });

  it('preserves path and query string', () => {
    const url = new URL('https://my-app.chiridion.app/api/users?page=1&limit=10');
    const result = buildNewFormatUrl(url, 'my-app', 'acme-85b');
    expect(result).toBe('https://my-app.acme-85b.chiridion.app/api/users?page=1&limit=10');
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
