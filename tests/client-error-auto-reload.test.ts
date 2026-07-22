import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scheduleClientErrorReload } from "@/lib/client-error-reporting";

describe("scheduleClientErrorReload", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("does not reload on recoverable hydration mismatches (React #418)", () => {
    expect(
      scheduleClientErrorReload({
        error: new Error(
          "Minified React error #418; visit https://react.dev/errors/418?args[]=text for the full message",
        ),
      }),
    ).toBe(false);
    expect(
      scheduleClientErrorReload({
        error: new Error(
          "Hydration failed because the server rendered text didn't match the client.",
        ),
      }),
    ).toBe(false);
  });

  it("still reloads once for asset-load failures", () => {
    const chunkError = new Error("Loading chunk 42 failed.");
    chunkError.name = "ChunkLoadError";

    expect(scheduleClientErrorReload({ error: chunkError })).toBe(true);
    // Deduped per (path, error) within a session.
    expect(scheduleClientErrorReload({ error: chunkError })).toBe(false);
  });

  it("reloads for non-recoverable errors when recoverableOnly is false", () => {
    const domError = new Error(
      "Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.",
    );
    domError.name = "NotFoundError";

    expect(scheduleClientErrorReload({ error: domError })).toBe(false);
    expect(
      scheduleClientErrorReload({ error: domError, recoverableOnly: false }),
    ).toBe(true);
  });
});
