import { describe, expect, it } from 'vitest';
import { logoRegistry } from '@/lib/integration-logo-registry';
import {
  ALL_LLM_MODELS,
  LLM_MODEL_TO_PRICING_KEY,
  MODEL_CATALOG,
  resolveModelPickerCatalog,
} from '@/lib/model-catalog';
import type { LlmModel } from '@/types';

const NEW_OPENROUTER_MODELS: Array<{
  id: LlmModel;
  label: string;
  providerLogo: string;
  providerOrder: number;
  modelOrder: number;
  pricingKey: string;
  cost: string;
  intelligence: string;
  speed: string;
}> = [
  {
    id: 'gemini-3-flash-preview',
    label: 'Gemini 3 Flash Preview',
    providerLogo: 'gemini',
    providerOrder: 2,
    modelOrder: 1,
    pricingKey: 'google/gemini-3-flash-preview',
    cost: '$',
    intelligence: 'low',
    speed: 'fast',
  },
  {
    id: 'gemini-3.1-pro-preview',
    label: 'Gemini 3.1 Pro Preview',
    providerLogo: 'gemini',
    providerOrder: 2,
    modelOrder: 0,
    pricingKey: 'google/gemini-3.1-pro-preview',
    cost: '$$',
    intelligence: 'high',
    speed: 'balanced',
  },
  {
    id: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    providerLogo: 'deepseek',
    providerOrder: 3,
    modelOrder: 0,
    pricingKey: 'deepseek/deepseek-v4-pro',
    cost: '$',
    intelligence: 'medium',
    speed: 'balanced',
  },
  {
    id: 'deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    providerLogo: 'deepseek',
    providerOrder: 3,
    modelOrder: 1,
    pricingKey: 'deepseek/deepseek-v4-flash',
    cost: '$',
    intelligence: 'low',
    speed: 'fast',
  },
];

const NEW_FRONTIER_MODELS: Array<{
  id: LlmModel;
  label: string;
  providerLogo: string;
  pricingKey: string;
  cost: string;
}> = [
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    providerLogo: 'openai',
    pricingKey: 'gpt-5.5',
    cost: '$$$',
  },
  {
    id: 'opus-4.7',
    label: 'Opus 4.7',
    providerLogo: 'claude',
    pricingKey: 'claude-opus-4-7',
    cost: '$$$',
  },
];

describe('MODEL_CATALOG', () => {
  it('has one entry for every supported LlmModel', () => {
    for (const model of ALL_LLM_MODELS) {
      expect(MODEL_CATALOG[model]).toBeDefined();
      expect(MODEL_CATALOG[model].id).toBe(model);
    }
  });

  it('uses registered logo types', () => {
    for (const entry of Object.values(MODEL_CATALOG)) {
      expect(logoRegistry[entry.providerLogo]).toBeDefined();
    }
  });

  it('keeps metadata values in the expected finite sets', () => {
    for (const entry of Object.values(MODEL_CATALOG)) {
      expect([0, 1, 2, 3, 4, 5]).toContain(entry.providerOrder);
      expect(entry.modelOrder).toBeGreaterThanOrEqual(0);
      expect(['$', '$$', '$$$']).toContain(entry.cost);
      expect(['low', 'medium', 'high']).toContain(entry.intelligence);
      expect(['slow', 'balanced', 'fast']).toContain(entry.speed);
      expect(entry.label.trim()).not.toBe('');
    }
  });

  it('uses Claude product logos for Anthropic-family models', () => {
    expect(MODEL_CATALOG.opus.providerLogo).toBe('claude');
    expect(MODEL_CATALOG['opus-4.7'].providerLogo).toBe('claude');
    expect(MODEL_CATALOG.sonnet.providerLogo).toBe('claude');
    expect(MODEL_CATALOG.haiku.providerLogo).toBe('claude');
  });

  it('has pricing key mappings for every supported model', () => {
    for (const model of ALL_LLM_MODELS) {
      expect(LLM_MODEL_TO_PRICING_KEY[model]).toEqual(expect.any(String));
    }
  });

  it('adds Gemini and DeepSeek metadata with OpenRouter pricing keys', () => {
    for (const expected of NEW_OPENROUTER_MODELS) {
      expect(MODEL_CATALOG[expected.id]).toMatchObject({
        id: expected.id,
        label: expected.label,
        providerLogo: expected.providerLogo,
        providerOrder: expected.providerOrder,
        modelOrder: expected.modelOrder,
        cost: expected.cost,
        intelligence: expected.intelligence,
        speed: expected.speed,
      });
      expect(LLM_MODEL_TO_PRICING_KEY[expected.id]).toBe(expected.pricingKey);
    }
  });

  it('adds GPT-5.5 and Opus 4.7 as distinct priced models', () => {
    for (const expected of NEW_FRONTIER_MODELS) {
      expect(MODEL_CATALOG[expected.id]).toMatchObject({
        id: expected.id,
        label: expected.label,
        providerLogo: expected.providerLogo,
        cost: expected.cost,
      });
      expect(LLM_MODEL_TO_PRICING_KEY[expected.id]).toBe(expected.pricingKey);
    }
    expect(MODEL_CATALOG.opus.label).toBe('Opus 4.6');
    expect(LLM_MODEL_TO_PRICING_KEY.opus).toBe('claude-opus-4-6');
  });

  it('hides Claude and OpenRouter-only models for OpenAI BYOK orgs', () => {
    const visible = resolveModelPickerCatalog({
      effectiveConfig: {
        source: 'org',
        default_model: null,
        models: [
          { id: 'sonnet', added_at: 1 },
          { id: 'opus', added_at: 2 },
          { id: 'opus-4.7', added_at: 11 },
          { id: 'gpt-5.5', added_at: 12 },
          { id: 'gpt-5.4', added_at: 3 },
          { id: 'gpt-5.4-mini', added_at: 4 },
          { id: 'kimi-k2.6', added_at: 5 },
          { id: 'grok-4.3', added_at: 6 },
          { id: 'gemini-3-flash-preview', added_at: 7 },
          { id: 'gemini-3.1-pro-preview', added_at: 8 },
          { id: 'deepseek-v4-pro', added_at: 9 },
          { id: 'deepseek-v4-flash', added_at: 10 },
        ],
      },
      provider: 'codex',
      orgProvider: 'openai',
    });

    expect(visible.map((entry) => entry.id)).toEqual([
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
    ]);
  });

  it('keeps OpenRouter picker models grouped by provider, then model order', () => {
    const visible = resolveModelPickerCatalog({
      effectiveConfig: {
        source: 'org',
        default_model: null,
        models: [
          { id: 'deepseek-v4-flash', added_at: 40 },
          { id: 'gemini-3-flash-preview', added_at: 30 },
          { id: 'deepseek-v4-pro', added_at: 20 },
          { id: 'gemini-3.1-pro-preview', added_at: 10 },
          { id: 'grok-4.3', added_at: 60 },
          { id: 'kimi-k2.6', added_at: 50 },
        ],
      },
      provider: 'codex',
      orgProvider: 'openrouter',
    });

    expect(visible.map((entry) => entry.id)).toEqual([
      'gemini-3.1-pro-preview',
      'gemini-3-flash-preview',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'kimi-k2.6',
      'grok-4.3',
    ]);
  });
});
