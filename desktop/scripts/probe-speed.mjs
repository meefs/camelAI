import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getDefaultProvider, requireDesktopProvider } from "../backend/providers.ts";
import { RuntimeManager } from "../backend/runtime.ts";

const TURN_TIMEOUT_MS = Number(process.env.DESKTOP_TURN_PROBE_TIMEOUT_MS || 420000);
const PROMPT = process.env.DESKTOP_TURN_PROBE_PROMPT || "Reply with exactly pong.";
const warmTurns = Number(process.env.DESKTOP_SPEED_PROBE_WARM_TURNS || 2);
const keepRunning = process.argv.includes("--keep-running");
const reuseRuntimeDir = process.argv.includes("--reuse-runtime-dir");

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
    throw new Error("Runtime turn response did not include a readable body.");
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

async function sendTurn(baseUrl, provider, model, prompt) {
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
      env: provider.buildTurnEnv(model),
    }),
    signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Runtime turn request failed: ${response.status} ${body}`);
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
      errors.push(event.error || "Unknown runtime error");
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

async function collectRuntimeLogs(runtimeDir) {
  const controlPlaneServiceLog = await readLogFile(
    resolve(runtimeDir, "shared/logs/control-plane-service.log"),
  );
  const controlPlaneLog = await readLogFile(
    resolve(runtimeDir, "shared/logs/control-plane.log"),
  );

  return {
    controlPlaneServiceTail: controlPlaneServiceLog.split("\n").slice(-40).filter(Boolean),
    controlPlaneTail: controlPlaneLog.split("\n").slice(-40).filter(Boolean),
  };
}

async function main() {
  for (const script of [
    "desktop/scripts/prepare-runtime-helper.mjs",
  ]) {
    const result = spawnSync("node", [script], {
      cwd: process.cwd(),
      stdio: "inherit",
      env: process.env,
    });
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  }

  const runtimeDir =
    process.env.DESKTOP_RUNTIME_DIR ||
    (reuseRuntimeDir
      ? resolve(process.cwd(), "desktop/.local/runtime-speed-probe")
      : mkdtempSync(join(tmpdir(), "camelai-speed-probe-")));

  const originalRuntimeDir = process.env.DESKTOP_RUNTIME_DIR;
  process.env.DESKTOP_RUNTIME_DIR = runtimeDir;

  const runtime = new RuntimeManager();
  const runtimeStates = [];
  let lastStatusLine = "";

  const onStatus = (status) => {
    const line = `${status.state}:${status.detail}`;
    if (line === lastStatusLine) return;
    lastStatusLine = line;
    runtimeStates.push({
      at: now(),
      state: status.state,
      detail: status.detail,
    });
  };

  const finish = async (result, exitCode = 0) => {
    try {
      if (!keepRunning) {
        await runtime.stopRuntime().catch(() => {});
      }
    } finally {
      runtime.dispose();
      if (originalRuntimeDir) {
        process.env.DESKTOP_RUNTIME_DIR = originalRuntimeDir;
      } else {
        delete process.env.DESKTOP_RUNTIME_DIR;
      }
      if (!keepRunning && !reuseRuntimeDir) {
        await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
      }
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(exitCode);
  };

  try {
    const provider = requireDesktopProvider(getDefaultProvider());
    const model =
      process.env.DESKTOP_MODEL ||
      process.env.DESKTOP_ANTHROPIC_MODEL ||
      provider.getDefaultModel();
    const coldBootStartedAt = now();
    const runtimeStatus = await runtime.ensureControlPlaneRuntime(provider, model, onStatus);
    const coldBootElapsedMs = now() - coldBootStartedAt;
    const baseUrl = runtime.getControlPlaneHttpUrl();
    const firstTurn = await sendTurn(baseUrl, provider, model, PROMPT);

    const warmTurnResults = [];
    for (let index = 0; index < warmTurns; index += 1) {
      warmTurnResults.push(await sendTurn(baseUrl, provider, model, PROMPT));
    }

    const runtimeLogs = await collectRuntimeLogs(runtimeDir);

    await finish({
      ok: true,
      mode: "speed",
      runtimeDir,
      model,
      prompt: PROMPT,
      runtimeStatus,
      coldBoot: {
        elapsedMs: coldBootElapsedMs,
        runtimeStates,
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
      runtimeLogs,
    });
  } catch (error) {
    await finish(
      {
        ok: false,
        mode: "speed",
        runtimeDir,
        message: error instanceof Error ? error.message : String(error),
        runtimeStates,
      },
      1,
    );
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
