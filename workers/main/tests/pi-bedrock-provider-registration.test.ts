import { describe, expect, it, vi } from 'vitest';

const setBedrockProviderModule = vi.fn();
const bedrockProviderModule = {
  streamBedrock: vi.fn(),
  streamSimpleBedrock: vi.fn(),
};

vi.mock('@earendil-works/pi-ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-ai')>();
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
    await import('../src/chat-thread-do');

    expect(setBedrockProviderModule).toHaveBeenCalledTimes(1);
    expect(setBedrockProviderModule).toHaveBeenCalledWith(bedrockProviderModule);
  }, 15_000);
});
