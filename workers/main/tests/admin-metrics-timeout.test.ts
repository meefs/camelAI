import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSpamOrgIds } from '../src/routes/admin/metrics';
import type { Env as WorkerEnv } from '../src/types';

describe('admin metrics sandbox host requests', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('times out stalled sandbox-host metrics calls', async () => {
    vi.useFakeTimers();
    const sandboxFetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      })
    ));
    const env = {
      SANDBOX_HOST: { fetch: sandboxFetch },
    } as unknown as WorkerEnv;

    const result = expect(fetchSpamOrgIds(env)).rejects.toThrow(
      'Sandbox host metrics request timed out after 5000ms',
    );

    await vi.advanceTimersByTimeAsync(5_000);
    await result;
  });
});
