import { describe, expect, it, vi } from "vitest";
import { mapWithConcurrency } from "../src/lib/map-with-concurrency";

describe("mapWithConcurrency", () => {
  it("returns results in input order and supplies each index", async () => {
    const items = ["slow", "fast", "middle"] as const;
    const delays = [15, 0, 5];

    const results = await mapWithConcurrency(items, 3, async (item, index) => {
      await new Promise((resolve) => setTimeout(resolve, delays[index]));
      return `${index}:${item}`;
    });

    expect(results).toEqual(["0:slow", "1:fast", "2:middle"]);
  });

  it("returns an empty result without calling the mapper", async () => {
    const mapper = vi.fn(async () => "unused");

    await expect(mapWithConcurrency([], 4, mapper)).resolves.toEqual([]);
    expect(mapper).not.toHaveBeenCalled();
  });

  it.each([0, -3])("clamps concurrency %d to one worker", async (concurrency) => {
    let active = 0;
    let maxActive = 0;

    await mapWithConcurrency([1, 2, 3], concurrency, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
    });

    expect(maxActive).toBe(1);
  });

  it("clamps concurrency to the input length", async () => {
    let active = 0;
    let maxActive = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const result = mapWithConcurrency([1, 2, 3] as const, 20, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gate;
      active -= 1;
    });
    await Promise.resolve();
    release?.();
    await result;

    expect(maxActive).toBe(3);
  });

  it("rejects with the mapper error", async () => {
    const error = new Error("mapper failed");

    await expect(
      mapWithConcurrency([1], 1, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
  });
});
