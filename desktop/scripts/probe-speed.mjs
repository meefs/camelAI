import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { getDefaultConfiguredModel } from "../backend/anthropic.ts";
import { VmManager } from "../backend/vm.ts";

const TURN_TIMEOUT_MS = Number(process.env.DESKTOP_TURN_PROBE_TIMEOUT_MS || 420000);
const PROMPT = process.env.DESKTOP_TURN_PROBE_PROMPT || "Reply with exactly pong.";
const warmTurns = Number(process.env.DESKTOP_SPEED_PROBE_WARM_TURNS || 2);
const keepRunning = process.argv.includes("--keep-running");
const reuseVmDir = process.argv.includes("--reuse-vm-dir");

function now() {
  return Date.now();
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  return sorted[middle];
}

function average(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
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
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) break;
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;
      onLine(JSON.parse(line));
    }
  }

  const finalChunk = buffer.trim();
  if (finalChunk) {
    onLine(JSON.parse(finalChunk));
  }
}

async function sendTurn(baseUrl, model, prompt) {
  const threadId = randomUUID();
  const startedAt = now();
  const response = await fetch(`${baseUrl}/turn`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      threadId,
      content: prompt,
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
      sdkEvents.push(event.event);
      if (event.event?.type === "result") {
        resultEvent = event.event;
      }
      return;
    }

    if (event?.type === "error") {
      errors.push(event.error || "Unknown guest error");
    }
  });

  return {
    elapsedMs: now() - startedAt,
    threadId,
    assistantText,
    result: resultEvent,
    sdkEvents,
    errors,
  };
}

async function readLogFile(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function extractTimingLines(logText, marker) {
  return logText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes(marker) && line.includes("elapsed_ms="));
}

function parseElapsedMap(lines, marker) {
  const timings = {};
  for (const line of lines) {
    const cleaned = line.replace(/^\+ /, "");
    const elapsedMatch = cleaned.match(/elapsed_ms=(\d+)/);
    if (!elapsedMatch) continue;
    const labelMatch = cleaned.match(new RegExp(`${marker}:\\s+(.*?)\\s+elapsed_ms=`));
    if (!labelMatch) continue;
    const label = labelMatch[1].trim().replace(/\s+/g, "_");
    timings[label] = Number(elapsedMatch[1]);
    const totalMatch = cleaned.match(/total_elapsed_ms=(\d+)/);
    if (totalMatch) {
      timings[`${label}_total`] = Number(totalMatch[1]);
    }
  }
  return timings;
}

async function collectGuestTimings(vmDir) {
  const runtimeSetupLog = await readLogFile(resolve(vmDir, "shared/logs/runtime-setup.log"));
  const controlPlaneServiceLog = await readLogFile(resolve(vmDir, "shared/logs/guest-control-plane-service.log"));
  const guestControlPlaneLog = await readLogFile(resolve(vmDir, "shared/logs/guest-control-plane.log"));

  return {
    runtimeSetup: parseElapsedMap(
      extractTimingLines(runtimeSetupLog, "camelai-runtime-setup"),
      "camelai-runtime-setup",
    ),
    controlPlaneService: parseElapsedMap(
      extractTimingLines(controlPlaneServiceLog, "camelai-start-control-plane"),
      "camelai-start-control-plane",
    ),
    samples: {
      runtimeSetup: extractTimingLines(runtimeSetupLog, "camelai-runtime-setup"),
      controlPlaneService: extractTimingLines(controlPlaneServiceLog, "camelai-start-control-plane"),
      guestBootstrap: guestControlPlaneLog
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.includes('"event":"bootstrap:start"') || line.includes('"event":"server:listening"')),
    },
  };
}

async function main() {
  const vmDir = process.env.DESKTOP_VM_DIR
    || (reuseVmDir
      ? resolve(process.cwd(), "desktop/.local/vm-speed-probe")
      : mkdtempSync(join(tmpdir(), "camelai-speed-probe-")));

  const originalVmDir = process.env.DESKTOP_VM_DIR;
  process.env.DESKTOP_VM_DIR = vmDir;

  const vm = new VmManager();
  const vmStates = [];
  let lastStatusLine = "";

  const onStatus = (status) => {
    const line = `${status.state}:${status.detail}`;
    if (line === lastStatusLine) return;
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
      if (originalVmDir) {
        process.env.DESKTOP_VM_DIR = originalVmDir;
      } else {
        delete process.env.DESKTOP_VM_DIR;
      }
      if (!keepRunning && !reuseVmDir) {
        await rm(vmDir, { recursive: true, force: true }).catch(() => {});
      }
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(exitCode);
  };

  try {
    const model = process.env.DESKTOP_ANTHROPIC_MODEL || getDefaultConfiguredModel();
    const coldBootStartedAt = now();
    const runtimeStatus = await vm.ensureGuestAgentRuntime(model, onStatus);
    const coldBootElapsedMs = now() - coldBootStartedAt;
    const baseUrl = vm.getGuestControlPlaneHttpUrl();
    const firstTurn = await sendTurn(baseUrl, model, PROMPT);

    const warmTurnResults = [];
    for (let index = 0; index < warmTurns; index += 1) {
      warmTurnResults.push(await sendTurn(baseUrl, model, PROMPT));
    }

    const guestTimings = await collectGuestTimings(vmDir);

    await finish({
      ok: true,
      mode: "speed",
      vmDir,
      model,
      prompt: PROMPT,
      runtimeStatus,
      coldBoot: {
        elapsedMs: coldBootElapsedMs,
        vmStates,
      },
      firstTurn: {
        elapsedMs: firstTurn.elapsedMs,
        assistantText: firstTurn.assistantText,
        result: firstTurn.result,
      },
      warmTurns: warmTurnResults.map((turn, index) => ({
        index: index + 1,
        elapsedMs: turn.elapsedMs,
        assistantText: turn.assistantText,
        result: turn.result,
      })),
      summary: {
        warmTurnCount: warmTurnResults.length,
        warmTurnAverageMs: average(warmTurnResults.map((turn) => turn.elapsedMs)),
        warmTurnMedianMs: median(warmTurnResults.map((turn) => turn.elapsedMs)),
      },
      guestTimings,
    });
  } catch (error) {
    await finish(
      {
        ok: false,
        mode: "speed",
        vmDir,
        message: error instanceof Error ? error.message : String(error),
        vmStates,
      },
      1,
    );
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
