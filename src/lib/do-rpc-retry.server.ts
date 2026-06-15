const DEFAULT_ATTEMPTS = 3;
const DEFAULT_INITIAL_DELAY_MS = 75;

const TRANSIENT_DO_ERROR_PATTERNS = [
  "durable object reset because its code was updated",
  "durable object storage operation exceeded timeout",
  "caused object to be reset",
  "network connection lost",
];

function getBooleanErrorProperty(error: Error, key: string): boolean {
  return (error as Error & Record<string, unknown>)[key] === true;
}

export function isTransientDurableObjectRpcError(error: unknown): boolean {
  if (!error || !(error instanceof Error)) return false;
  if (getBooleanErrorProperty(error, "overloaded")) return false;
  if (getBooleanErrorProperty(error, "retryable")) return true;
  const message = error.message.toLowerCase();
  return TRANSIENT_DO_ERROR_PATTERNS.some((pattern) =>
    message.includes(pattern),
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface DurableObjectRpcRetryEvent {
  operation: string;
  attempt: number;
  attempts: number;
  error: unknown;
  transient: boolean;
  durationMs: number;
}

export async function retryTransientDurableObjectRpc<T>(
  operation: string,
  fn: () => Promise<T>,
  options: {
    attempts?: number;
    initialDelayMs?: number;
    onRetry?: (event: DurableObjectRpcRetryEvent) => void;
    onFailure?: (event: DurableObjectRpcRetryEvent) => void;
  } = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  const initialDelayMs = Math.max(
    0,
    options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS,
  );
  let lastError: unknown;
  const startedAt = Date.now();

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const transient = isTransientDurableObjectRpcError(error);
      if (attempt >= attempts || !transient) {
        options.onFailure?.({
          operation,
          attempt,
          attempts,
          error,
          transient,
          durationMs: Date.now() - startedAt,
        });
        throw error;
      }

      console.warn("[do-rpc] transient rpc failed; retrying", {
        operation,
        attempt,
        attempts,
        error: error instanceof Error ? error.message : String(error),
      });
      options.onRetry?.({
        operation,
        attempt,
        attempts,
        error,
        transient,
        durationMs: Date.now() - startedAt,
      });
      await delay(initialDelayMs * attempt);
    }
  }

  throw lastError;
}

export const retryTransientDurableObjectRead = retryTransientDurableObjectRpc;
