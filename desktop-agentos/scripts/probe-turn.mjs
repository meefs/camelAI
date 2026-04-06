import { mkdtempSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const TURN_TIMEOUT_MS = Number(process.env.DESKTOP_TURN_PROBE_TIMEOUT_MS || 420000);
const PROMPT = process.env.DESKTOP_TURN_PROBE_PROMPT || "Reply with exactly pong.";
const probeUserDataDir =
  process.env.DESKTOP_AGENTOS_USER_DATA_DIR ||
  mkdtempSync(join(tmpdir(), "camelai-agentos-probe-turn-"));

function isRuntimeReady(runtimeStatus) {
  return runtimeStatus?.state === "running";
}

function now() {
  return Date.now();
}

function startBackend() {
  return spawn(
    "node",
    ["--import", "tsx/esm", "desktop-agentos/backend/server.ts"],
    {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        DESKTOP_BACKEND_TRANSPORT: "stdio",
        DESKTOP_AGENTOS_WORKSPACE_DIR:
          process.env.DESKTOP_AGENTOS_WORKSPACE_DIR || resolve(process.cwd()),
        DESKTOP_AGENTOS_USER_DATA_DIR: probeUserDataDir,
        DESKTOP_USER_DATA_DIR: probeUserDataDir,
        DESKTOP_DATA_DIR: resolve(probeUserDataDir, "data"),
        DESKTOP_RUNTIME_DIR: resolve(probeUserDataDir, "runtime"),
      },
    },
  );
}

function sendEvent(child, event) {
  child.stdin.write(`${JSON.stringify(event)}\n`);
}

function findLatestAssistant(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      return messages[index];
    }
  }
  return null;
}

function extractContentText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }
      if (block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      if (block.type === "tool_result") {
        return extractContentText(block.content);
      }
      return "";
    })
    .join("")
    .trim();
}

async function main() {
  const backend = startBackend();
  const runtimeStates = [];
  const diagnostics = [];
  const runtimeEvents = [];
  const errors = [];
  let stdoutBuffer = "";
  let stderr = "";
  let threadId = null;
  let sentMessage = false;
  let assistantText = "";
  let baselineAssistantId = null;
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
      backend.kill("SIGTERM");
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
        probeUserDataDir,
        runtimeStates,
        diagnostics,
        runtimeEvents,
        assistantText,
        errors,
        stderr: stderr.trim() || undefined,
      },
      1,
    );
  };

  timeout = setTimeout(() => {
    fail(`Timed out waiting for an AgentOS desktop turn after ${TURN_TIMEOUT_MS}ms.`);
  }, TURN_TIMEOUT_MS);

  backend.stdout.setEncoding("utf8");
  backend.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    while (true) {
      const newlineIndex = stdoutBuffer.indexOf("\n");
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
        fail(
          `Failed to parse backend stdout: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return;
      }

      if (event.type === "snapshot") {
        const snapshot = event.snapshot;
        const runtimeStatus = snapshot.runtimeStatus;
        runtimeStates.push({
          at: now(),
          state: runtimeStatus.state,
          detail: runtimeStatus.detail,
        });

        if (runtimeStatus.state === "error") {
          fail(runtimeStatus.detail);
          return;
        }

        if (!threadId && snapshot.activeThreadId) {
          threadId = snapshot.activeThreadId;
        }

        if (threadId && !sentMessage && isRuntimeReady(runtimeStatus)) {
          const existingMessages = snapshot.messagesByThread?.[threadId] ?? [];
          baselineAssistantId = findLatestAssistant(existingMessages)?.id ?? null;
          sentMessage = true;
          sendEvent(backend, {
            type: "send_message",
            threadId,
            content: PROMPT,
          });
        }

        if (threadId && sentMessage) {
          const messages = snapshot.messagesByThread?.[threadId] ?? [];
          const latestAssistant = findLatestAssistant(messages);
          if (latestAssistant?.status === "error") {
            fail("AgentOS assistant message finished with error status.");
            return;
          }
          if (
            latestAssistant?.status === "done" &&
            latestAssistant.id !== baselineAssistantId &&
            extractContentText(latestAssistant.content).length > 0
          ) {
            finish({
              ok: true,
              threadId,
              prompt: PROMPT,
              probeUserDataDir,
              assistantText: extractContentText(latestAssistant.content),
              runtimeStates,
              diagnostics,
              runtimeEvents,
              stderr: stderr.trim() || undefined,
            });
            return;
          }
        }
        continue;
      }

      if (event.type === "diagnostic") {
        diagnostics.push(event.diagnostic);
        continue;
      }

      if (event.type === "assistant_delta") {
        assistantText += event.delta;
        continue;
      }

      if (event.type === "runtime_event") {
        runtimeEvents.push({
          at: now(),
          event: event.event,
        });
        continue;
      }

      if (event.type === "error") {
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

  backend.stderr.setEncoding("utf8");
  backend.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  backend.on("error", (error) => {
    fail(error instanceof Error ? error.message : String(error));
  });

  backend.on("exit", (code, signal) => {
    if (!settled) {
      fail(
        `AgentOS backend exited before turn completion with code ${
          code ?? "null"
        } signal ${signal ?? "null"}.`,
      );
    }
  });
}

await main();
