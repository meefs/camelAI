import { describe, expect, it, vi } from "vitest";
import {
  isTransientDurableObjectRpcError,
  retryTransientDurableObjectRead,
} from "@/lib/do-rpc-retry.server";

describe("retryTransientDurableObjectRead", () => {
  it("retries Durable Object code update resets", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(
        new Error("Durable Object reset because its code was updated."),
      )
      .mockResolvedValueOnce("ok");

    await expect(
      retryTransientDurableObjectRead("TestDO.read", fn, {
        attempts: 2,
        initialDelayMs: 0,
      }),
    ).resolves.toBe("ok");

    expect(fn).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(
      "[do-rpc] transient read failed; retrying",
      expect.objectContaining({
        operation: "TestDO.read",
        attempt: 1,
        attempts: 2,
      }),
    );

    warnSpy.mockRestore();
  });

  it("does not retry non-transient errors", async () => {
    const error = new Error("Permission denied");
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(error);

    await expect(
      retryTransientDurableObjectRead("TestDO.read", fn, {
        attempts: 3,
        initialDelayMs: 0,
      }),
    ).rejects.toBe(error);

    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("isTransientDurableObjectRpcError", () => {
  it("matches known transient Durable Object RPC failures", () => {
    expect(
      isTransientDurableObjectRpcError(
        new Error("Durable Object reset because its code was updated."),
      ),
    ).toBe(true);
    expect(
      isTransientDurableObjectRpcError(new Error("Network connection lost.")),
    ).toBe(true);
  });
});
