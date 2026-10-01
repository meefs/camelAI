import { describe, expect, it, vi } from "vitest";

import { withBufferedExecOutput } from "../src/container-files";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type StreamName = "stdout" | "stderr";

/**
 * A process whose output arrives the way workerd's localDocker engine hands it
 * on: one multiplexed sequence of frames, each delivered only once its stream
 * is read, so an unread frame holds back every frame behind it.
 */
function demuxedProcess(frames: Array<[StreamName, string]>, exitCode = vi.fn(() => Promise.resolve(0))) {
  const controllers = {} as Record<StreamName, ReadableStreamDefaultController<Uint8Array>>;
  const demand = {} as Record<StreamName, { promise: Promise<void>; resolve: () => void }>;
  const reset = (name: StreamName) => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    demand[name] = { promise, resolve };
  };
  const stream = (name: StreamName) => {
    reset(name);
    return new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          controllers[name] = controller;
        },
        pull: () => demand[name].resolve(),
      },
      { highWaterMark: 0 },
    );
  };
  const stdout = stream("stdout");
  const stderr = stream("stderr");
  void (async () => {
    for (const [name, text] of frames) {
      await demand[name].promise;
      reset(name);
      controllers[name].enqueue(encoder.encode(text));
    }
    controllers.stdout.close();
    controllers.stderr.close();
  })();
  const process = {
    stdin: null,
    stdout,
    stderr,
    pid: 1,
    isPty: false,
    get exitCode() {
      return exitCode();
    },
    output: vi.fn(),
    kill: vi.fn(),
    resize: vi.fn(),
  } as unknown as ExecProcess;
  return { container: { exec: vi.fn(async () => process) }, exitCode };
}

async function firstChunk(stream: ReadableStream | null): Promise<string | "blocked"> {
  const reader = stream!.getReader();
  const timeout = new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 100));
  const read = reader.read().then(({ value }) => decoder.decode(value));
  const result = await Promise.race([read, timeout]);
  reader.releaseLock();
  return result;
}

describe("withBufferedExecOutput", () => {
  // sandbox-shim writes its opening frame to stderr before the file bytes, and
  // Files reads stderr first; Docker may still send the stdout frame first.
  const frames: Array<[StreamName, string]> = [
    ["stdout", "file-bytes"],
    ["stderr", "opening-frame"],
  ];

  it("reproduces the deadlock on the raw process", async () => {
    const { container } = demuxedProcess(frames);
    const process = await container.exec(["read"], {});
    expect(await firstChunk(process.stderr)).toBe("blocked");
  });

  it("lets stderr be read while stdout waits unread", async () => {
    const { container } = demuxedProcess(frames);
    const process = await withBufferedExecOutput(container).exec(["read"], {});
    expect(await firstChunk(process.stderr)).toBe("opening-frame");
    expect(await firstChunk(process.stdout)).toBe("file-bytes");
  });

  it("collects both streams and the exit code in output()", async () => {
    const { container } = demuxedProcess(frames);
    const output = await (await withBufferedExecOutput(container).exec(["read"], {})).output();
    expect(decoder.decode(output.stdout)).toBe("file-bytes");
    expect(decoder.decode(output.stderr)).toBe("opening-frame");
    expect(output.exitCode).toBe(0);
  });

  it("waits for the process only when exitCode is read", async () => {
    const { container, exitCode } = demuxedProcess(frames);
    const process = await withBufferedExecOutput(container).exec(["read"], {});
    expect(exitCode).not.toHaveBeenCalled();
    await expect(process.exitCode).resolves.toBe(0);
    expect(exitCode).toHaveBeenCalledTimes(1);
  });

  it("passes a null stream through", async () => {
    const process = { stdout: null, stderr: null } as unknown as ExecProcess;
    const wrapped = await withBufferedExecOutput({ exec: async () => process }).exec(["true"], {});
    expect(wrapped.stdout).toBeNull();
    expect(wrapped.stderr).toBeNull();
  });
});
