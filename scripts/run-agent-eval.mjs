import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const evals = {
  "dashboard-fake-data-live": {
    testFile: "workers/main/tests/evals/dashboard-fake-data-live.test.ts",
    startMarker: "DASHBOARD_EVAL_TRANSCRIPT_START ",
    endMarker: " DASHBOARD_EVAL_TRANSCRIPT_END",
  },
  "deploy-fake-data-live": {
    testFile: "workers/main/tests/evals/deploy-fake-data-live.test.ts",
    startMarker: "DEPLOY_EVAL_TRANSCRIPT_START ",
    endMarker: " DEPLOY_EVAL_TRANSCRIPT_END",
  },
};

const firstArg = process.argv[2];
const evalName = firstArg && !firstArg.startsWith("--") ? firstArg : "deploy-fake-data-live";
const cliArgs = process.argv.slice(firstArg && !firstArg.startsWith("--") ? 3 : 2);

function usage() {
  console.log(`Usage: node scripts/run-agent-eval.mjs [eval-name] [options]

Available evals: ${Object.keys(evals).join(", ")}

Options:
  --model <id>              Thread model id, for example sonnet, gpt-5.4, custom
  --custom-base-url <url>   Base URL for EVAL_MODEL=custom
  --custom-api-key <key>    API key for EVAL_MODEL=custom
  --custom-api <api>        openai-completions, openai-responses, or anthropic-messages
  --custom-model <id>       Upstream model id for EVAL_MODEL=custom
  --custom-model-id <id>    Alias for --custom-model
  --timeout-ms <ms>         Agent session timeout override
  --enforce-signal          Fail when eval signal thresholds are violated
  --max-assistant-turns <n> Assistant turn warning/failure threshold
  --max-bad-tool-calls <n>  Bad tool call warning/failure threshold
  --max-sdk-turns <n>       SDK turn_start warning/failure threshold
  --artifact-dir <path>     Directory for the captured transcript JSON
  --help                    Show this help message
`);
}

function parseOptions(args) {
  const envOverrides = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help") {
      usage();
      process.exit(0);
    }
    if (arg === "--enforce-signal") {
      envOverrides.EVAL_ENFORCE_SIGNAL = "1";
      continue;
    }

    const optionEnvNames = {
      "--model": "EVAL_MODEL",
      "--custom-base-url": "EVAL_CUSTOM_BASE_URL",
      "--custom-api-key": "EVAL_CUSTOM_API_KEY",
      "--custom-api": "EVAL_CUSTOM_API",
      "--custom-model": "EVAL_CUSTOM_MODEL_ID",
      "--custom-model-id": "EVAL_CUSTOM_MODEL_ID",
      "--timeout-ms": "EVAL_TIMEOUT_MS",
      "--max-assistant-turns": "EVAL_MAX_ASSISTANT_TURNS",
      "--max-bad-tool-calls": "EVAL_MAX_BAD_TOOL_CALLS",
      "--max-sdk-turns": "EVAL_MAX_SDK_TURNS",
      "--artifact-dir": "EVAL_ARTIFACT_DIR",
    };
    const envName = optionEnvNames[arg];
    if (!envName) {
      console.error(`Unknown option "${arg}". Use --help for usage.`);
      process.exit(1);
    }

    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      console.error(`Missing value for ${arg}.`);
      process.exit(1);
    }
    envOverrides[envName] = value;
    index += 1;
  }
  return envOverrides;
}

function printSignalSummary(transcript) {
  const signal = transcript?.signal;
  if (!signal) return;

  console.log(
    [
      "Eval signal:",
      `assistantTurns=${signal.assistantTurnCount}`,
      `sdkTurns=${signal.sdkTurnStartCount}`,
      `toolCalls=${signal.toolCallCount}`,
      `badToolCalls=${signal.badToolCallCount}`,
      `harnessErrors=${signal.harnessErrorCount ?? 0}`,
    ].join(" "),
  );

  if (signal.violations?.length) {
    console.warn("Eval signal violations:");
    for (const violation of signal.violations) {
      console.warn(`- ${violation}`);
    }
  }

  if (signal.badToolCalls?.length) {
    console.warn("Bad tool calls:");
    for (const call of signal.badToolCalls) {
      const label = call.id ? `${call.tool} (${call.id})` : call.tool;
      console.warn(`- ${label}: ${call.reason}`);
      if (call.output) {
        console.warn(`  ${call.output.replace(/\s+/g, " ").slice(0, 240)}`);
      }
    }
  }

  if (signal.harnessErrors?.length) {
    console.warn("Harness errors:");
    for (const error of signal.harnessErrors) {
      console.warn(`- ${error.reason}: ${error.output ?? ""}`);
    }
  }
}

const config = evals[evalName];

if (!config) {
  console.error(`Unknown eval "${evalName}". Available evals: ${Object.keys(evals).join(", ")}`);
  process.exit(1);
}

const evalEnv = {
  ...process.env,
  ...parseOptions(cliArgs),
};

const artifactDir = path.resolve(evalEnv.EVAL_ARTIFACT_DIR ?? ".eval-artifacts");
const artifactModelLabel =
  evalEnv.EVAL_MODEL === "custom" && evalEnv.EVAL_CUSTOM_MODEL_ID
    ? evalEnv.EVAL_CUSTOM_MODEL_ID
    : evalEnv.EVAL_MODEL;
const artifactSuffix = artifactModelLabel
  ? `-${artifactModelLabel.replace(/[^a-zA-Z0-9._-]/g, "_")}`
  : "";
const artifactPath = path.join(artifactDir, `${evalName}${artifactSuffix}.json`);

let captured = "";
let tail = "";
let processOutputTail = "";
let capturing = false;
let complete = false;

function observeProcessOutput(chunk) {
  processOutputTail = `${processOutputTail}${chunk.toString("utf8")}`.slice(-1_000_000);
}

function firstMeaningfulLine(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => {
      if (!line) return false;
      if (/^[⎯\-\s]+$/.test(line)) return false;
      if (/^Unhandled (?:Rejection|Exception)/i.test(line)) return false;
      if (/^Vitest caught \d+ unhandled errors?/i.test(line)) return false;
      if (/^This might cause false positive tests/i.test(line)) return false;
      if (/^Make sure to resolve/i.test(line)) return false;
      return true;
    });
}

function extractVitestUnhandledErrors(output) {
  if (!/Unhandled Errors/i.test(output)) return [];
  const pieces = output.split(/Unhandled (?:Rejection|Exception)/i).slice(1);
  return pieces
    .map((piece) => firstMeaningfulLine(piece))
    .filter(Boolean)
    .map((line) => ({
      tool: "harness",
      reason: "vitest_unhandled_error",
      output: line.slice(0, 500),
    }));
}

function addHarnessSignal(transcript, harnessErrors) {
  if (!transcript || !harnessErrors.length) return transcript;
  const signal = transcript.signal ?? {};
  const existingHarnessErrors = Array.isArray(signal.harnessErrors)
    ? signal.harnessErrors
    : [];
  const mergedHarnessErrors = [...existingHarnessErrors, ...harnessErrors];
  transcript.signal = {
    ...signal,
    harnessErrors: mergedHarnessErrors,
    harnessErrorCount: mergedHarnessErrors.length,
    violations: [
      ...(Array.isArray(signal.violations) ? signal.violations : []),
      `harness unhandled errors ${mergedHarnessErrors.length}`,
    ],
  };
  return transcript;
}

function observeChunk(chunk) {
  if (complete) return;

  let text = tail + chunk.toString("utf8");
  tail = "";

  while (text.length > 0 && !complete) {
    if (!capturing) {
      const startIndex = text.indexOf(config.startMarker);
      if (startIndex === -1) {
        tail = text.slice(-config.startMarker.length);
        return;
      }
      capturing = true;
      text = text.slice(startIndex + config.startMarker.length);
    }

    const endIndex = text.indexOf(config.endMarker);
    if (endIndex === -1) {
      const keep = Math.max(config.endMarker.length - 1, 0);
      if (text.length > keep) {
        captured += text.slice(0, -keep);
        tail = text.slice(-keep);
      } else {
        tail = text;
      }
      return;
    }

    captured += text.slice(0, endIndex);
    complete = true;
  }
}

const child = spawn(
  "bunx",
  [
    "vitest",
    "run",
    "--config",
    "vitest.workers.config.ts",
    "--reporter",
    "verbose",
    config.testFile,
  ],
  {
    cwd: path.resolve("."),
    env: {
      ...evalEnv,
      RUN_AGENT_EVALS: "1",
      EVAL_ARTIFACT_DIR: artifactDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  observeProcessOutput(chunk);
  observeChunk(chunk);
});

child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
  observeProcessOutput(chunk);
  observeChunk(chunk);
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});

child.on("close", (code) => {
  if (complete) {
    mkdirSync(artifactDir, { recursive: true });
    const transcript = addHarnessSignal(
      JSON.parse(captured),
      extractVitestUnhandledErrors(processOutputTail),
    );
    writeFileSync(artifactPath, JSON.stringify(transcript, null, 2));
    console.log(`Wrote eval artifact: ${artifactPath}`);
    printSignalSummary(transcript);
  } else {
    console.warn(`No transcript marker found for eval "${evalName}".`);
  }

  process.exit(code ?? 1);
});
