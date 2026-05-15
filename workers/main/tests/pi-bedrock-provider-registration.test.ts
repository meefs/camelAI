import { describe, expect, it, vi } from 'vitest';

const setBedrockProviderModule = vi.fn();
const bedrockProviderModule = {
  streamBedrock: vi.fn(),
  streamSimpleBedrock: vi.fn(),
};

vi.mock('@mariozechner/pi-ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mariozechner/pi-ai')>();
  return {
    ...actual,
    setBedrockProviderModule,
  };
});

vi.mock('../src/pi-bedrock-provider', () => ({
  bedrockProviderModule,
}));

describe('Pi Bedrock provider registration', () => {
  it('registers the Bedrock provider module during worker initialization', async () => {
    await import('../src/durable-objects');

    expect(setBedrockProviderModule).toHaveBeenCalledTimes(1);
    expect(setBedrockProviderModule).toHaveBeenCalledWith(bedrockProviderModule);
  });
});
