import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getR2ObjectWithRetry, retryR2Read } from '@/lib/r2-read-retry';

describe('retryR2Read', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns immediately when the first read succeeds (no waiting)', async () => {
    const read = vi.fn().mockResolvedValue('object');
    const result = await retryR2Read(read, [100, 200]);
    expect(result).toBe('object');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('retries on the backoff schedule until the object appears', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('object');

    const promise = retryR2Read(read, [100, 200]);
    // Initial attempt runs synchronously; drive the scheduled retries.
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(200);

    await expect(promise).resolves.toBe('object');
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('gives up and returns null once the schedule is exhausted', async () => {
    const read = vi.fn().mockResolvedValue(null);

    const promise = retryR2Read(read, [100, 200]);
    await vi.advanceTimersByTimeAsync(300);

    await expect(promise).resolves.toBeNull();
    // initial attempt + one per delay
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('propagates read errors without retrying', async () => {
    const read = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(retryR2Read(read, [100])).rejects.toThrow('boom');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('getR2ObjectWithRetry reads from the bucket by key', async () => {
    const get = vi.fn().mockResolvedValue({ body: 'data' });
    const result = await getR2ObjectWithRetry({ get }, 'some/key', [100]);
    expect(result).toEqual({ body: 'data' });
    expect(get).toHaveBeenCalledWith('some/key');
  });
});
