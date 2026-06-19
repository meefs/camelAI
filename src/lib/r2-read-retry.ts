/**
 * Bounded retry around R2 reads to absorb the brief window where a freshly
 * referenced object is not yet readable.
 *
 * `set_preview` (and uploads in general) can point the preview window at an R2
 * object a fraction of a second before the producer finishes writing it. A
 * single `get`/`head` then 404s for a few seconds, and the preview window
 * shows a sticky "file no longer exists" error even though the object is on
 * its way. Retrying the read a few times with short backoff bridges that race
 * while still surfacing a genuine miss (null) once the budget is exhausted.
 */

const DEFAULT_R2_READ_RETRY_DELAYS_MS = [150, 300, 600, 900, 1200] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Invoke `read` and, while it resolves to `null`, retry on the given backoff
 * schedule. Returns the first non-null result, or `null` if every attempt
 * (initial + one per delay) comes back empty. Errors are not caught here so
 * real failures still propagate loudly.
 */
export async function retryR2Read<T>(
  read: () => Promise<T | null>,
  delaysMs: readonly number[] = DEFAULT_R2_READ_RETRY_DELAYS_MS,
): Promise<T | null> {
  let result = await read();
  for (let i = 0; result === null && i < delaysMs.length; i += 1) {
    await sleep(delaysMs[i]);
    result = await read();
  }
  return result;
}

/**
 * Convenience wrapper around {@link retryR2Read} for the common
 * `bucket.get(key)` case. Generic over the bucket's object type so callers do
 * not need the Cloudflare R2 globals in scope.
 */
export function getR2ObjectWithRetry<T>(
  bucket: { get: (key: string) => Promise<T | null> },
  key: string,
  delaysMs?: readonly number[],
): Promise<T | null> {
  return retryR2Read(() => bucket.get(key), delaysMs);
}
