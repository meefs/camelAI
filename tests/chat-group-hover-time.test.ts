import { describe, expect, it } from "vitest";
import {
  formatHoverRelativeTime,
  formatRunningElapsed,
} from "@/lib/chat-group-hover-time";

describe("formatHoverRelativeTime", () => {
  const now = Date.UTC(2026, 4, 19, 12, 0, 0);

  it("formats compact relative labels", () => {
    expect(formatHoverRelativeTime(now, now)).toBe("just now");
    expect(formatHoverRelativeTime(now - 90_000, now)).toBe("1m ago");
    expect(formatHoverRelativeTime(now - 3_600_000, now)).toBe("1h ago");
    expect(formatHoverRelativeTime(now - 24 * 3_600_000, now)).toBe("yesterday");
    expect(formatHoverRelativeTime(now - 3 * 24 * 3_600_000, now)).toBe("3d ago");
    expect(formatHoverRelativeTime(now - 7 * 24 * 3_600_000, now)).toBe("1w ago");
  });

  it("falls back to a locale date after five weeks", () => {
    const timestamp = now - 35 * 24 * 3_600_000;
    expect(formatHoverRelativeTime(timestamp, now)).toBe(
      new Date(timestamp).toLocaleDateString(),
    );
  });
});

describe("formatRunningElapsed", () => {
  const now = Date.UTC(2026, 4, 19, 12, 0, 0);

  it("formats elapsed running durations", () => {
    expect(formatRunningElapsed(now - 45_000, now)).toBe("45s");
    expect(formatRunningElapsed(now - 68_000, now)).toBe("1m 08s");
    expect(formatRunningElapsed(now - 3_623_000, now)).toBe("1h 00m");
  });
});
