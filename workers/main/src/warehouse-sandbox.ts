import { Sandbox, S3FSMountError } from "@cloudflare/sandbox";

import type { Env } from "./types.js";

/**
 * An s3fs mount failure means the workspace prefix is already mounted at the
 * kernel level from a previous container life (this DO instance was recreated,
 * losing the SDK's in-memory mount registry, while the container kept the
 * mount). The SDK surfaces that as a typed `S3FSMountError`, so we branch on the
 * type rather than parsing the message. Any other error (bad binding name,
 * missing binding, invalid path) is a genuine failure.
 */
export function isMountAlreadyPresent(error: unknown): boolean {
  return error instanceof S3FSMountError;
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

  /**
   * Mount the workspace's export prefix read-only into the container so DuckDB
   * can read the staged objects (at `/${prefix}/...` == `/${r2_key}`).
   *
   * The SDK guidance is to mount once per sandbox, not per request, so we guard
   * with in-memory state: repeated calls on a warm container are a no-op. On the
   * first call after the DO instance is (re)created we attempt the mount; if the
   * container already had it mounted from a previous life, s3fs reports the
   * mountpoint busy (`S3FSMountError`), which we treat as already-mounted.
   */
  async ensureExportsMounted(bucketBinding: string, prefix: string): Promise<void> {
    const mountPath = `/${prefix}`;
    if (this.warehouseMountPath === mountPath) return;
    try {
      await this.mountBucket(bucketBinding, mountPath, { prefix: mountPath, readOnly: true });
    } catch (error) {
      if (!isMountAlreadyPresent(error)) throw error;
    }
    this.warehouseMountPath = mountPath;
  }
}
