import { APP_BUILD_ID } from "./app-build-id";
import { reportClientEvent } from "./client-error-reporting";

/**
 * Client build-version skew detection + soft reload.
 *
 * Long-lived tabs keep running whatever bundle they booted with; after a
 * deploy that changes the chat transport or protocol, a stale tab can fail in
 * silent ways (e.g. a websocket that reconnect-loops forever). The fix is a
 * lightweight handshake: compare the compiled-in APP_BUILD_ID against
 * GET /api/version at the moments a stale tab comes back to life — the chat
 * socket (re)opening and the tab becoming visible — and reload once when the
 * server has moved on.
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

/** Test hook: clear module state between test cases. */
export function resetVersionSkewStateForTests(): void {
  lastCheckAt = 0;
  checkInFlight = false;
  promptedBuildIds.clear();
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

export interface VersionSkewCheckOptions {
  /** What woke the check up; recorded in telemetry. */
  trigger: "socket_open" | "visibility";
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
