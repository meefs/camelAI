// Boot-aware readiness gate for the per-org ProjectBuildSandbox container.
//
// The build container sleeps when idle (see PROJECT_BUILD_SLEEP_AFTER). Waking
// it takes 30-120s, while the deploy_project retry ladder only spans ~15s, so a
// deploy landing on a cold container used to burn all five attempts inside the
// boot window and surface "Build service temporarily unavailable" to the user —
// who then retried straight back into the same boot and concluded builds were
// broken.
//
// This module waits for the container ONCE per build-tool call, on a gentle
// cadence, with a budget that dominates the SDK's own per-call retry budget
// (see PROJECT_BUILD_SDK_RETRY_BUDGET_MS). The existing retry ladder stays
// as-is: it is the right guard for blips on an already-warm container, and it
// runs after readiness.
//
// Two failure classes never wait: a storage-mount misconfiguration
// (isProjectBuildStorageMountError) and a permanent container-startup failure
// (isProjectBuildPermanentStartupError) — retrying either cannot help, so they
// fail fast with their own terminal message instead of burning the budget.
import type { ProjectBuildSandboxLike } from "./project-worker-bundle.js";

/**
 * The sandbox SDK retries its own control-plane upgrade on 503 for
 * `computeRetryTimeoutMs()` = max(120_000, instanceGetTimeoutMS +
 * portReadyTimeoutMS + 30_000) — 30_000 + 90_000 + 30_000 = 150_000 with this
 * repo's (default) container timeouts.
 * Source: node_modules/@cloudflare/sandbox/dist/sandbox-*.js `computeRetryTimeoutMs`.
 * A single probe can therefore block ~135-165s before it rejects: retries stop
 * once elapsed >= retryTimeoutMs - MIN_TIME_FOR_RETRY_MS (15_000), and the last
 * attempt may still take a full 30s connect timeout.
 */
export const PROJECT_BUILD_SDK_RETRY_BUDGET_MS = 150_000;

/**
 * Cold-boot budget. MUST dominate PROJECT_BUILD_SDK_RETRY_BUDGET_MS (plus the
 * ~30s tail of the SDK's final connect attempt), otherwise the very first probe
 * consumes the whole budget and the re-probe loop below never runs — the gate
 * would then add nothing over what the SDK already does internally.
 * Re-check this constant whenever @cloudflare/sandbox is upgraded
 * (tests/project-build-readiness.test.ts asserts the relationship).
 */
export const PROJECT_BUILD_COLD_START_BUDGET_MS = 240_000;

/**
 * Per-probe deadline. capnweb has no client-side call timeout, so a probe whose
 * WebSocket upgrade succeeds against a container that never answers would block
 * forever; this bounds it. Chosen above the SDK's own retry budget + connect
 * tail so a legitimate cold boot is never cut short. Always further clamped to
 * the remaining cold-start budget.
 */
export const PROJECT_BUILD_PROBE_TIMEOUT_MS = 180_000;

/**
 * Budget for a control-plane upgrade that failed with a 500.
 *
 * Under transport "rpc" the SDK discards the response body, so the only signal
 * that survives is the status code: 503 = "container is starting, retry", 500 =
 * the SDK's permanent-startup branch ("Container failed to start due to a
 * permanent error"). A plain DO exception also surfaces as 500, so this is a
 * short bounded budget (a couple of probes) rather than an absolute fast-fail.
 */
export const PROJECT_BUILD_STARTUP_FAILURE_BUDGET_MS = 5_000;

/** Gentle re-probe cadence while the container boots. */
export const PROJECT_BUILD_READY_PROBE_INTERVAL_MS = 1_500;
/** Report "still starting" progress once a wait crosses this threshold. */
export const PROJECT_BUILD_READY_PROGRESS_AFTER_MS = 5_000;
/** Progress text shown while the container boots. */
export const PROJECT_BUILD_COLD_START_PROGRESS_MESSAGE =
  "Build environment is starting…";

export const PROJECT_BUILD_SERVICE_UNAVAILABLE_MESSAGE =
  "Build service temporarily unavailable. Please try again in a moment.";
export const PROJECT_BUILD_STORAGE_MOUNT_MESSAGE =
  "Build sandbox storage is not available in this installation. Retrying will not help. " +
  "Self-hosted installations should upgrade to a release that uses FUSE-free local R2 synchronization, " +
  "then run the self-host container smoke checks.";
export const PROJECT_BUILD_CONTAINER_STARTUP_MESSAGE =
  "Build environment failed to start and will not recover on retry. " +
  "This needs operator attention: check the build container configuration (image, instance limits) and its logs.";

/** Fixed, always-present path — probing it never mutates the workdir. */
const PROJECT_BUILD_READY_PROBE_PATH = "/workspace";

/** Low-cardinality cause for the SDK's permanent-startup class. */
const PERMANENT_STARTUP_CAUSE = "container_startup_permanent";
/** Low-cardinality cause for a 500 on the control-plane upgrade (rpc transport). */
const STARTUP_FAILURE_CAUSE = "container_startup_failed";

/**
 * Markers the sandbox SDK uses for its non-recoverable startup class.
 *
 * The first two are the SDK's own wrapper text (`message` / `suggestion` of the
 * HTTP 500 body); the rest are the underlying platform messages it embeds in
 * `context.error` and matches in `isPermanentStartupError`.
 * Source: node_modules/@cloudflare/sandbox/dist/sandbox-*.js.
 */
const PERMANENT_STARTUP_PATTERNS = [
  /Container failed to start due to a permanent error/i,
  /will not resolve with retries/i,
  /ran out of memory/i,
  /too many subprocesses/i,
  /no application that matches/i,
  /no container application assigned/i,
  /no such image/i,
  /did not call start/i,
] as const;

/**
 * Terminal storage misconfiguration (self-host without FUSE). Checked before
 * the transient classification so a mount failure never waits out the cold-boot
 * budget or the retry ladder.
 */
export function isProjectBuildStorageMountError(error: unknown): boolean {
  const message = errorText(error);
  return /S3FS mount failed/i.test(message) ||
    /fuse:\s*device not found/i.test(message) ||
    /try ['"]?modprobe fuse/i.test(message);
}

/**
 * Terminal container-startup failure: the SDK explicitly classifies these as
 * non-recoverable (bad image, missing container application, OOM at boot, app
 * never called start). Checked before the transient classification so a broken
 * build container fails fast instead of re-probing for the whole budget.
 */
export function isProjectBuildPermanentStartupError(error: unknown): boolean {
  if (isProjectBuildStorageMountError(error)) return false;
  const message = errorText(error);
  return PERMANENT_STARTUP_PATTERNS.some((pattern) => pattern.test(message));
}

export function isProjectBuildServiceUnavailableError(error: unknown): boolean {
  return projectBuildTransientCause(error) !== null;
}

/**
 * Name the transient failure mode so retry/readiness logs and telemetry carry a
 * low-cardinality cause instead of a raw message. Returns null when the error is
 * not one of the known container-wake transients — including the permanent
 * startup class, so the surrounding retry ladder stops retrying it too.
 *
 * Ordering note: under transport "rpc" the real production shape is
 * `RPCTransportError: WebSocket upgrade failed: <status> <text>`, so the
 * upgrade status is matched BEFORE the generic RPCTransportError rule — the
 * status code is the only discriminator the SDK preserves on that path.
 */
export function projectBuildTransientCause(error: unknown): string | null {
  if (error instanceof ProjectBuildProbeTimeoutError) return "probe_timeout";
  if (isProjectBuildPermanentStartupError(error)) return null;
  const message = errorText(error);
  const upgradeStatus = message.match(/WebSocket upgrade failed:\s*(\d{3})/i)?.[1];
  if (upgradeStatus) {
    return upgradeStatus === "500" ? STARTUP_FAILURE_CAUSE : "websocket_upgrade_failed";
  }
  if (/RPCTransportError/i.test(message)) return "rpc_transport";
  if (/Network connection lost/i.test(message)) return "network_connection_lost";
  if (/WebSocket upgrade failed/i.test(message)) return "websocket_upgrade_failed";
  // Capacity/provisioning: the container VM has not been handed out yet. Only
  // reachable when the response body survives (http/websocket transports); the
  // rpc transport collapses it into a 503 upgrade failure.
  if (/no container instance/i.test(message)) return "container_provisioning";
  if (/Container is currently provisioning/i.test(message)) return "container_provisioning";
  if (/503\s+Service\s+Unavailable/i.test(message)) return "service_unavailable";
  if (/Container failed to start/i.test(message)) return "container_failed_to_start";
  return null;
}

function errorText(error: unknown): string {
  return String(error instanceof Error ? `${error.name}: ${error.message}` : error);
}

/** Budget a given transient cause is allowed to spend. */
function budgetForCause(cause: string | null, budgetMs: number): number {
  if (cause === STARTUP_FAILURE_CAUSE) {
    return Math.min(budgetMs, PROJECT_BUILD_STARTUP_FAILURE_BUDGET_MS);
  }
  return budgetMs;
}

/** A probe that blew its own deadline; treated as a transient boot signal. */
export class ProjectBuildProbeTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Project build sandbox probe timed out after ${timeoutMs}ms`);
    this.name = "ProjectBuildProbeTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Cause attached to the thrown unavailable error so the wait is visible in
 * telemetry (the user-facing message stays unchanged).
 */
export class ProjectBuildSandboxNotReadyError extends Error {
  readonly waitedMs: number;
  readonly attempts: number;
  readonly budgetMs: number;

  constructor(input: {
    waitedMs: number;
    attempts: number;
    budgetMs: number;
    cause?: unknown;
  }) {
    super(
      `Project build sandbox was not ready after ${input.waitedMs}ms ` +
      `(${input.attempts} probes, budget ${input.budgetMs}ms)`,
      { cause: input.cause },
    );
    this.name = "ProjectBuildSandboxNotReadyError";
    this.waitedMs = input.waitedMs;
    this.attempts = input.attempts;
    this.budgetMs = input.budgetMs;
  }
}

export type ProjectBuildReadinessEvent =
  | {
    type: "cold_start";
    waitedMs: number;
    attempts: number;
    cause: string | null;
  }
  | {
    type: "ready_timeout";
    waitedMs: number;
    attempts: number;
    budgetMs: number;
    cause: string | null;
  }
  | {
    type: "startup_failed";
    waitedMs: number;
    attempts: number;
    cause: string;
  };

export interface ProjectBuildReadinessResult {
  /** Wall-clock ms spent waiting for the container, including the last probe. */
  waitedMs: number;
  /** Probe count; 1 on the warm path. */
  attempts: number;
  /**
   * True when the container was not immediately available: either a probe
   * failed transiently, or the wait crossed the progress threshold (the SDK
   * absorbs short 503 boots inside a single probe, so a slow first probe is a
   * cold start even though nothing was thrown).
   */
  coldStart: boolean;
}

/** Cancellable deadline for a single probe; the test seam for probe timeouts. */
export interface ProjectBuildProbeDeadline {
  promise: Promise<void>;
  cancel: () => void;
}

export interface EnsureBuildSandboxReadyOptions {
  budgetMs?: number;
  probeIntervalMs?: number;
  progressAfterMs?: number;
  probeTimeoutMs?: number;
  /** Called once, when the wait crosses progressAfterMs. */
  onProgress?: (message: string) => void;
  onEvent?: (event: ProjectBuildReadinessEvent) => void;
  /** Test seams. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timer?: (ms: number) => ProjectBuildProbeDeadline;
  probe?: (sandbox: ProjectBuildSandboxLike) => Promise<unknown>;
}

/**
 * Wait until the build container answers a cheap probe.
 *
 * Warm path: exactly one probe, no event, no added delay. Cold path: re-probe
 * every probeIntervalMs until the container answers or budgetMs is exhausted,
 * with every probe bounded by its own deadline so a hung call cannot outlive
 * the budget. Storage-mount and permanent-startup failures are terminal
 * immediately — they never wait.
 */
export async function ensureBuildSandboxReady(
  sandbox: ProjectBuildSandboxLike,
  options: EnsureBuildSandboxReadyOptions = {},
): Promise<ProjectBuildReadinessResult> {
  const budgetMs = options.budgetMs ?? PROJECT_BUILD_COLD_START_BUDGET_MS;
  const probeIntervalMs = options.probeIntervalMs ?? PROJECT_BUILD_READY_PROBE_INTERVAL_MS;
  const progressAfterMs = options.progressAfterMs ?? PROJECT_BUILD_READY_PROGRESS_AFTER_MS;
  const probeTimeoutMs = options.probeTimeoutMs ?? PROJECT_BUILD_PROBE_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timer = options.timer ?? defaultProbeDeadline;
  const probe = options.probe ?? probeBuildSandbox;

  const startedAtMs = now();
  const elapsed = () => Math.max(0, now() - startedAtMs);
  let attempts = 0;
  let sawTransient = false;
  let announcedProgress = false;
  let lastCause: string | null = null;
  let lastError: unknown = null;

  for (;;) {
    // Budget is checked at the top, not only after a probe settles, so a probe
    // that overran its share cannot buy another full probe window.
    const spentMs = elapsed();
    const currentBudgetMs = budgetForCause(lastCause, budgetMs);
    if (attempts > 0 && spentMs >= currentBudgetMs) {
      throw readinessTimeout({
        waitedMs: spentMs,
        attempts,
        budgetMs: currentBudgetMs,
        cause: lastCause,
        error: lastError,
        onEvent: options.onEvent,
      });
    }
    attempts += 1;
    const probeWindowMs = Math.max(1, Math.min(probeTimeoutMs, currentBudgetMs - spentMs));
    try {
      await runProbeWithDeadline(probe, sandbox, probeWindowMs, timer);
      const waitedMs = elapsed();
      const coldStart = sawTransient || waitedMs >= progressAfterMs;
      if (coldStart) {
        options.onEvent?.({ type: "cold_start", waitedMs, attempts, cause: lastCause });
      }
      return { waitedMs, attempts, coldStart };
    } catch (error) {
      if (isProjectBuildStorageMountError(error)) {
        throw new Error(PROJECT_BUILD_STORAGE_MOUNT_MESSAGE, { cause: error });
      }
      if (isProjectBuildPermanentStartupError(error)) {
        const waitedMs = elapsed();
        options.onEvent?.({
          type: "startup_failed",
          waitedMs,
          attempts,
          cause: PERMANENT_STARTUP_CAUSE,
        });
        throw new Error(PROJECT_BUILD_CONTAINER_STARTUP_MESSAGE, { cause: error });
      }
      const cause = projectBuildTransientCause(error);
      if (cause === null) throw error;
      sawTransient = true;
      lastCause = cause;
      lastError = error;
      const waitedMs = elapsed();
      const causeBudgetMs = budgetForCause(cause, budgetMs);
      if (waitedMs + probeIntervalMs >= causeBudgetMs) {
        throw readinessTimeout({
          waitedMs,
          attempts,
          budgetMs: causeBudgetMs,
          cause,
          error,
          onEvent: options.onEvent,
        });
      }
      // A re-probe against the same live DO can fail instantly on the poisoned
      // control connection the failed attempt left behind (the SDK's deferred
      // transport latches its failure), so an immediate repeat failure means
      // "still booting", not "a fresh signal" — hence the fixed cadence rather
      // than any backoff keyed on how fast the failure came back.
      if (!announcedProgress && waitedMs >= progressAfterMs) {
        announcedProgress = true;
        options.onProgress?.(PROJECT_BUILD_COLD_START_PROGRESS_MESSAGE);
      }
      await sleep(probeIntervalMs);
    }
  }
}

/**
 * Terminal error for an exhausted budget. A repeated 500 upgrade is a broken
 * container rather than a slow boot, so it gets the operator-facing message and
 * its own telemetry event instead of "temporarily unavailable".
 */
function readinessTimeout(input: {
  waitedMs: number;
  attempts: number;
  budgetMs: number;
  cause: string | null;
  error: unknown;
  onEvent?: (event: ProjectBuildReadinessEvent) => void;
}): Error {
  const notReady = new ProjectBuildSandboxNotReadyError({
    waitedMs: input.waitedMs,
    attempts: input.attempts,
    budgetMs: input.budgetMs,
    cause: input.error,
  });
  if (input.cause === STARTUP_FAILURE_CAUSE) {
    input.onEvent?.({
      type: "startup_failed",
      waitedMs: input.waitedMs,
      attempts: input.attempts,
      cause: STARTUP_FAILURE_CAUSE,
    });
    return new Error(PROJECT_BUILD_CONTAINER_STARTUP_MESSAGE, { cause: notReady });
  }
  input.onEvent?.({
    type: "ready_timeout",
    waitedMs: input.waitedMs,
    attempts: input.attempts,
    budgetMs: input.budgetMs,
    cause: input.cause,
  });
  return new Error(PROJECT_BUILD_SERVICE_UNAVAILABLE_MESSAGE, { cause: notReady });
}

async function runProbeWithDeadline(
  probe: (sandbox: ProjectBuildSandboxLike) => Promise<unknown>,
  sandbox: ProjectBuildSandboxLike,
  probeWindowMs: number,
  timer: (ms: number) => ProjectBuildProbeDeadline,
): Promise<void> {
  const deadline = timer(probeWindowMs);
  try {
    const probed = probe(sandbox);
    // Keep a late rejection from surfacing as an unhandled rejection once the
    // deadline has already won the race.
    probed.catch(() => {});
    const outcome = await Promise.race([
      probed.then(() => "ready" as const),
      deadline.promise.then(() => "timeout" as const),
    ]);
    if (outcome === "timeout") throw new ProjectBuildProbeTimeoutError(probeWindowMs);
  } finally {
    deadline.cancel();
  }
}

function defaultProbeDeadline(ms: number): ProjectBuildProbeDeadline {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, ms);
  });
  return {
    promise,
    cancel: () => {
      if (handle !== undefined) clearTimeout(handle);
    },
  };
}

/**
 * Cheapest operation that proves the container is up: the same `exists` call the
 * source-manifest read already makes as its first sandbox touch. `exec` is the
 * fallback for sandbox shapes without `exists`.
 */
async function probeBuildSandbox(sandbox: ProjectBuildSandboxLike): Promise<unknown> {
  if (sandbox.exists) return sandbox.exists(PROJECT_BUILD_READY_PROBE_PATH);
  return sandbox.exec("true", { cwd: "/" });
}
