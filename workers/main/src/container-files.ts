import { Files } from "@cloudflare/sandbox";

import { isSelfhostRuntime, type SelfhostRuntimeEnv } from "../../../src/lib/selfhost-runtime.js";

/**
 * How far one output stream of a self-host exec may run ahead of its reader.
 * Large enough that the other stream always gets its turn, small enough that
 * a big file read keeps backpressure (up to twice this is buffered per stream).
 */
export const SELFHOST_EXEC_OUTPUT_BUFFER_BYTES = 8 * 1024 * 1024;

/**
 * The Sandbox SDK `Files` for a container class.
 *
 * On self-host, workerd's localDocker engine reads an exec's stdout and stderr
 * from Docker's single multiplexed stream and hands each frame on before it
 * reads the next, so a stdout frame nobody is reading yet blocks the stderr
 * frames behind it. Docker copies the two pipes independently and can send
 * stdout first even when the process wrote stderr first. `Files` waits for
 * sandbox-shim's opening frame on stderr before it reads stdout (readFile
 * does on every read), so it deadlocks when they arrive in that order: the
 * exec has exited, nothing is running, and the call never returns. Draining
 * each stream into a bounded buffer as it arrives keeps workerd reading.
 *
 * Cloudflare's container runtime keeps the streams independent, so there the
 * container is used as is.
 */
export function createContainerFiles(container: Container, env: SelfhostRuntimeEnv): Files {
  return new Files(isSelfhostRuntime(env) ? withBufferedExecOutput(container) : container);
}

/** `container.exec` with each piped output stream drained ahead of its reader. */
export function withBufferedExecOutput(
  container: Pick<Container, "exec">,
  bufferBytes: number = SELFHOST_EXEC_OUTPUT_BUFFER_BYTES,
): Pick<Container, "exec"> {
  return {
    async exec(cmd, options) {
      const process = await container.exec(cmd, options);
      const stdout = buffered(process.stdout, bufferBytes);
      const stderr = buffered(process.stderr, bufferBytes);
      return {
        // Getters, not copies: reading exitCode asks workerd to wait for the
        // process, which closes an unopened stdin.
        get stdin() {
          return process.stdin;
        },
        get exitCode() {
          return process.exitCode;
        },
        stdout,
        stderr,
        pid: process.pid,
        isPty: process.isPty,
        async output() {
          const [out, err, exitCode] = await Promise.all([readAll(stdout), readAll(stderr), process.exitCode]);
          return { stdout: out, stderr: err, exitCode };
        },
        kill: (signal) => process.kill(signal),
        resize: (cols, rows) => process.resize(cols, rows),
      };
    },
  };
}

function buffered(stream: ReadableStream | null, bufferBytes: number): ReadableStream | null {
  if (!stream) return null;
  const strategy = new ByteLengthQueuingStrategy({ highWaterMark: bufferBytes });
  // An identity transform with room on both sides: the pipe keeps pulling from
  // workerd until the reader falls `bufferBytes` behind. Cancelling the result
  // cancels the source.
  return stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(undefined, strategy, strategy));
}

async function readAll(stream: ReadableStream | null): Promise<ArrayBuffer> {
  return stream ? new Response(stream).arrayBuffer() : new ArrayBuffer(0);
}
