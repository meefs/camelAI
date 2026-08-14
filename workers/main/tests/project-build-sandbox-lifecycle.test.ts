import { Sandbox } from "@cloudflare/sandbox";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PROJECT_BUILD_ACTIVE_SESSION_MAX_WINDOW_MS,
  PROJECT_BUILD_ACTIVE_SESSION_WINDOW_MS,
} from "../src/container-sizing";
import { ProjectBuildSandbox } from "../src/project-build-sandbox";
import {
  nextBuildSessionDeadline,
  projectBuildSandboxKey,
  PROJECT_BUILD_SESSION_ACTIVITY_KEY,
  shouldKeepBuildSandboxAwake,
} from "../src/project-build-sandbox-lifecycle";

/** Minimal DO storage stand-in; ProjectBuildSandbox only reads/writes one key. */
function createFakeSandbox(stored?: number) {
  const storage = new Map<string, unknown>();
  if (stored !== undefined) storage.set(PROJECT_BUILD_SESSION_ACTIVITY_KEY, stored);
  const dataPoints: Array<Record<string, unknown>> = [];
  return {
    storage,
    dataPoints,
    self: {
      env: {
        OBSERVABILITY_EVENTS: {
          writeDataPoint: vi.fn((point: Record<string, unknown>) => {
            dataPoints.push(point);
          }),
        },
      },
      ctx: {
        storage: {
          get: vi.fn(async (key: string) => storage.get(key)),
          put: vi.fn(async (key: string, value: unknown) => {
            storage.set(key, value);
          }),
          delete: vi.fn(async (key: string) => storage.delete(key)),
        },
      },
    } as unknown as ProjectBuildSandbox,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("projectBuildSandboxKey", () => {
  it("derives a stable, length-bounded key per org", () => {
    expect(projectBuildSandboxKey("Org_123")).toBe("org-org-123");
    const long = projectBuildSandboxKey("a".repeat(200));
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long).toBe(projectBuildSandboxKey("a".repeat(200)));
    expect(() => projectBuildSandboxKey("  ")).toThrow("orgId is required");
  });
});

describe("build session window policy", () => {
  it("extends an unset or shorter window and skips a redundant write", () => {
    expect(nextBuildSessionDeadline(1_000, undefined, 60_000)).toBe(61_000);
    expect(nextBuildSessionDeadline(1_000, 30_000, 60_000)).toBe(61_000);
    // Stored deadline already covers the new one — no storage write.
    expect(nextBuildSessionDeadline(1_000, 120_000, 60_000)).toBeNull();
  });

  it("caps a requested window so a caller cannot pin the container", () => {
    expect(nextBuildSessionDeadline(0, undefined, 10 * 60 * 60_000))
      .toBe(PROJECT_BUILD_ACTIVE_SESSION_MAX_WINDOW_MS);
    expect(nextBuildSessionDeadline(0, undefined, 0)).toBeNull();
    expect(nextBuildSessionDeadline(0, undefined, Number.NaN)).toBeNull();
  });

  it("keeps the container awake only inside a live window", () => {
    expect(shouldKeepBuildSandboxAwake(1_000, 2_000)).toBe(true);
    expect(shouldKeepBuildSandboxAwake(2_000, 2_000)).toBe(false);
    expect(shouldKeepBuildSandboxAwake(1_000, undefined)).toBe(false);
  });
});

describe("ProjectBuildSandbox activity refresh", () => {
  it("records a session deadline for an active build", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T00:00:00.000Z"));
    const fake = createFakeSandbox();

    await ProjectBuildSandbox.prototype.noteBuildSessionActivity.call(fake.self);

    expect(fake.storage.get(PROJECT_BUILD_SESSION_ACTIVITY_KEY))
      .toBe(Date.now() + PROJECT_BUILD_ACTIVE_SESSION_WINDOW_MS);
  });

  it("does not rewrite storage when the stored window already covers the touch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T00:00:00.000Z"));
    const existing = Date.now() + PROJECT_BUILD_ACTIVE_SESSION_WINDOW_MS + 60_000;
    const fake = createFakeSandbox(existing);

    await ProjectBuildSandbox.prototype.noteBuildSessionActivity.call(fake.self);

    expect(fake.storage.get(PROJECT_BUILD_SESSION_ACTIVITY_KEY)).toBe(existing);
    expect((fake.self as unknown as { ctx: { storage: { put: ReturnType<typeof vi.fn> } } }).ctx.storage.put)
      .not.toHaveBeenCalled();
  });

  it("defers the idle reaper while the build session window is live", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T00:00:00.000Z"));
    const stop = vi.spyOn(Sandbox.prototype, "onActivityExpired").mockResolvedValue(undefined);
    const fake = createFakeSandbox(Date.now() + 60_000);

    await ProjectBuildSandbox.prototype.onActivityExpired.call(fake.self);

    expect(stop).not.toHaveBeenCalled();
    expect(fake.storage.has(PROJECT_BUILD_SESSION_ACTIVITY_KEY)).toBe(true);
    // Each deferral holds one instance against the binding's max_instances cap,
    // so the warm fleet has to be countable.
    expect(fake.dataPoints).toHaveLength(1);
    expect(fake.dataPoints[0].blobs).toContain("build_sandbox_stop_deferred");
    expect(fake.dataPoints[0].blobs).toContain("ProjectBuildSandbox");
  });

  it("stops the container once the window lapses and clears the marker", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T00:00:00.000Z"));
    const stop = vi.spyOn(Sandbox.prototype, "onActivityExpired").mockResolvedValue(undefined);
    const fake = createFakeSandbox(Date.now() - 1);

    await ProjectBuildSandbox.prototype.onActivityExpired.call(fake.self);

    expect(stop).toHaveBeenCalledTimes(1);
    expect(fake.storage.has(PROJECT_BUILD_SESSION_ACTIVITY_KEY)).toBe(false);
  });

  it("stops the container for a workspace that never used a build tool", async () => {
    const stop = vi.spyOn(Sandbox.prototype, "onActivityExpired").mockResolvedValue(undefined);
    const fake = createFakeSandbox();

    await ProjectBuildSandbox.prototype.onActivityExpired.call(fake.self);

    expect(stop).toHaveBeenCalledTimes(1);
    expect(
      (fake.self as unknown as { ctx: { storage: { delete: ReturnType<typeof vi.fn> } } }).ctx.storage.delete,
    ).not.toHaveBeenCalled();
  });
});
