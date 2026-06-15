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
      "[do-rpc] transient rpc failed; retrying",
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

  it("retries Cloudflare retryable Durable Object errors", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = Object.assign(new Error("Transient internal error"), {
      retryable: true,
    });
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce("ok");

    await expect(
      retryTransientDurableObjectRead("TestDO.read", fn, {
        attempts: 2,
        initialDelayMs: 0,
      }),
    ).resolves.toBe("ok");

    expect(fn).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it("reports retry and terminal failure events", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const retryError = new Error("Network connection lost.");
    const finalError = new Error("Permission denied");
    const onRetry = vi.fn();
    const onFailure = vi.fn();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(retryError)
      .mockRejectedValueOnce(finalError);

    await expect(
      retryTransientDurableObjectRead("TestDO.read", fn, {
        attempts: 3,
        initialDelayMs: 0,
        onRetry,
        onFailure,
      }),
    ).rejects.toBe(finalError);

    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "TestDO.read",
        attempt: 1,
        attempts: 3,
        error: retryError,
        transient: true,
        durationMs: expect.any(Number),
      }),
    );
    expect(onFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "TestDO.read",
        attempt: 2,
        attempts: 3,
        error: finalError,
        transient: false,
        durationMs: expect.any(Number),
      }),
    );
    warnSpy.mockRestore();
  });

  it("does not retry overloaded Durable Object errors", async () => {
    const error = Object.assign(new Error("Durable Object is overloaded"), {
      overloaded: true,
      retryable: true,
    });
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
    expect(
      isTransientDurableObjectRpcError(
        new Error(
          "Durable Object storage operation exceeded timeout which caused object to be reset.",
        ),
      ),
    ).toBe(true);
  });

  it("uses Cloudflare retryable and overloaded error flags", () => {
    expect(
      isTransientDurableObjectRpcError(
        Object.assign(new Error("Transient internal error"), {
          retryable: true,
        }),
      ),
    ).toBe(true);
    expect(
      isTransientDurableObjectRpcError(
        Object.assign(new Error("Durable Object is overloaded"), {
          overloaded: true,
          retryable: true,
        }),
      ),
    ).toBe(false);
  });
});
