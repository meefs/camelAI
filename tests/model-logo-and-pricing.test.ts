import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { logoRegistry } from '@/lib/integration-logo-registry';
import {
  ALL_LLM_MODELS,
  LLM_MODEL_TO_PRICING_KEY,
  MODEL_CATALOG,
} from '@/lib/model-catalog';

const root = process.cwd();

describe('model logo registry', () => {
  it('registers model provider logos with expected variants', () => {
    expect(logoRegistry.claude).toBe('single');
    expect(logoRegistry.deepseek).toBe('single');
    expect(logoRegistry.gemini).toBe('single');
    expect(logoRegistry.grok).toBe('themed');
    expect(logoRegistry.kimi).toBe('single');
  });

  it('has logo files for every model provider logo', () => {
    const providerLogos = new Set(
      Object.values(MODEL_CATALOG).map((entry) => entry.providerLogo),
    );

    for (const logo of providerLogos) {
      const variant = logoRegistry[logo];
      if (variant === 'single') {
        expect(fs.existsSync(path.join(root, 'public/logos', `${logo}.svg`))).toBe(true);
      } else {
        expect(fs.existsSync(path.join(root, 'public/logos', `${logo}_light.svg`))).toBe(true);
        expect(fs.existsSync(path.join(root, 'public/logos', `${logo}_dark.svg`))).toBe(true);
      }
    }
  });
});

describe('model pricing coverage', () => {
  it('has Go pricing keys for every supported chat model', () => {
    const goSource = fs.readFileSync(
      path.join(root, 'services/sandbox-host/internal/app/usage_pricing.go'),
      'utf8',
    );

    for (const model of ALL_LLM_MODELS) {
      const pricingKey = LLM_MODEL_TO_PRICING_KEY[model];
      expect(goSource).toContain(`"${pricingKey}"`);
    }
  });

  it('registers new Pi models with the expected harness APIs', () => {
    const source = fs.readFileSync(
      path.join(root, 'services/sandbox-host/pi/container-tools.ts'),
      'utf8',
    );

    expect(source).toMatch(
      /id: "openai\/gpt-5\.5"[\s\S]*?api: "openai-responses"[\s\S]*?contextWindow: 272000/,
    );
    expect(source).toMatch(
      /id: "anthropic\/claude-opus-4\.7"[\s\S]*?api: "anthropic-messages"/,
    );
  });
});
