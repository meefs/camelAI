import { describe, expect, it } from 'vitest';
import { logoRegistry } from '@/lib/integration-logo-registry';
import {
  ALL_LLM_MODELS,
  MODEL_CATALOG,
  LLM_MODEL_TO_PRICING_KEY,
  resolveModelPickerCatalog,
} from '@/lib/model-catalog';

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
      expect([0, 1, 2]).toContain(entry.providerOrder);
      expect(['$', '$$', '$$$']).toContain(entry.cost);
      expect(['low', 'medium', 'high']).toContain(entry.intelligence);
      expect(['slow', 'balanced', 'fast']).toContain(entry.speed);
      expect(entry.label.trim()).not.toBe('');
    }
  });

  it('uses Claude product logos for Anthropic-family models', () => {
    expect(MODEL_CATALOG.opus.providerLogo).toBe('claude');
    expect(MODEL_CATALOG.sonnet.providerLogo).toBe('claude');
    expect(MODEL_CATALOG.haiku.providerLogo).toBe('claude');
  });

  it('has pricing key mappings for every supported model', () => {
    for (const model of ALL_LLM_MODELS) {
      expect(LLM_MODEL_TO_PRICING_KEY[model]).toEqual(expect.any(String));
    }
  });

  it('hides Claude and OpenRouter-only models for OpenAI BYOK orgs', () => {
    const visible = resolveModelPickerCatalog({
      effectiveConfig: {
        source: 'org',
        default_model: null,
        models: [
          { id: 'sonnet', added_at: 1 },
          { id: 'opus', added_at: 2 },
          { id: 'gpt-5.4', added_at: 3 },
          { id: 'gpt-5.4-mini', added_at: 4 },
          { id: 'kimi-k2.6', added_at: 5 },
          { id: 'grok-4.3', added_at: 6 },
        ],
      },
      provider: 'codex',
      orgProvider: 'openai',
    });

    expect(visible.map((entry) => entry.id)).toEqual([
      'gpt-5.4-mini',
      'gpt-5.4',
    ]);
  });
});
