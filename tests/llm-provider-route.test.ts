import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('LLM provider API route', () => {
  it('uses the current Anthropic model for API key validation', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/routes/api/orgs.$id.llm-provider.ts'),
      'utf8',
    );

    expect(source).toContain("ANTHROPIC_API_KEY_VALIDATION_MODEL = 'claude-sonnet-4-6'");
    expect(source).toContain('model: ANTHROPIC_API_KEY_VALIDATION_MODEL');
    expect(source).not.toContain("model: 'claude-sonnet-4-20250514'");
  });
});
