import { describe, expect, it } from 'vitest';
import { transformRequestForBedrock, type AnthropicRequestBody } from '../workers/main/src/adapters/bedrock';

function makeBody(model: string): AnthropicRequestBody {
  return {
    model,
    max_tokens: 64,
    messages: [{ role: 'user', content: 'hello' }],
  };
}

const GATEWAY_OPTIONS = {
  cfAccountId: 'acct',
  cfGatewayName: 'gw',
  cfGatewayToken: 'token',
  region: 'us-west-2',
};

describe('transformRequestForBedrock model mapping', () => {
  it('maps sonnet 4.6 to the fixed global endpoint without a version postfix', () => {
    const result = transformRequestForBedrock(makeBody('claude-sonnet-4-6'), GATEWAY_OPTIONS);
    expect(result.url).toContain('/model/global.anthropic.claude-sonnet-4-6/invoke');
    expect(result.url).not.toContain('claude-sonnet-4-6-v1');
    expect(result.url).not.toContain('claude-sonnet-4-6-v1:0');
  });

  it('maps sonnet 4.6 dated variants to the same fixed endpoint', () => {
    const result = transformRequestForBedrock(makeBody('claude-sonnet-4-6-20260201'), GATEWAY_OPTIONS);
    expect(result.url).toContain('/model/global.anthropic.claude-sonnet-4-6/invoke');
  });

  it('keeps unknown model fallback behavior with -v1:0 postfix', () => {
    const result = transformRequestForBedrock(makeBody('claude-custom-model-1'), GATEWAY_OPTIONS);
    expect(result.url).toContain('/model/global.anthropic.claude-custom-model-1-v1:0/invoke');
  });
});
