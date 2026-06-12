import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defaultOrgModelPickerConfig,
  MODEL_PICKER_MAX_MODELS,
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
      { id: 'opus-4.8', added_at: 10 },
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

  it('keeps the default picker within the configured capacity', () => {
    const config = defaultOrgModelPickerConfig();

    expect(MODEL_PICKER_MAX_MODELS).toBe(10);
    expect(config.default_model).toBeNull();
    expect(config.models.map((model) => model.id)).toEqual([
      'fable-5',
      'opus-4.8',
      'sonnet',
      'gpt-5.5',
      'gpt-5.4-mini',
      'gemini-3.5-flash',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'kimi-k2.6',
      'grok-4.3',
    ]);
    expect(config.models.length).toBe(MODEL_PICKER_MAX_MODELS);
    expect(config.models.length).toBeLessThanOrEqual(MODEL_PICKER_MAX_MODELS);
  });

  it('does not set an org default model until a user explicitly chooses one', () => {
    expect(defaultOrgModelPickerConfig().default_model).toBeNull();
    expect(defaultOrgModelPickerConfig('openrouter').default_model).toBeNull();
    expect(defaultOrgModelPickerConfig('openai').default_model).toBeNull();
    expect(defaultOrgModelPickerConfig('anthropic').default_model).toBeNull();
    expect(defaultOrgModelPickerConfig('bedrock').default_model).toBeNull();
  });

  it('uses provider-aware default suites for direct BYOK providers', () => {
    expect(defaultOrgModelPickerConfig('openrouter').models.map((model) => model.id)).toEqual([
      'fable-5',
      'opus-4.8',
      'sonnet',
      'gpt-5.5',
      'gpt-5.4-mini',
      'gemini-3.5-flash',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'kimi-k2.6',
      'grok-4.3',
    ]);
    expect(defaultOrgModelPickerConfig('openai')).toMatchObject({
      default_model: null,
      models: [
        { id: 'gpt-5.5' },
        { id: 'gpt-5.4' },
        { id: 'gpt-5.4-mini' },
      ],
    });
    expect(defaultOrgModelPickerConfig('anthropic')).toMatchObject({
      default_model: null,
      models: [
        { id: 'fable-5' },
        { id: 'opus-4.8' },
        { id: 'sonnet' },
        { id: 'haiku' },
      ],
    });
    expect(defaultOrgModelPickerConfig('bedrock')).toMatchObject({
      default_model: null,
      models: [
        { id: 'fable-5' },
        { id: 'opus-4.8' },
        { id: 'sonnet' },
        { id: 'haiku' },
      ],
    });
    expect(defaultOrgModelPickerConfig('custom', { customApi: 'openai-responses' })).toMatchObject({
      default_model: null,
      models: [
        { id: 'gpt-5.5' },
        { id: 'gpt-5.4' },
        { id: 'gpt-5.4-mini' },
      ],
    });
    expect(defaultOrgModelPickerConfig('custom', { customApi: 'anthropic-messages' })).toMatchObject({
      default_model: null,
      models: [
        { id: 'fable-5' },
        { id: 'opus-4.8' },
        { id: 'sonnet' },
        { id: 'haiku' },
      ],
    });
    expect(defaultOrgModelPickerConfig('custom', {
      customApi: 'openai-responses',
      customModelId: 'pi-custom-model',
    })).toMatchObject({
      default_model: null,
      models: [{ id: 'custom' }],
    });
  });

  it('uses the provider-aware default for empty or malformed org config values', () => {
    expect(parseOrgModelPickerConfig(null, 'openai').models.map((model) => model.id)).toEqual([
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
    ]);
    expect(
      parseOrgModelPickerConfig(null, 'custom', {
        customApi: 'anthropic-messages',
      }).models.map((model) => model.id),
    ).toEqual(['fable-5', 'opus-4.8', 'sonnet', 'haiku']);
    expect(
      parseOrgModelPickerConfig(null, 'custom', {
        customApi: 'openai-responses',
        customModelId: 'pi-custom-model',
      }).models.map((model) => model.id),
    ).toEqual(['custom']);
  });

  it('normalizes newly supported models in stored picker configs', () => {
    const parsed = parseOrgModelPickerConfig({
      models: [
        { id: 'gpt-5.5', added_at: 5 },
        { id: 'opus-4.8', added_at: 4 },
        { id: 'gemini-3-flash-preview', added_at: 4 },
        { id: 'gemini-3.5-flash', added_at: 3 },
        { id: 'deepseek-v4-pro', added_at: 2 },
        { id: 'deepseek-v4-flash', added_at: 1 },
      ],
      default_model: 'deepseek-v4-flash',
    });

    expect(parsed).toEqual({
      models: [
        { id: 'gpt-5.5', added_at: 5 },
        { id: 'opus-4.8', added_at: 4 },
        { id: 'gemini-3-flash-preview', added_at: 4 },
        { id: 'gemini-3.5-flash', added_at: 3 },
        { id: 'deepseek-v4-pro', added_at: 2 },
        { id: 'deepseek-v4-flash', added_at: 1 },
      ],
      default_model: 'deepseek-v4-flash',
    });
  });

  it('remaps legacy Gemini 3.1 Pro Preview rows and defaults', () => {
    const parsed = parseOrgModelPickerConfig({
      models: [
        { id: 'gpt-5.5', added_at: 5 },
        { id: 'gemini-3.1-pro-preview', added_at: 4 },
      ],
      default_model: 'gemini-3.1-pro-preview',
    });

    expect(parsed).toEqual({
      models: [
        { id: 'gpt-5.5', added_at: 5 },
        { id: 'gemini-3.5-flash', added_at: 4 },
      ],
      default_model: 'gemini-3.5-flash',
    });
  });

  it('dedupes legacy and current Gemini rows after remapping', () => {
    const parsed = parseWorkspaceModelPickerConfig({
      use_org_defaults: false,
      models: [
        { id: 'gemini-3.1-pro-preview', added_at: 4 },
        { id: 'gemini-3.5-flash', added_at: 3 },
        { id: 'gemini-3-flash-preview', added_at: 2 },
      ],
      default_model: 'gemini-3.5-flash',
    });

    expect(parsed).toEqual({
      use_org_defaults: false,
      models: [
        { id: 'gemini-3.5-flash', added_at: 4 },
        { id: 'gemini-3-flash-preview', added_at: 2 },
      ],
      default_model: 'gemini-3.5-flash',
    });
  });

  it('parses workspace inheritance defaults and remaps legacy Opus fields', () => {
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
      models: [{ id: 'opus-4.8', added_at: 1 }],
      default_model: 'opus-4.8',
    });
  });

  it('resolves org vs workspace effective config', () => {
    const org = {
      models: [{ id: 'sonnet' as const, added_at: 1 }],
      default_model: 'sonnet' as const,
    };
    const workspace = {
      use_org_defaults: false,
      models: [{ id: 'opus-4.8' as const, added_at: 2 }],
      default_model: 'opus-4.8' as const,
    };

    expect(resolveEffectivePickerConfig(org, null).source).toBe('org');
    expect(resolveEffectivePickerConfig(org, { ...workspace, use_org_defaults: true })).toMatchObject({
      source: 'org',
      default_model: 'sonnet',
    });
    expect(resolveEffectivePickerConfig(org, workspace)).toMatchObject({
      source: 'workspace',
      default_model: 'opus-4.8',
    });
  });
});

describe('default model resolution', () => {
  const visible = (ids: readonly ('opus-4.8' | 'sonnet' | 'gpt-5.4')[]) =>
    ids.map((id) => ({ id }));

  it('uses the visible admin default before recent models', () => {
    expect(
      resolveDefaultModelForChat({
        effectiveDefaultModel: 'sonnet',
        recentModel: 'opus-4.8',
        visibleCatalog: visible(['opus-4.8', 'sonnet']),
      }),
    ).toBe('sonnet');
  });

  it('uses recent model when no visible admin default exists', () => {
    expect(
      resolveDefaultModelForChat({
        effectiveDefaultModel: null,
        recentModel: 'opus-4.8',
        visibleCatalog: visible(['opus-4.8', 'sonnet']),
      }),
    ).toBe('opus-4.8');
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

  it('uses the fallback model before the first visible model', () => {
    expect(
      resolveDefaultModelForChat({
        effectiveDefaultModel: null,
        recentModel: null,
        fallbackModel: 'sonnet',
        visibleCatalog: visible(['opus-4.8', 'sonnet']),
      }),
    ).toBe('sonnet');
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
