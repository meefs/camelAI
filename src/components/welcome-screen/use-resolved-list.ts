import { useEffect, useState } from 'react';

function isPromiseLike<T>(
  value: T[] | Promise<T[]> | undefined,
): value is Promise<T[]> {
  return typeof (value as Promise<T[]> | undefined)?.then === 'function';
}

/** Resolve React Router deferred lists while preserving the last good value. */
export function useResolvedList<T>(
  value: T[] | Promise<T[]> | undefined,
  emptyValue: T[],
): T[] {
  const [resolved, setResolved] = useState<T[]>(
    () => (Array.isArray(value) ? value : emptyValue),
  );

  useEffect(() => {
    if (Array.isArray(value)) {
      setResolved(value);
      return;
    }
    if (!isPromiseLike(value)) {
      setResolved(emptyValue);
      return;
    }
    let cancelled = false;
    value.then(
      (next) => {
        if (!cancelled) setResolved(next);
      },
      () => {
        if (!cancelled) setResolved(emptyValue);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [emptyValue, value]);

  return resolved;
}
