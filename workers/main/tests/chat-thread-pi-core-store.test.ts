import { describe, expect, it, vi } from 'vitest';
import { PiCoreMessageStore } from '../src/chat-thread/pi-core-store';

function externalImageMessage(key = 'private/org/workspace/image.base64') {
  return {
    role: 'toolResult',
    toolCallId: 'call-1',
    toolName: 'read',
    content: [{
      type: 'image',
      mimeType: 'image/png',
      data: '',
      metadata: {
        chiridionR2Image: {
          key,
          mimeType: 'image/png',
          size: 900_000,
          sha256: 'abc123',
          storedAt: 1,
        },
      },
    }],
    isError: false,
    timestamp: 1,
  };
}

function createReadHarness(payloads: string[]) {
  const operations = { payloadRowsParsed: 0, r2ImagesHydrated: 0 };
  const get = vi.fn(async () => ({ text: async () => 'provider-image-data' }));
  const exec = vi.fn((sql: string) => {
    if (sql.trimStart().startsWith('CREATE TABLE') || sql.includes('INSERT OR IGNORE INTO pi_core_state')) {
      return { toArray: () => [] };
    }
    if (sql.includes('FROM pi_core_compaction')) {
      return { toArray: () => [] };
    }
    if (sql.includes('SELECT payload FROM pi_core_messages')) {
      return { toArray: () => payloads.map((payload) => ({ payload })) };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const store = new PiCoreMessageStore({
    sql: () => ({ exec }) as never,
    r2: () => ({ get }) as never,
    chatContext: () => null,
    recordReadOperation: (operation) => {
      if (operation === 'payload_row_parsed') operations.payloadRowsParsed += 1;
      if (operation === 'r2_image_hydrated') operations.r2ImagesHydrated += 1;
    },
  });
  return { store, operations, get };
}

describe('PiCoreMessageStore image hydration policy', () => {
  it('uses bounded render-safe markers without hydrating or leaking R2 keys', async () => {
    const privateKey = 'org-secret/workspace-secret/pi-images/object.base64';
    const harness = createReadHarness([
      JSON.stringify(externalImageMessage(privateKey)),
    ]);

    const messages = await harness.store.loadPiCoreMessages({
      includeUiMetadata: true,
      imageHydration: 'render',
    });

    expect(harness.operations).toEqual({
      payloadRowsParsed: 1,
      r2ImagesHydrated: 0,
    });
    expect(harness.get).not.toHaveBeenCalled();
    expect(messages[0].content).toEqual([{
      type: 'text',
      text: '(persisted image omitted from render: image/png, 900000 base64 chars)',
    }]);
    expect(JSON.stringify(messages)).not.toContain(privateKey);
    expect(JSON.stringify(messages)).not.toContain('chiridionR2Image');
  });

  it('retains provider hydration for model context reads', async () => {
    const harness = createReadHarness([
      JSON.stringify(externalImageMessage()),
    ]);

    const messages = await harness.store.loadPiCoreMessages();

    expect(harness.operations).toEqual({
      payloadRowsParsed: 1,
      r2ImagesHydrated: 1,
    });
    expect(harness.get).toHaveBeenCalledTimes(1);
    expect(messages[0].content).toEqual([
      expect.objectContaining({ type: 'image', data: 'provider-image-data' }),
    ]);
  });

  it('deduplicates against image-bearing history without R2 hydration', async () => {
    const harness = createReadHarness([
      JSON.stringify({
        ...externalImageMessage(),
        role: 'assistant',
        responseId: 'response-1',
      }),
    ]);
    const append = vi.spyOn(harness.store, 'appendPiCoreMessages').mockResolvedValue();

    await harness.store.appendPiCoreMessagesIfMissing([{
      role: 'assistant',
      responseId: 'response-1',
      content: [{ type: 'text', text: 'finalized' }],
      timestamp: 2,
    } as never]);

    expect(harness.operations.r2ImagesHydrated).toBe(0);
    expect(harness.get).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledWith([]);
  });
});
