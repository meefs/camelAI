import { randomUUID } from "node:crypto";
import { getDefaultConfiguredModel } from "../backend/anthropic.ts";
import { VmManager } from "../backend/vm.ts";

const TURN_TIMEOUT_MS = Number(process.env.DESKTOP_TURN_PROBE_TIMEOUT_MS || 420000);
const PROMPT = process.env.DESKTOP_TURN_PROBE_PROMPT || "Reply with exactly pong.";
const mode = process.argv.includes("--health") ? "health" : "turn";
const keepRunning = process.argv.includes("--keep-running");

function now() {
  return Date.now();
}

async function readNdjsonStream(response, onLine) {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Guest turn response did not include a readable body.");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }
      onLine(JSON.parse(line));
    }
  }

  const finalChunk = buffer.trim();
  if (finalChunk) {
    onLine(JSON.parse(finalChunk));
  }
}

async function main() {
  const vm = new VmManager();
  const vmStates = [];
  let lastStatusLine = "";

  const onStatus = (status) => {
    const line = `${status.state}:${status.detail}`;
    if (line === lastStatusLine) {
      return;
    }
    lastStatusLine = line;
    vmStates.push({
      at: now(),
      state: status.state,
      detail: status.detail,
    });
  };

  const finish = async (result, exitCode = 0) => {
    try {
      if (!keepRunning) {
        await vm.stopRuntime().catch(() => {});
      }
    } finally {
      vm.dispose();
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(exitCode);
  };

  try {
    const model = process.env.DESKTOP_ANTHROPIC_MODEL || getDefaultConfiguredModel();
    const runtimeStatus = await vm.ensureGuestAgentRuntime(model, onStatus);
    const baseUrl = vm.getGuestControlPlaneHttpUrl();

    if (mode === "health") {
      const response = await fetch(`${baseUrl}/health`);
      const health = await response.json();
      await finish({
        ok: response.ok,
        mode,
        baseUrl,
        vmStates,
        runtimeStatus,
        health,
      }, response.ok ? 0 : 1);
      return;
    }

    const threadId = randomUUID();
    const response = await fetch(`${baseUrl}/turn`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        threadId,
        content: PROMPT,
        model,
      }),
      signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Guest turn request failed: ${response.status} ${body}`);
    }

    let assistantText = "";
    let resultEvent = null;
    const sdkEvents = [];
    const errors = [];

    await readNdjsonStream(response, (event) => {
      if (event?.type === "assistant_text" && typeof event.text === "string") {
        assistantText += event.text;
        return;
      }

      if (event?.type === "sdk_event") {
        sdkEvents.push({
          at: now(),
          event: event.event,
        });
        if (event.event?.type === "result") {
          resultEvent = event.event;
        }
        return;
      }

      if (event?.type === "error") {
        errors.push({
          at: now(),
          error: event.error || "Unknown guest error",
          source: event.source || null,
        });
      }
    });

    if (!resultEvent || resultEvent.subtype !== "success") {
      await finish(
        {
          ok: false,
          mode,
          threadId,
          prompt: PROMPT,
          assistantText,
          vmStates,
          errors,
          sdkEvents,
          result: resultEvent,
        },
        1,
      );
      return;
    }

    await finish({
      ok: true,
      mode,
      threadId,
      prompt: PROMPT,
      assistantText,
      vmStates,
      errors,
      sdkEvents,
      result: resultEvent,
    });
  } catch (error) {
    await finish(
      {
        ok: false,
        mode,
        prompt: PROMPT,
        vmStates,
        message: error instanceof Error ? error.message : String(error),
      },
      1,
    );
  }
}

main().catch(async (error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
