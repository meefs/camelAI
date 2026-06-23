import { Sandbox, S3FSMountError, InvalidMountConfigError } from "@cloudflare/sandbox";

import type { Env } from "./types.js";

/**
 * Both of these mean "the prefix is already mounted" — the state we want — so a
 * mount attempt that hits either is a success, not a failure:
 *
 * - `S3FSMountError`: the workspace prefix is still mounted at the kernel level
 *   from a previous container life (this DO instance was recreated, losing the
 *   SDK's in-memory mount registry, while the container kept the mount), so s3fs
 *   reports the mountpoint busy.
 * - `InvalidMountConfigError` with an "already in use" message: the SDK's own
 *   in-memory registry already holds this path, so it rejects a second mount of
 *   it (e.g. a concurrent `ensureExportsMounted` that mounted it first). We match
 *   the message so genuine config errors — bad bucket name, a different
 *   prefix/readOnly at the same path — still surface as real failures.
 *
 * Any other error (bad binding name, missing binding, invalid path) is genuine.
 */
export function isMountAlreadyPresent(error: unknown): boolean {
  if (error instanceof S3FSMountError) return true;
  if (error instanceof InvalidMountConfigError && /already in use/i.test(String(error.message))) {
    return true;
  }
  return false;
}

/**
 * Single-flight gate: concurrent callers share one in-flight run; once it
 * succeeds the gate stays open and the work never runs again. A failed run is
 * NOT cached, so the next call retries. Pure + unit-testable.
 */
export function createSingleFlight(): (run: () => Promise<void>) => Promise<void> {
  let settled = false;
  let inFlight: Promise<void> | undefined;
  return (run) => {
    if (settled) return Promise.resolve();
    if (!inFlight) {
      inFlight = (async () => {
        await run();
        settled = true;
      })().finally(() => {
        inFlight = undefined;
      });
    }
    return inFlight;
  };
}

/**
 * Sealed analytics container for the warehouse tier.
 *
 * Heavy cross-source DuckDB work runs here — off the Durable Object — for data
 * too big for a DO's CPU/memory. The container is SEALED: `enableInternet =
 * false`, so the agent's code has no network. The only data it can reach is the
 * workspace's own staged exports, which `ensureExportsMounted` mounts read-only
 * from R2 via the platform (egress interception → the R2 binding, NOT the
 * internet), scoped to the workspace's key prefix. No credential ever enters the
 * container.
 *
 * One warm container per workspace (sandboxId = workspaceId); per-call isolation
 * is via sessions. See warehouse-service.ts and docs/warehouse-binding-design.md.
 */
export class WarehouseSandbox extends Sandbox<Env> {
  // Seal the container: agent code gets no internet. The R2 mount is
  // platform-mediated and unaffected by this.
  enableInternet = false;

  // The export prefix currently mounted in this container, if any. Tied to the
  // container lifecycle (this field resets when the DO instance is recreated),
  // so it tracks the actual mount, not DO storage.
  private warehouseMountPath?: string;

  // Coalesces concurrent ensureExportsMounted calls onto a single mount attempt.
  // The Sandbox DO interleaves concurrent RPCs at await points, so two parallel
  // warehouse_run_code invocations on the same warm container would otherwise
  // both pass the guard and call mountBucket — and the SDK rejects the second
  // with InvalidMountConfigError ("mount path already in use"). Tied to the
  // container lifecycle (resets with the DO instance), like warehouseMountPath.
  private readonly mountGate = createSingleFlight();

  /**
   * Mount the workspace's export prefix read-only into the container so DuckDB
   * can read the staged objects (at `/${prefix}/...` == `/${r2_key}`).
   *
   * The SDK guidance is to mount once per sandbox, not per request. The mount
   * runs at most once per container life (the single-flight gate coalesces
   * concurrent callers and caches success); repeated calls on a warm container
   * are a no-op. If the container already had the prefix mounted from a previous
   * life, the attempt hits an already-mounted error which we treat as success
   * (see isMountAlreadyPresent).
   */
  async ensureExportsMounted(bucketBinding: string, prefix: string): Promise<void> {
    const mountPath = `/${prefix}`;
    await this.mountGate(async () => {
      try {
        await this.mountBucket(bucketBinding, mountPath, {
          prefix: mountPath,
          readOnly: true,
          // The SDK defaults to a 60s s3fs stat cache (+ negative caching), so a
          // just-staged export can be read through a stale/partial view for up to
          // a minute — which surfaces as a DuckDB read failure /
          // TransactionException. Shrink it so freshly-written objects are read
          // correctly (the export → read gap exceeds 1s, so this adds no real
          // overhead).
          s3fsOptions: ['stat_cache_expire=1'],
        });
      } catch (error) {
        if (!isMountAlreadyPresent(error)) throw error;
      }
      this.warehouseMountPath = mountPath;
    });
  }
}
