import { APP_BUILD_ID } from "./app-build-id";
import { reportClientEvent } from "./client-error-reporting";

/**
 * Client build-version skew detection + soft reload.
 *
 * Long-lived tabs keep running whatever bundle they booted with; after a
 * deploy that changes the chat transport or protocol, a stale tab can fail in
 * silent ways (e.g. a chat stream that reconnect-loops forever). The fix is a
 * lightweight handshake: compare the compiled-in APP_BUILD_ID against
 * GET /api/version at the moments a stale tab comes back to life — the tab
 * becoming visible, a chat stream (re)opening, or a transport failing to
 * attach — and reload once when the server has moved on.
 *
 * The visibility trigger and the status-stream trigger are wired at the app
 * shell (src/hooks/use-version-skew-watch.ts, mounted by ChatGroupsProvider),
 * NOT only on a chat route: a tab parked on settings or the workspace list runs
 * the same long-lived transports and was previously the one cohort with no
 * self-heal at all. Reload safety is therefore global too — every component
 * holding unsaved user state registers a guard (registerReloadSafetyGuard) and
 * `isReloadSafeNow()` requires all of them to agree.
 *
 * Reload policy: silent reload only when the caller says the tab is safe
 * (no draft, no in-flight turn); otherwise surface an "update available"
 * prompt via onUpdateAvailable. A sessionStorage guard keyed by the server
 * build id makes the automatic reload once-per-version, so a rolling deploy
 * (or a proxy serving a stale HTML shell) cannot cause a reload loop.
 */

export const VERSION_CHECK_MIN_INTERVAL_MS = 60_000;
const RELOAD_GUARD_KEY_PREFIX = "camelai:skew-reload:";

let lastCheckAt = 0;
let checkInFlight = false;
const promptedBuildIds = new Set<string>();
const reloadSafetyGuards = new Set<() => boolean>();

/** Test hook: clear module state between test cases. */
export function resetVersionSkewStateForTests(): void {
  lastCheckAt = 0;
  checkInFlight = false;
  promptedBuildIds.clear();
  reloadSafetyGuards.clear();
}

/**
 * Register a predicate that must return true for a silent reload to be allowed
 * (e.g. "the composer holds no draft and no turn is streaming"). Returns the
 * unregister function; call it on unmount or a stale guard pins the tab.
 */
export function registerReloadSafetyGuard(guard: () => boolean): () => void {
  reloadSafetyGuards.add(guard);
  return () => {
    reloadSafetyGuards.delete(guard);
  };
}

/**
 * True when every registered guard says the tab can be reloaded without losing
 * user state. With no guards registered (a route holding no user state) the
 * answer is true — that is the whole point: those tabs should self-heal.
 */
export function isReloadSafeNow(): boolean {
  for (const guard of reloadSafetyGuards) {
    try {
      if (!guard()) return false;
    } catch {
      // A throwing guard is not evidence of safety.
      return false;
    }
  }
  return true;
}

function reloadGuardKey(serverBuildId: string): string {
  return `${RELOAD_GUARD_KEY_PREFIX}${serverBuildId}`;
}

function hasReloadGuard(serverBuildId: string): boolean {
  try {
    return window.sessionStorage.getItem(reloadGuardKey(serverBuildId)) !== null;
  } catch {
    // Storage unavailable (e.g. blocked third-party context): treat as
    // already-guarded so we never risk a reload loop.
    return true;
  }
}

function setReloadGuard(serverBuildId: string): boolean {
  try {
    window.sessionStorage.setItem(reloadGuardKey(serverBuildId), String(Date.now()));
    return true;
  } catch {
    return false;
  }
}

/**
 * `status_stream_error` is the app-shell analogue of `stream_open`: a transport
 * that cannot attach is the signal a retired route (or any other deploy-shaped
 * failure) produces on a stale tab, and it fires on routes with no chat.
 */
export type VersionSkewTrigger =
  | "stream_open"
  | "visibility"
  | "status_stream_error";

export interface VersionSkewCheckOptions {
  /** What woke the check up; recorded in telemetry. */
  trigger: VersionSkewTrigger;
  /** True when the tab can be reloaded without losing user state. */
  safeToReload: () => boolean;
  /** Surface a non-destructive "update available" prompt. `reload` applies
   * the update (sets the once-per-version guard, then reloads). Called at
   * most once per server build id per page. */
  onUpdateAvailable: (reload: () => void) => void;
}

/**
 * Compare this bundle's build id against the server's; reload or prompt on
 * mismatch. Throttled to one network check per VERSION_CHECK_MIN_INTERVAL_MS.
 * Failures are silent — this must never make a flaky network worse.
 */
export async function checkForVersionSkew(
  options: VersionSkewCheckOptions,
): Promise<void> {
  if (typeof window === "undefined") return;
  // Dev serves no meaningful build id; skip.
  if (!APP_BUILD_ID || APP_BUILD_ID === "development") return;

  const now = Date.now();
  if (checkInFlight || now - lastCheckAt < VERSION_CHECK_MIN_INTERVAL_MS) {
    return;
  }
  lastCheckAt = now;
  checkInFlight = true;

  let serverBuildId: string | null = null;
  try {
    const response = await fetch("/api/version", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (!response.ok) return;
    const payload = (await response.json()) as { buildId?: unknown };
    serverBuildId =
      typeof payload.buildId === "string" && payload.buildId
        ? payload.buildId
        : null;
  } catch {
    return;
  } finally {
    checkInFlight = false;
  }

  if (!serverBuildId || serverBuildId === APP_BUILD_ID) return;

  reportClientEvent({
    source: "version_skew",
    event: "client_build_stale",
    severity: "warn",
    status: options.trigger,
    message: "Client bundle is older than the deployed server build.",
    details: {
      clientBuildId: APP_BUILD_ID,
      serverBuildId,
      trigger: options.trigger,
    },
  });

  const applyUpdate = () => {
    setReloadGuard(serverBuildId as string);
    window.location.reload();
  };

  if (!hasReloadGuard(serverBuildId) && options.safeToReload()) {
    reportClientEvent({
      source: "version_skew",
      event: "client_build_stale_reload",
      severity: "info",
      status: options.trigger,
      message: "Reloading to pick up the deployed build.",
      details: { clientBuildId: APP_BUILD_ID, serverBuildId },
    });
    applyUpdate();
    return;
  }

  if (!promptedBuildIds.has(serverBuildId)) {
    promptedBuildIds.add(serverBuildId);
    options.onUpdateAvailable(applyUpdate);
  }
}
