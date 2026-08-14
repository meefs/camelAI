import { Sandbox } from "@cloudflare/sandbox";

import {
  PROJECT_BUILD_ACTIVE_SESSION_WINDOW_MS,
  PROJECT_BUILD_SLEEP_AFTER,
} from "./container-sizing.js";
import { recordObservabilityEvent } from "./observability.js";
import {
  nextBuildSessionDeadline,
  PROJECT_BUILD_SESSION_ACTIVITY_KEY,
  shouldKeepBuildSandboxAwake,
} from "./project-build-sandbox-lifecycle.js";
import type { Env } from "./types.js";

/**
 * Warm per-org build container for DO+R2-backed projects.
 *
 * This is intentionally separate from AnalysisSandbox: builds execute arbitrary
 * package install/build code and need npm registry egress, while analysis
 * egress is allowlisted. Callers still run only fixed platform-issued commands
 * here. Sized as standard-3 (see container-sizing.ts) — enough vCPU for
 * Vite/esbuild parallelism without standard-4's provisioned memory/disk.
 */
export class ProjectBuildSandbox extends Sandbox<Env> {
  sleepAfter = PROJECT_BUILD_SLEEP_AFTER;

  /**
   * Mark the org's build session active, deferring the idle reaper until the
   * window lapses. Called by the build tools when a build FINISHES, so the
   * window is a post-build tail rather than something a mere readiness probe
   * can start.
   *
   * The guarantee is bounded warmth, not "only active workspaces": this defers
   * the reaper for PROJECT_BUILD_ACTIVE_SESSION_WINDOW_MS after the last build
   * even if the user closes the tab immediately, so the cost is one warm
   * standard-3 per building org per window. It only ever extends an
   * already-running container (the reaper hook is the sole consumer) and never
   * starts one.
   */
  async noteBuildSessionActivity(
    windowMs: number = PROJECT_BUILD_ACTIVE_SESSION_WINDOW_MS,
  ): Promise<void> {
    const stored = await this.ctx.storage.get<number>(PROJECT_BUILD_SESSION_ACTIVITY_KEY);
    const deadline = nextBuildSessionDeadline(Date.now(), stored, windowMs);
    if (deadline === null) return;
    await this.ctx.storage.put(PROJECT_BUILD_SESSION_ACTIVITY_KEY, deadline);
  }

  /**
   * The @cloudflare/containers activity alarm stops the container once
   * `sleepAfter` elapses with no container traffic. A chat session that builds,
   * iterates for a few minutes, then deploys again has no traffic in between, so
   * the reaper used to stop the container mid-session and the next deploy paid a
   * 30-120s cold boot. Defer the stop while the session window is live; the
   * caller renews the normal activity timeout after this returns, so the check
   * repeats one sleepAfter later and the container still sleeps promptly once
   * the workspace goes quiet.
   */
  override async onActivityExpired(): Promise<void> {
    const until = await this.ctx.storage.get<number>(PROJECT_BUILD_SESSION_ACTIVITY_KEY);
    if (shouldKeepBuildSandboxAwake(Date.now(), until)) {
      // Every deferral is one instance held against the binding's
      // `max_instances` cap; without this the warm fleet size is invisible.
      recordObservabilityEvent(this.env, {
        event: "build_sandbox_stop_deferred",
        severity: "info",
        component: "ProjectBuildSandbox",
        operation: "onActivityExpired",
        status: "deferred",
        durationMs: Math.max(0, (until ?? 0) - Date.now()),
      });
      return;
    }
    if (until !== undefined) {
      await this.ctx.storage.delete(PROJECT_BUILD_SESSION_ACTIVITY_KEY);
    }
    await super.onActivityExpired();
  }
}
