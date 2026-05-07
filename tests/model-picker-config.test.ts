import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defaultOrgModelPickerConfig,
  parseOrgModelPickerConfig,
  parseWorkspaceModelPickerConfig,
  resolveDefaultModelForChat,
  resolveEffectivePickerConfig,
} from '@/lib/model-picker-config';

describe('model picker config parsing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-06T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the org default for empty or malformed org config values', () => {
    expect(parseOrgModelPickerConfig(null)).toEqual(defaultOrgModelPickerConfig());
    expect(parseOrgModelPickerConfig(undefined)).toEqual(defaultOrgModelPickerConfig());
    expect(parseOrgModelPickerConfig({})).toEqual(defaultOrgModelPickerConfig());
    expect(parseOrgModelPickerConfig('{not json')).toEqual(defaultOrgModelPickerConfig());
  });

  it('normalizes org configs', () => {
    const parsed = parseOrgModelPickerConfig({
      models: [
        { id: 'opus', added_at: 10 },
        { id: 'gpt-99', added_at: 9 },
        { id: 'sonnet' },
      ],
      default_model: 'gpt-99',
    });

    expect(parsed.models).toEqual([
      { id: 'opus', added_at: 10 },
      { id: 'sonnet', added_at: Date.now() },
    ]);
    expect(parsed.default_model).toBeNull();
  });

  it('allows an intentionally empty org picker', () => {
    expect(parseOrgModelPickerConfig({ models: [], default_model: 'sonnet' })).toEqual({
      models: [],
      default_model: null,
    });
  });

  it('caps org picker models at 10', () => {
    const parsed = parseOrgModelPickerConfig({
      models: Array.from({ length: 12 }, (_, index) => ({
        id: index % 2 === 0 ? 'sonnet' : 'opus',
        added_at: index,
      })),
      default_model: 'sonnet',
    });

    expect(parsed.models.length).toBe(2);
  });

  it('parses workspace inheritance defaults without dropping stored override fields', () => {
    expect(parseWorkspaceModelPickerConfig(null)).toEqual({
      use_org_defaults: true,
      models: [],
      default_model: null,
    });
    expect(
      parseWorkspaceModelPickerConfig({
        use_org_defaults: true,
        models: [{ id: 'opus', added_at: 1 }],
        default_model: 'opus',
      }),
    ).toEqual({
      use_org_defaults: true,
      models: [{ id: 'opus', added_at: 1 }],
      default_model: 'opus',
    });
  });

  it('resolves org vs workspace effective config', () => {
    const org = {
      models: [{ id: 'sonnet' as const, added_at: 1 }],
      default_model: 'sonnet' as const,
    };
    const workspace = {
      use_org_defaults: false,
      models: [{ id: 'opus' as const, added_at: 2 }],
      default_model: 'opus' as const,
    };

    expect(resolveEffectivePickerConfig(org, null).source).toBe('org');
    expect(resolveEffectivePickerConfig(org, { ...workspace, use_org_defaults: true })).toMatchObject({
      source: 'org',
      default_model: 'sonnet',
    });
    expect(resolveEffectivePickerConfig(org, workspace)).toMatchObject({
      source: 'workspace',
      default_model: 'opus',
    });
  });
});

describe('default model resolution', () => {
  const visible = (ids: readonly ('opus' | 'sonnet' | 'gpt-5.4')[]) =>
    ids.map((id) => ({ id }));

  it('uses the visible admin default before recent models', () => {
    expect(
      resolveDefaultModelForChat({
        effectiveDefaultModel: 'sonnet',
        recentModel: 'opus',
        visibleCatalog: visible(['opus', 'sonnet']),
      }),
    ).toBe('sonnet');
  });

  it('uses recent model when no visible admin default exists', () => {
    expect(
      resolveDefaultModelForChat({
        effectiveDefaultModel: null,
        recentModel: 'opus',
        visibleCatalog: visible(['opus', 'sonnet']),
      }),
    ).toBe('opus');
  });

  it('falls back to the first visible model', () => {
    expect(
      resolveDefaultModelForChat({
        effectiveDefaultModel: 'sonnet',
        recentModel: null,
        visibleCatalog: visible(['gpt-5.4']),
      }),
    ).toBe('gpt-5.4');
  });

  it('returns null when no models are visible', () => {
    expect(
      resolveDefaultModelForChat({
        effectiveDefaultModel: null,
        recentModel: null,
        visibleCatalog: [],
      }),
    ).toBeNull();
  });
});

