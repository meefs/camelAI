import { renderHook, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  formatDate,
  formatDateTime,
  formatInteger,
  useHydratedTimeZone,
} from "@/lib/hydration-safe-datetime";

// Jul 21, 2026 19:00:00 UTC — crosses a date boundary in eastern timezones.
const SAMPLE_MS = Date.UTC(2026, 6, 21, 19, 0, 0);

describe("hydration-safe datetime formatting", () => {
  it("formats dates and date-times deterministically in UTC", () => {
    expect(formatDate(SAMPLE_MS, "UTC")).toBe("Jul 21, 2026");
    expect(formatDateTime(SAMPLE_MS, "UTC")).toBe("Jul 21, 2026, 7:00 PM");
  });

  it("respects an explicit timezone for local rendering", () => {
    expect(formatDateTime(SAMPLE_MS, "Asia/Tokyo")).toBe(
      "Jul 22, 2026, 4:00 AM",
    );
    expect(formatDate(SAMPLE_MS, "Asia/Tokyo")).toBe("Jul 22, 2026");
  });

  it("formats integers with a fixed locale", () => {
    expect(formatInteger(1234567)).toBe("1,234,567");
    expect(formatInteger(0)).toBe("0");
  });

  it("useHydratedTimeZone returns UTC on first render, local after hydration", async () => {
    const observed: Array<string | undefined> = [];
    const { result } = renderHook(() => {
      const timeZone = useHydratedTimeZone();
      observed.push(timeZone);
      return timeZone;
    });

    // First render (what hydration compares against SSR) must be UTC.
    expect(observed[0]).toBe("UTC");
    // After effects run, the hook flips to the browser-local zone.
    await waitFor(() => expect(result.current).toBeUndefined());
  });

  it("SSR output uses UTC regardless of the runtime timezone", () => {
    function Probe() {
      const timeZone = useHydratedTimeZone();
      return <span>{formatDateTime(SAMPLE_MS, timeZone)}</span>;
    }

    expect(renderToString(<Probe />)).toContain("Jul 21, 2026, 7:00 PM");
  });
});
