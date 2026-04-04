import { spawn } from 'node:child_process';

const TURN_TIMEOUT_MS = Number(process.env.DESKTOP_TURN_PROBE_TIMEOUT_MS || 420000);
const PROMPT = process.env.DESKTOP_TURN_PROBE_PROMPT || 'Reply with exactly pong.';

function isRuntimeReady(runtimeStatus) {
  return runtimeStatus?.state === 'running';
}

function now() {
  return Date.now();
}

function isCodexTurnCompleted(event) {
  return (
    event &&
    typeof event === "object" &&
    event.method === "turn/completed" &&
    event.params &&
    typeof event.params === "object" &&
    event.params.turn &&
    typeof event.params.turn === "object"
  );
}

function startBackend() {
  return spawn('bun', ['run', 'desktop/backend/server.ts'], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DESKTOP_BACKEND_TRANSPORT: 'stdio',
    },
  });
}

function sendEvent(child, event) {
  child.stdin.write(`${JSON.stringify(event)}\n`);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: process.env,
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} failed with code ${code ?? 'null'} signal ${signal ?? 'null'}.`));
    });
  });
}

async function main() {
  await run('node', ['desktop/scripts/prepare-runtime-helper.mjs']);
  const backend = startBackend();
  const runtimeStates = [];
  const diagnostics = [];
  const errors = [];
  const sdkEvents = [];
  let stdoutBuffer = '';
  let stderr = '';
  let threadId = null;
  let createdThread = false;
  let sentMessage = false;
  let assistantText = '';
  let settled = false;
  let timeout = null;

  const finish = (result, exitCode = 0) => {
    if (settled) {
      return;
    }
    settled = true;
    if (timeout) {
      clearTimeout(timeout);
    }
    if (backend.exitCode === null) {
      backend.kill('SIGTERM');
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(exitCode);
  };

  const fail = (message) => {
    finish(
      {
        ok: false,
        message,
        threadId,
        prompt: PROMPT,
        runtimeStates,
        diagnostics,
        assistantText,
        sdkEvents,
        errors,
        stderr: stderr.trim() || undefined,
      },
      1,
    );
  };

  timeout = setTimeout(() => {
    fail(`Timed out waiting for a desktop turn after ${TURN_TIMEOUT_MS}ms.`);
  }, TURN_TIMEOUT_MS);

  backend.stdout.setEncoding('utf8');
  backend.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    while (true) {
      const newlineIndex = stdoutBuffer.indexOf('\n');
      if (newlineIndex === -1) {
        break;
      }

      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }

      let event;
      try {
        event = JSON.parse(line);
      } catch (error) {
        fail(`Failed to parse backend stdout: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }

      if (event.type === 'snapshot') {
        const snapshot = event.snapshot;
        const runtimeStatus = snapshot.runtimeStatus;
        runtimeStates.push({
          at: now(),
          state: runtimeStatus.state,
          detail: runtimeStatus.detail,
        });

        if (runtimeStatus.state === 'error') {
          fail(runtimeStatus.detail);
          return;
        }

        const runtimeReady = isRuntimeReady(runtimeStatus);

        if (!createdThread && runtimeReady) {
          createdThread = true;
          sendEvent(backend, { type: 'create_thread', title: 'Probe thread' });
          continue;
        }

        if (!threadId && snapshot.activeThreadId) {
          threadId = snapshot.activeThreadId;
        }

        if (threadId && !sentMessage && runtimeReady) {
          sentMessage = true;
          sendEvent(backend, {
            type: 'send_message',
            threadId,
            content: PROMPT,
          });
        }
        continue;
      }

      if (event.type === 'diagnostic') {
        diagnostics.push(event.diagnostic);
        continue;
      }

      if (event.type === 'assistant_delta') {
        assistantText += event.delta;
        continue;
      }

      if (event.type === 'runtime_event') {
        sdkEvents.push({
          at: now(),
          event: event.event,
        });

        const sdkEvent = event.event;
        if (
          sdkEvent &&
          typeof sdkEvent === "object" &&
          sdkEvent.method === "item/agentMessage/delta" &&
          sdkEvent.params &&
          typeof sdkEvent.params === "object" &&
          typeof sdkEvent.params.delta === "string"
        ) {
          assistantText += sdkEvent.params.delta;
        }

        if (
          sdkEvent &&
          typeof sdkEvent === 'object' &&
          sdkEvent.type === 'result'
        ) {
          if (sdkEvent.subtype === 'success') {
            finish({
              ok: true,
              threadId,
              prompt: PROMPT,
              assistantText,
              runtimeStates,
              diagnostics,
              result: sdkEvent,
              stderr: stderr.trim() || undefined,
            });
            return;
          }

          fail(
            `Desktop turn failed with SDK result subtype ${sdkEvent.subtype || 'unknown'}.`,
          );
          return;
        }

        if (isCodexTurnCompleted(sdkEvent)) {
          const turn = sdkEvent.params.turn;
          if (turn.status === "completed") {
            finish({
              ok: true,
              threadId,
              prompt: PROMPT,
              assistantText,
              runtimeStates,
              diagnostics,
              result: sdkEvent,
              stderr: stderr.trim() || undefined,
            });
            return;
          }

          fail(
            `Desktop turn failed with Codex turn status ${turn.status || "unknown"}.`,
          );
          return;
        }
        continue;
      }

      if (event.type === 'error') {
        errors.push({
          at: now(),
          message: event.message,
          threadId: event.threadId,
        });
        if (sentMessage) {
          fail(event.message);
          return;
        }
      }
    }
  });

  backend.stderr.setEncoding('utf8');
  backend.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  backend.on('error', (error) => {
    fail(`Failed to start backend: ${error.message}`);
  });

  backend.on('close', (code, signal) => {
    if (!settled) {
      fail(
        `Desktop backend exited before the probe completed: code=${code ?? 'null'} signal=${signal ?? 'null'}.`,
      );
    }
  });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
