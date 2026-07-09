import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkForVersionSkew,
  resetVersionSkewStateForTests,
} from "@/lib/version-skew";
import { APP_BUILD_ID } from "@/lib/app-build-id";

// APP_BUILD_ID is "development" in tests (no VITE_CAMELAI_BUILD_ID), which the
// module skips by design; stub it to a deploy-like id per test via vi.mock.
vi.mock("@/lib/app-build-id", () => ({ APP_BUILD_ID: "build-old" }));

function stubServerBuildId(buildId: string | null): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () =>
    buildId === null
      ? new Response("nope", { status: 500 })
      : Response.json({ buildId }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stubReload(): ReturnType<typeof vi.fn> {
  const reload = vi.fn();
  const original = window.location;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: Object.assign(Object.create(Object.getPrototypeOf(original)), {
      ...original,
      reload,
    }),
  });
  return reload;
}

describe("checkForVersionSkew", () => {
  beforeEach(() => {
    resetVersionSkewStateForTests();
    window.sessionStorage.clear();
    // Beacon reporting is exercised elsewhere; silence it here.
    Object.defineProperty(navigator, "sendBeacon", {
      configurable: true,
      writable: true,
      value: () => true,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does nothing when the server build matches", async () => {
    stubServerBuildId(APP_BUILD_ID);
    const reload = stubReload();
    const onUpdateAvailable = vi.fn();
    await checkForVersionSkew({
      trigger: "socket_open",
      safeToReload: () => true,
      onUpdateAvailable,
    });
    expect(reload).not.toHaveBeenCalled();
    expect(onUpdateAvailable).not.toHaveBeenCalled();
  });

  it("reloads silently on skew when the tab is safe", async () => {
    stubServerBuildId("build-new");
    const reload = stubReload();
    await checkForVersionSkew({
      trigger: "socket_open",
      safeToReload: () => true,
      onUpdateAvailable: vi.fn(),
    });
    expect(reload).toHaveBeenCalledTimes(1);
    // The once-per-version guard is set before reloading.
    expect(
      window.sessionStorage.getItem("camelai:skew-reload:build-new"),
    ).not.toBeNull();
  });

  it("prompts instead of reloading when the tab holds user state", async () => {
    stubServerBuildId("build-new");
    const reload = stubReload();
    const onUpdateAvailable = vi.fn();
    await checkForVersionSkew({
      trigger: "visibility",
      safeToReload: () => false,
      onUpdateAvailable,
    });
    expect(reload).not.toHaveBeenCalled();
    expect(onUpdateAvailable).toHaveBeenCalledTimes(1);
    // Accepting the prompt sets the guard and reloads.
    const applyUpdate = onUpdateAvailable.mock.calls[0][0] as () => void;
    applyUpdate();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(
      window.sessionStorage.getItem("camelai:skew-reload:build-new"),
    ).not.toBeNull();
  });

  it("never auto-reloads twice for the same server build (no reload loop)", async () => {
    stubServerBuildId("build-new");
    const reload = stubReload();
    const onUpdateAvailable = vi.fn();
    window.sessionStorage.setItem(
      "camelai:skew-reload:build-new",
      String(Date.now()),
    );
    await checkForVersionSkew({
      trigger: "socket_open",
      safeToReload: () => true,
      onUpdateAvailable,
    });
    expect(reload).not.toHaveBeenCalled();
    expect(onUpdateAvailable).toHaveBeenCalledTimes(1);
  });

  it("throttles network checks", async () => {
    const fetchMock = stubServerBuildId(APP_BUILD_ID);
    const options = {
      trigger: "visibility" as const,
      safeToReload: () => true,
      onUpdateAvailable: vi.fn(),
    };
    await checkForVersionSkew(options);
    await checkForVersionSkew(options);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when the version endpoint fails", async () => {
    stubServerBuildId(null);
    const reload = stubReload();
    const onUpdateAvailable = vi.fn();
    await checkForVersionSkew({
      trigger: "socket_open",
      safeToReload: () => true,
      onUpdateAvailable,
    });
    expect(reload).not.toHaveBeenCalled();
    expect(onUpdateAvailable).not.toHaveBeenCalled();
  });
});
