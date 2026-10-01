import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ContainerStartFailedError,
  containerStartWorstCaseMs,
  type ContainerStartEvent,
  type ContainerStartPolicy,
  startWithRetry,
} from "../src/container-start";

const POLICY: ContainerStartPolicy = { attemptMs: 1_000, freshImageRetryMs: 5_000, destroyMs: 2_000 };

/** An attempt that never settles unless aborted, like a probe on a stuck container. */
function hang(signal: AbortSignal): Promise<void> {
  return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("startWithRetry", () => {
  it("returns after one attempt when the start is healthy", async () => {
    const reset = vi.fn(async () => {});
    const events: ContainerStartEvent[] = [];
    await expect(
      startWithRetry({ policy: POLICY, label: "env", freshImage: false, attempt: async () => {}, reset, onEvent: (e) => events.push(e) }),
    ).resolves.toMatchObject({ attempts: 1 });
    expect(reset).not.toHaveBeenCalled();
    expect(events.map((e) => e.type)).toEqual(["started"]);
  });

  it("aborts a stuck attempt at its budget, resets, and succeeds on the retry", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const reset = vi.fn(async () => {});
    const events: ContainerStartEvent[] = [];
    const result = startWithRetry({
      policy: POLICY,
      label: "env",
      freshImage: false,
      attempt: (signal) => {
        signals.push(signal);
        return signals.length === 1 ? hang(signal) : Promise.resolve();
      },
      reset,
      onEvent: (e) => events.push(e),
    });
    await vi.advanceTimersByTimeAsync(POLICY.attemptMs);
    await expect(result).resolves.toMatchObject({ attempts: 2 });
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(events.map((e) => e.type)).toEqual(["attempt_failed", "started"]);
    expect(events[0]).toMatchObject({ timedOut: true, budgetMs: POLICY.attemptMs });
  });

  it("gives up after the retry with an error that says nothing ran and a retry is safe", async () => {
    vi.useFakeTimers();
    const reset = vi.fn(async () => {});
    const result = startWithRetry({ policy: POLICY, label: "analysis environment", freshImage: false, attempt: hang, reset })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2 * POLICY.attemptMs);
    const error = await result;
    expect(ContainerStartFailedError.is(error)).toBe(true);
    expect((error as ContainerStartFailedError).attempts).toBe(2);
    expect(String(error)).toMatch(/The analysis environment did not start \(2 attempts.*Nothing ran.*safe/);
    // Both stuck containers were destroyed, so the next call starts clean.
    expect(reset).toHaveBeenCalledTimes(2);
  });

  it("lets the retry wait out an image pull when the image is new to this container", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const result = startWithRetry({
      policy: POLICY,
      label: "env",
      freshImage: true,
      attempt: (signal) => {
        attempts += 1;
        if (attempts === 1) return hang(signal);
        // The pull finishes 4s into the retry: past attemptMs, inside freshImageRetryMs.
        return new Promise((resolve) => setTimeout(resolve, 4_000));
      },
      reset: async () => {},
    });
    await vi.advanceTimersByTimeAsync(POLICY.attemptMs + 4_000);
    await expect(result).resolves.toMatchObject({ attempts: 2 });
  });

  it("does not retry a permanent failure", async () => {
    const attempt = vi.fn(async () => {
      throw new Error("no such image: db-query is missing from the container images");
    });
    const error = await startWithRetry({ policy: POLICY, label: "env", freshImage: false, attempt, reset: async () => {} })
      .catch((cause: unknown) => cause);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(String(error)).toMatch(/could not start: no such image.*Retrying will not help/);
  });

  it("does not retry when the stuck container could not be destroyed", async () => {
    vi.useFakeTimers();
    const attempt = vi.fn(hang);
    const result = startWithRetry({ policy: POLICY, label: "env", freshImage: false, attempt, reset: () => hang(new AbortController().signal) })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(POLICY.attemptMs + POLICY.destroyMs);
    expect(ContainerStartFailedError.is(await result)).toBe(true);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("bounds the worst case at attempt + destroy + the longer retry", () => {
    expect(containerStartWorstCaseMs(POLICY)).toBe(1_000 + 2_000 + 5_000);
  });
});
