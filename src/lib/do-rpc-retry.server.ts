const DEFAULT_ATTEMPTS = 3;
const DEFAULT_INITIAL_DELAY_MS = 75;

const TRANSIENT_DO_ERROR_PATTERNS = [
  "durable object reset because its code was updated",
  "network connection lost",
];

export function isTransientDurableObjectRpcError(error: unknown): boolean {
  if (!error || !(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return TRANSIENT_DO_ERROR_PATTERNS.some((pattern) =>
    message.includes(pattern),
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retryTransientDurableObjectRpc<T>(
  operation: string,
  fn: () => Promise<T>,
  options: { attempts?: number; initialDelayMs?: number } = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  const initialDelayMs = Math.max(
    0,
    options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS,
  );
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (
        attempt >= attempts ||
        !isTransientDurableObjectRpcError(error)
      ) {
        throw error;
      }

      console.warn("[do-rpc] transient rpc failed; retrying", {
        operation,
        attempt,
        attempts,
        error: error instanceof Error ? error.message : String(error),
      });
      await delay(initialDelayMs * attempt);
    }
  }

  throw lastError;
}

export const retryTransientDurableObjectRead = retryTransientDurableObjectRpc;
