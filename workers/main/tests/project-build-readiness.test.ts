import { describe, expect, it, vi } from "vitest";

import {
  ensureBuildSandboxReady,
  isProjectBuildPermanentStartupError,
  isProjectBuildServiceUnavailableError,
  isProjectBuildStorageMountError,
  projectBuildTransientCause,
  ProjectBuildSandboxNotReadyError,
  PROJECT_BUILD_COLD_START_BUDGET_MS,
  PROJECT_BUILD_COLD_START_PROGRESS_MESSAGE,
  PROJECT_BUILD_CONTAINER_STARTUP_MESSAGE,
  PROJECT_BUILD_PROBE_TIMEOUT_MS,
  PROJECT_BUILD_SDK_RETRY_BUDGET_MS,
  PROJECT_BUILD_SERVICE_UNAVAILABLE_MESSAGE,
  PROJECT_BUILD_STARTUP_FAILURE_BUDGET_MS,
  PROJECT_BUILD_STORAGE_MOUNT_MESSAGE,
  type ProjectBuildReadinessEvent,
} from "../src/project-build-readiness";
import type { ProjectBuildSandboxLike } from "../src/project-worker-bundle";

/** Virtual clock: sleeps advance time, so the tests never wait in real life. */
function createClock(startMs = 1_000, sleepOvershootMs = 0) {
  let nowMs = startMs;
  const sleeps: number[] = [];
  return {
    now: () => nowMs,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      nowMs += ms + sleepOvershootMs;
    },
    advance: (ms: number) => {
      nowMs += ms;
    },
    sleeps,
  };
}

const TRANSIENT = () => new Error("RPCTransportError: Network connection lost");

function readinessHarness(options: {
  failures: number;
  failureError?: () => unknown;
  budgetMs?: number;
  probeIntervalMs?: number;
  progressAfterMs?: number;
  probeTimeoutMs?: number;
  probeCostMs?: number;
  /** Probe never settles, so only its deadline can end it. */
  probeHangs?: boolean;
  /** Fire probe deadlines (advancing the virtual clock by the window). */
  probeDeadlineFires?: boolean;
  /** Simulate a sleep that overruns the requested cadence. */
  sleepOvershootMs?: number;
}) {
  const clock = createClock(1_000, options.sleepOvershootMs ?? 0);
  const events: ProjectBuildReadinessEvent[] = [];
  const progress: string[] = [];
  const probeWindows: number[] = [];
  let calls = 0;
  const probe = vi.fn(async () => {
    calls += 1;
    clock.advance(options.probeCostMs ?? 0);
    if (options.probeHangs) return new Promise<never>(() => {});
    if (calls <= options.failures) throw (options.failureError ?? TRANSIENT)();
    return { exists: true };
  });
  // Deterministic deadline seam: by default the deadline never fires, so the
  // probe always decides the race; probeDeadlineFires flips it for the
  // hung-probe cases.
  const timer = (ms: number) => {
    probeWindows.push(ms);
    if (!options.probeDeadlineFires) {
      return { promise: new Promise<void>(() => {}), cancel: () => {} };
    }
    return {
      promise: (async () => {
        clock.advance(ms);
      })(),
      cancel: () => {},
    };
  };
  const run = () =>
    ensureBuildSandboxReady({} as ProjectBuildSandboxLike, {
      budgetMs: options.budgetMs ?? 10_000,
      probeIntervalMs: options.probeIntervalMs ?? 1_000,
      progressAfterMs: options.progressAfterMs ?? 5_000,
      ...(options.probeTimeoutMs === undefined ? {} : { probeTimeoutMs: options.probeTimeoutMs }),
      now: clock.now,
      sleep: clock.sleep,
      timer,
      probe,
      onEvent: (event) => events.push(event),
      onProgress: (message) => progress.push(message),
    });
  return { clock, events, progress, probe, probeWindows, run };
}

describe("ensureBuildSandboxReady", () => {
  it("returns after one probe on a warm container without emitting an event", async () => {
    const harness = readinessHarness({ failures: 0 });

    const result = await harness.run();

    expect(result).toMatchObject({ attempts: 1, coldStart: false, waitedMs: 0 });
    expect(harness.probe).toHaveBeenCalledTimes(1);
    expect(harness.clock.sleeps).toEqual([]);
    expect(harness.events).toEqual([]);
    expect(harness.progress).toEqual([]);
  });

  it("waits out a cold boot and reports the cold-start duration", async () => {
    const harness = readinessHarness({ failures: 3, probeCostMs: 100 });

    const result = await harness.run();

    expect(result.attempts).toBe(4);
    expect(result.coldStart).toBe(true);
    // 4 probes at 100ms + 3 sleeps at 1000ms.
    expect(result.waitedMs).toBe(3_400);
    expect(harness.events).toEqual([
      { type: "cold_start", waitedMs: 3_400, attempts: 4, cause: "rpc_transport" },
    ]);
  });

  it("reports progress once, only after the wait crosses the progress threshold", async () => {
    const harness = readinessHarness({ failures: 8, progressAfterMs: 5_000 });

    await harness.run();

    expect(harness.progress).toEqual([PROJECT_BUILD_COLD_START_PROGRESS_MESSAGE]);
  });

  it("throws the unavailable message with the waited time in the cause when the budget is exhausted", async () => {
    const harness = readinessHarness({ failures: Number.POSITIVE_INFINITY, budgetMs: 10_000 });

    const error = await harness.run().then(
      () => null,
      (thrown: unknown) => thrown as Error,
    );

    expect(error?.message).toBe(PROJECT_BUILD_SERVICE_UNAVAILABLE_MESSAGE);
    const cause = error?.cause as ProjectBuildSandboxNotReadyError;
    expect(cause).toBeInstanceOf(ProjectBuildSandboxNotReadyError);
    expect(cause.waitedMs).toBe(9_000);
    expect(cause.attempts).toBe(10);
    expect(cause.budgetMs).toBe(10_000);
    expect(cause.message).toContain("9000ms");
    // The transient probe failure is preserved underneath for triage.
    expect(String((cause.cause as Error).message)).toContain("Network connection lost");
    expect(harness.events).toEqual([
      {
        type: "ready_timeout",
        waitedMs: 9_000,
        attempts: 10,
        budgetMs: 10_000,
        cause: "rpc_transport",
      },
    ]);
  });

  it("fails a storage-mount error immediately instead of waiting out the budget", async () => {
    const harness = readinessHarness({
      failures: Number.POSITIVE_INFINITY,
      budgetMs: PROJECT_BUILD_COLD_START_BUDGET_MS,
      failureError: () =>
        new Error("Container failed to start: S3FS mount failed: fuse: device not found, try modprobe fuse first"),
    });

    await expect(harness.run()).rejects.toThrow(PROJECT_BUILD_STORAGE_MOUNT_MESSAGE);
    expect(harness.probe).toHaveBeenCalledTimes(1);
    expect(harness.clock.sleeps).toEqual([]);
    expect(harness.events).toEqual([]);
  });

  it("fails a permanent container-startup error on the first probe", async () => {
    const harness = readinessHarness({
      failures: Number.POSITIVE_INFINITY,
      budgetMs: PROJECT_BUILD_COLD_START_BUDGET_MS,
      failureError: () =>
        new Error(
          "Container failed to start due to a permanent error. Check your container configuration.",
        ),
    });

    await expect(harness.run()).rejects.toThrow(PROJECT_BUILD_CONTAINER_STARTUP_MESSAGE);
    expect(harness.probe).toHaveBeenCalledTimes(1);
    expect(harness.clock.sleeps).toEqual([]);
    // Not cold-start shaped: this is a configuration failure, not a boot.
    expect(harness.events).toEqual([
      { type: "startup_failed", waitedMs: 0, attempts: 1, cause: "container_startup_permanent" },
    ]);
  });

  it.each([
    "RPCTransportError: no such image",
    "RPCTransportError: container ran out of memory",
    "SandboxError: This error will not resolve with retries.",
  ])("fails fast for the permanent-startup marker %s", async (message) => {
    const harness = readinessHarness({
      failures: Number.POSITIVE_INFINITY,
      budgetMs: PROJECT_BUILD_COLD_START_BUDGET_MS,
      failureError: () => new Error(message),
    });

    await expect(harness.run()).rejects.toThrow(PROJECT_BUILD_CONTAINER_STARTUP_MESSAGE);
    expect(harness.probe).toHaveBeenCalledTimes(1);
  });

  it("gives a 500 control-plane upgrade a few seconds, not the cold-boot budget", async () => {
    // transport:"rpc" discards the SDK's error body, so a 500 upgrade status is
    // the only surviving signal that the container start was permanent.
    const harness = readinessHarness({
      failures: Number.POSITIVE_INFINITY,
      budgetMs: PROJECT_BUILD_COLD_START_BUDGET_MS,
      probeIntervalMs: 1_500,
      failureError: () =>
        new Error("RPCTransportError: WebSocket upgrade failed: 500 Internal Server Error"),
    });

    await expect(harness.run()).rejects.toThrow(PROJECT_BUILD_CONTAINER_STARTUP_MESSAGE);
    // Bounded by PROJECT_BUILD_STARTUP_FAILURE_BUDGET_MS (5s), not 240s.
    expect(harness.probe.mock.calls.length).toBeLessThanOrEqual(4);
    expect(harness.clock.sleeps.reduce((sum, ms) => sum + ms, 0))
      .toBeLessThan(PROJECT_BUILD_STARTUP_FAILURE_BUDGET_MS);
    expect(harness.events).toEqual([
      expect.objectContaining({ type: "startup_failed", cause: "container_startup_failed" }),
    ]);
  });

  it("keeps a 503 control-plane upgrade on the full cold-boot budget", async () => {
    const harness = readinessHarness({
      failures: 6,
      budgetMs: 60_000,
      probeIntervalMs: 1_500,
      failureError: () =>
        new Error("RPCTransportError: WebSocket upgrade failed: 503 Service Unavailable"),
    });

    const result = await harness.run();

    expect(result).toMatchObject({ attempts: 7, coldStart: true });
    expect(harness.events).toEqual([
      expect.objectContaining({ type: "cold_start", cause: "websocket_upgrade_failed" }),
    ]);
  });

  it("bounds a probe that never settles and counts it as a transient boot signal", async () => {
    const harness = readinessHarness({
      failures: 0,
      probeHangs: true,
      probeDeadlineFires: true,
      budgetMs: 10_000,
      probeIntervalMs: 1_000,
      probeTimeoutMs: 4_000,
    });

    const error = await harness.run().then(
      () => null,
      (thrown: unknown) => thrown as Error,
    );

    expect(error?.message).toBe(PROJECT_BUILD_SERVICE_UNAVAILABLE_MESSAGE);
    // Two bounded probes rather than one call blocking forever.
    expect(harness.probe).toHaveBeenCalledTimes(2);
    expect(harness.probeWindows).toEqual([4_000, 4_000]);
    expect(harness.events).toEqual([
      expect.objectContaining({ type: "ready_timeout", cause: "probe_timeout", attempts: 2 }),
    ]);
  });

  it("clamps the last probe window to the remaining budget", async () => {
    const harness = readinessHarness({
      failures: 0,
      probeHangs: true,
      probeDeadlineFires: true,
      budgetMs: 10_000,
      probeIntervalMs: 1_000,
      probeTimeoutMs: 8_000,
    });

    await expect(harness.run()).rejects.toThrow(PROJECT_BUILD_SERVICE_UNAVAILABLE_MESSAGE);
    // 8s probe, 1s sleep, then only 1s of budget is left to spend.
    expect(harness.probeWindows).toEqual([8_000, 1_000]);
  });

  it("stops at the top of the loop when a sleep overruns the budget", async () => {
    const harness = readinessHarness({
      failures: Number.POSITIVE_INFINITY,
      budgetMs: 10_000,
      probeIntervalMs: 1_000,
      // The cadence sleep takes 6s instead of 1s, pushing past the budget
      // between the post-probe check and the next probe.
      sleepOvershootMs: 5_000,
    });

    const error = await harness.run().then(
      () => null,
      (thrown: unknown) => thrown as Error,
    );

    expect(error?.message).toBe(PROJECT_BUILD_SERVICE_UNAVAILABLE_MESSAGE);
    const cause = error?.cause as ProjectBuildSandboxNotReadyError;
    expect(cause.attempts).toBe(2);
    expect(cause.waitedMs).toBeGreaterThanOrEqual(10_000);
    expect(harness.probe).toHaveBeenCalledTimes(2);
  });

  it("treats a slow first probe as a cold start even when nothing threw", async () => {
    // The SDK absorbs short 503 boots inside one call, so the catch branch
    // never runs — the wake must still be reported and annotated.
    const harness = readinessHarness({ failures: 0, probeCostMs: 40_000, budgetMs: 240_000 });

    const result = await harness.run();

    expect(result).toMatchObject({ attempts: 1, coldStart: true, waitedMs: 40_000 });
    expect(harness.events).toEqual([
      { type: "cold_start", waitedMs: 40_000, attempts: 1, cause: null },
    ]);
  });

  it("rethrows a non-transient probe failure without retrying", async () => {
    const harness = readinessHarness({
      failures: Number.POSITIVE_INFINITY,
      failureError: () => new Error("Project builds require org scope"),
    });

    await expect(harness.run()).rejects.toThrow("Project builds require org scope");
    expect(harness.probe).toHaveBeenCalledTimes(1);
    expect(harness.events).toEqual([]);
  });

  it("probes with exists when available and falls back to exec otherwise", async () => {
    const withExists = {
      exists: vi.fn(async () => ({ exists: true })),
      exec: vi.fn(async () => ({ success: true })),
    } as unknown as ProjectBuildSandboxLike;
    await ensureBuildSandboxReady(withExists);
    expect(withExists.exists).toHaveBeenCalledWith("/workspace");
    expect(withExists.exec).not.toHaveBeenCalled();

    const execOnly = { exec: vi.fn(async () => ({ success: true })) } as unknown as ProjectBuildSandboxLike;
    await ensureBuildSandboxReady(execOnly);
    expect(execOnly.exec).toHaveBeenCalledTimes(1);
  });
});

describe("cold-start budget sizing", () => {
  it("dominates the sandbox SDK's own per-call retry budget", () => {
    // The SDK retries its control-plane upgrade internally for
    // computeRetryTimeoutMs(); if our budget did not exceed that (plus the ~30s
    // tail of its final connect attempt), the first probe would consume the
    // whole budget and the re-probe loop would never run.
    expect(PROJECT_BUILD_COLD_START_BUDGET_MS)
      .toBeGreaterThan(PROJECT_BUILD_SDK_RETRY_BUDGET_MS + 30_000);
    // A probe deadline below the SDK budget would cut legitimate boots short.
    expect(PROJECT_BUILD_PROBE_TIMEOUT_MS).toBeGreaterThan(PROJECT_BUILD_SDK_RETRY_BUDGET_MS);
    expect(PROJECT_BUILD_PROBE_TIMEOUT_MS).toBeLessThan(PROJECT_BUILD_COLD_START_BUDGET_MS);
  });
});

describe("project build error classification", () => {
  it.each([
    ["RPCTransportError: boom", "rpc_transport"],
    ["Network connection lost", "network_connection_lost"],
    ["WebSocket upgrade failed: 503 Service Unavailable", "websocket_upgrade_failed"],
    ["RPCTransportError: WebSocket upgrade failed: 503 Service Unavailable", "websocket_upgrade_failed"],
    ["RPCTransportError: WebSocket upgrade failed: 500 Internal Server Error", "container_startup_failed"],
    ["Container is currently provisioning. This can take several minutes", "container_provisioning"],
    ["no container instance available", "container_provisioning"],
    ["got 503 Service Unavailable", "service_unavailable"],
    ["Container failed to start", "container_failed_to_start"],
  ])("names the transient cause for %s", (message, expected) => {
    expect(projectBuildTransientCause(new Error(message))).toBe(expected);
    expect(isProjectBuildServiceUnavailableError(new Error(message))).toBe(true);
  });

  it("treats unrelated failures as non-transient", () => {
    expect(projectBuildTransientCause(new Error("build failed with exit code 1"))).toBeNull();
    expect(isProjectBuildServiceUnavailableError(new Error("build failed with exit code 1"))).toBe(false);
  });

  it("classifies FUSE/S3FS mount failures as terminal", () => {
    expect(isProjectBuildStorageMountError(new Error("S3FS mount failed"))).toBe(true);
    expect(isProjectBuildStorageMountError(new Error("fuse: device not found"))).toBe(true);
    expect(isProjectBuildStorageMountError(new Error("Network connection lost"))).toBe(false);
  });

  it.each([
    "Container failed to start due to a permanent error. Check your container configuration.",
    "This error will not resolve with retries. Check container logs, image name, and resource limits.",
    "no such image",
    "no container application assigned",
    "no application that matches the request",
    "the container ran out of memory",
    "too many subprocesses",
    "container did not call start",
  ])("classifies the permanent startup failure %s as terminal and non-retryable", (message) => {
    expect(isProjectBuildPermanentStartupError(new Error(message))).toBe(true);
    // The retry ladder keys off this: a permanent failure must not be retried.
    expect(projectBuildTransientCause(new Error(message))).toBeNull();
    expect(isProjectBuildServiceUnavailableError(new Error(message))).toBe(false);
  });

  it("keeps transient wake failures out of the permanent class", () => {
    expect(isProjectBuildPermanentStartupError(new Error("Container is starting. Please retry in a moment."))).toBe(false);
    expect(isProjectBuildPermanentStartupError(new Error("RPCTransportError: Network connection lost"))).toBe(false);
    // Storage-mount failures keep their own terminal mapping and message.
    expect(
      isProjectBuildPermanentStartupError(
        new Error("Container failed to start: S3FS mount failed: fuse: device not found"),
      ),
    ).toBe(false);
  });
});
