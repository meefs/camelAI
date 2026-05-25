import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getDevEmailOutboxEntryById,
  isDevEmailOutboxEnabled,
  listDevEmailOutboxEntries,
  recordDevEmailOutboxEntry,
} from '@/lib/dev-email-outbox';

class MemoryKvNamespace {
  private readonly data = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  async list(options?: { prefix?: string; limit?: number; cursor?: string }) {
    const prefix = options?.prefix ?? '';
    const limit = options?.limit ?? 1000;
    const cursor = options?.cursor ? Number.parseInt(options.cursor, 10) : 0;

    const names = [...this.data.keys()]
      .filter((name) => name.startsWith(prefix))
      .sort();
    const page = names.slice(cursor, cursor + limit);
    const nextCursor = cursor + page.length;

    return {
      keys: page.map((name) => ({
        name,
        expiration: undefined,
        metadata: null,
      })),
      list_complete: nextCursor >= names.length,
      cursor: nextCursor >= names.length ? '' : `${nextCursor}`,
    };
  }
}

describe('dev-email-outbox', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is enabled only in development with APP_KV', () => {
    const kv = new MemoryKvNamespace();

    expect(isDevEmailOutboxEnabled({ NEXTJS_ENV: 'development', APP_KV: kv as unknown as KVNamespace })).toBe(true);
    expect(isDevEmailOutboxEnabled({ NEXTJS_ENV: 'production', APP_KV: kv as unknown as KVNamespace })).toBe(false);
    expect(isDevEmailOutboxEnabled({ NEXTJS_ENV: 'development' })).toBe(false);
  });

  it('records and retrieves an entry by id', async () => {
    const kv = new MemoryKvNamespace();
    const env = { NEXTJS_ENV: 'development', APP_KV: kv as unknown as KVNamespace };

    const id = await recordDevEmailOutboxEntry(env, {
      to: 'jane@example.com',
      cc: 'support@camelai.com',
      replyTo: 'support@camelai.com',
      subject: 'Test subject',
      textBody: 'hello text',
      htmlBody: '<p>hello html</p>',
      status: 'sent',
      transport: 'cloudflare_email',
    });

    expect(id).toBeTruthy();

    const entry = await getDevEmailOutboxEntryById(env, id!);
    expect(entry).not.toBeNull();
    expect(entry?.subject).toBe('Test subject');
    expect(entry?.to).toBe('jane@example.com');
    expect(entry?.status).toBe('sent');
    expect(entry?.transport).toBe('cloudflare_email');
  });

  it('lists newest entries first', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-19T10:00:00.000Z'));

    const kv = new MemoryKvNamespace();
    const env = { NEXTJS_ENV: 'development', APP_KV: kv as unknown as KVNamespace };

    await recordDevEmailOutboxEntry(env, {
      to: 'first@example.com',
      subject: 'First',
      textBody: 'first text',
      htmlBody: '<p>first html</p>',
      status: 'sent',
      transport: 'cloudflare_email',
    });
    vi.setSystemTime(new Date('2026-02-19T10:00:01.000Z'));
    await recordDevEmailOutboxEntry(env, {
      to: 'second@example.com',
      subject: 'Second',
      textBody: 'second text',
      htmlBody: '<p>second html</p>',
      status: 'failed',
      reason: 'smtp rejected',
      transport: 'cloudflare_email',
    });

    const list = await listDevEmailOutboxEntries(env, { limit: 10 });
    expect(list.entries.length).toBe(2);
    expect(list.entries[0]?.subject).toBe('Second');
    expect(list.entries[1]?.subject).toBe('First');
  });
});
