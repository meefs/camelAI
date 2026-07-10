import { Sandbox } from "@cloudflare/sandbox";

import { createSingleFlight, isMountAlreadyPresent } from "./analysis-sandbox.js";
import type { Env } from "./types.js";

/** R2 binding name the export mount resolves against (credential-less mount). */
const WAREHOUSE_EXPORT_BUCKET_BINDING = "WAREHOUSE_EXPORT_BUCKET";

/**
 * Trusted query-execution container with static-IP database egress.
 *
 * Runs NO user code. The query logic is NOT baked in either: db-query-service.ts
 * ships the runner (db-query-sandbox-assets/runner/db-query-runner.mjs) into the
 * container per call by piping it into `node` over stdin (a single stateless
 * exec) and dials the database through the sandbox-host SOCKS relay, so customer
 * databases always see the VM's static egress IP (SANDBOX_OUTBOUND_IP). The
 * image only carries node, the DB drivers, and cloudflared. Authorization
 * happens entirely worker-side BEFORE a query reaches the container.
 *
 * NETWORK POSTURE depends on whether an egress relay is configured (env
 * `DB_EGRESS_RELAY_HOSTNAME`):
 *   - RELAY mode (relay configured): `enableInternet = false` + a block-all
 *     allowlist opened per-run to exactly the relay hostname
 *     (`ensureRelayEgress`). The only egress is the `cloudflared access tcp`
 *     WSS to the relay; database traffic rides inside it, so the container
 *     never dials a customer host directly and the DB sees the VM's static IP.
 *   - DIRECT mode (no relay): `enableInternet = true` so the container can dial
 *     databases straight out — the DB sees whatever IP the Cloudflare container
 *     uses. This is the opt-out when no relay is configured. The runner still
 *     applies the SSRF guard, so internal/link-local targets are refused.
 *
 * DATA OUT (exports): the workspace's warehouse R2 prefix is mounted
 * READ-WRITE via the SDK's credential-less bucket mount (egress interception →
 * the R2 binding, NOT the internet — same mechanism as AnalysisSandbox's
 * read-only mounts), so the export runner writes Parquet extracts straight to
 * R2. One sandbox per workspace + a prefix-scoped mount keeps the bucket
 * multi-tenant-safe: a container can only ever see its own workspace's prefix.
 */
export class DbQuerySandbox extends Sandbox<Env> {
  enableInternet = false;
  allowedHosts: string[] = [];
  // With the internet off, HTTPS to an allowed host only passes when it enters
  // the SDK's interception chain (same posture as AnalysisSandbox); cloudflared
  // trusts the interception CA via the base image's SANDBOX_INTERCEPT_HTTPS
  // handling for spawned processes.
  interceptHttps = true;

  // Mount paths already established in this container + a per-path single-flight
  // gate (same pattern as AnalysisSandbox.ensureMounted). Instance state on a
  // DO — not a module-level cache — so nothing leaks across containers.
  private readonly mountedPaths = new Set<string>();
  private readonly mountGates = new Map<string, (run: () => Promise<void>) => Promise<void>>();

  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- matches the Sandbox base constructor signature
  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    // Direct mode needs general egress (raw TCP to the DB port isn't governed
    // by the HTTP-only allowlist). Decided by deploy config, not per request.
    if (!env.DB_EGRESS_RELAY_HOSTNAME?.trim()) {
      this.enableInternet = true;
    }
  }

  /**
   * Open this container's egress to exactly the relay hostname. Called by
   * db-query-service.ts before each relay-mode run; cheap on a warm container.
   */
  async ensureRelayEgress(relayHostname: string): Promise<void> {
    await this.setAllowedHosts([relayHostname]);
  }

  /**
   * Mount the workspace's warehouse export prefix READ-WRITE at `/<prefix>`,
   * so an export staged at R2 key `<prefix>/x` is written at `/<prefix>/x` —
   * the same `'/' + r2_key` contract the analysis container reads with. At
   * most one mount attempt per path per container life; an already-mounted
   * error from a previous life counts as success.
   */
  async ensureWarehouseExportMount(prefix: string): Promise<void> {
    const mountPath = `/${prefix}`;
    if (this.mountedPaths.has(mountPath)) return;
    let gate = this.mountGates.get(mountPath);
    if (!gate) {
      gate = createSingleFlight();
      this.mountGates.set(mountPath, gate);
    }
    await gate(async () => {
      try {
        await this.mountBucket(WAREHOUSE_EXPORT_BUCKET_BINDING, mountPath, {
          prefix: mountPath,
          readOnly: false,
          // Shrink the s3fs stat cache so a re-export of the same key doesn't
          // read/write through a stale view (matches the analysis mounts).
          s3fsOptions: ["stat_cache_expire=1"],
        });
      } catch (error) {
        if (!isMountAlreadyPresent(error)) throw error;
      }
      this.mountedPaths.add(mountPath);
    });
  }
}
