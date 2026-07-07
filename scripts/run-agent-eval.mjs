import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  attachEvalLlmJudge,
  formatEvalLlmJudgeSummary,
  withLoadedEvalEnv,
} from "./lib/eval-llm-judge.mjs";

// Workaround for cloudflare/workerd#6793: the stock proxy-everything egress sidecar's TPROXY rules
// intercept docker bridge control traffic on newer hosts (e.g. kernel 6.17 / Docker 29.x), so the
// eval container never becomes ready ("Container failed to start"). scripts/run-eval-suite.sh
// builds a patched interceptor image (camelai-eval-egress-fixed); for direct local runs, auto-select
// it here if present. Remove once workerd#6794 ships in a release.
if (!process.env.MINIFLARE_CONTAINER_EGRESS_IMAGE) {
  const patchedEgressImage = "camelai-eval-egress-fixed:latest";
  const probe = spawnSync("docker", ["image", "inspect", patchedEgressImage], { stdio: "ignore" });
  if (probe.status === 0) {
    process.env.MINIFLARE_CONTAINER_EGRESS_IMAGE = patchedEgressImage;
    console.log(`Using patched egress interceptor ${patchedEgressImage} (workerd#6793 workaround)`);
  }
}

// workers-sdk#14242: vitest-pool-workers leaves container DOs and their egress sidecars running
// after the run instead of removing them. They accumulate (each holds a netns, ports and memory)
// and will eventually exhaust the host. Prune lingering eval-runner containers before and after every run.
//
// This is a GLOBAL sweep of vitest-pool runner containers for classes used by evals, which is only
// safe when this is the only eval on the host. A direct local run (`bun run test:eval:*`) is exactly
// that. An orchestrator that runs evals concurrently would have a global sweep kill a sibling run's
// container, so it sets EVAL_MANAGED_CLEANUP=1 to skip this and owns a concurrency-safe reaper instead.
const EVAL_CONTAINER_CLASS_NAMES = ["EvalSandbox", "ProjectBuildSandbox", "AnalysisSandbox"];
const VITEST_CONTAINER_NAME_PREFIX = "workerd-vitest-pool-workers-runner--";
const ANALYSIS_SANDBOX_IMAGE = "camelai-analysis-sandbox:latest";
const ANALYSIS_SANDBOX_DOCKERFILE = "workers/main/analysis-sandbox.Dockerfile";
const ANALYSIS_EVAL_IDS = new Set([
  "data-analysis-report-live",
  "notebook-fix-rerun-live",
]);

function ensureAnalysisSandboxImage(evalId) {
  if (!ANALYSIS_EVAL_IDS.has(evalId)) return;
  if (!existsSync(ANALYSIS_SANDBOX_DOCKERFILE)) return;
  const probe = spawnSync("docker", ["image", "inspect", ANALYSIS_SANDBOX_IMAGE], {
    stdio: "ignore",
  });
  if (probe.status === 0) return;
  console.log(`Building ${ANALYSIS_SANDBOX_IMAGE} for ${evalId}`);
  const build = spawnSync(
    "docker",
    [
      "build",
      "-t",
      ANALYSIS_SANDBOX_IMAGE,
      "-f",
      ANALYSIS_SANDBOX_DOCKERFILE,
      "workers/main",
    ],
    { stdio: "inherit" },
  );
  if (build.status !== 0) {
    console.error(`Failed to build ${ANALYSIS_SANDBOX_IMAGE}.`);
    process.exit(build.status ?? 1);
  }
}

function sweepEvalContainers(reason) {
  if (process.env.EVAL_MANAGED_CLEANUP === "1") return;
  const list = spawnSync("docker", ["ps", "-a", "--format", "{{.ID}}\t{{.Names}}"], {
    encoding: "utf8",
  });
  if (list.status !== 0) return; // docker unavailable; nothing to do
  const ids = (list.stdout || "")
    .split("\n")
    .map((line) => {
      const [id, name = ""] = line.split("\t");
      const isEvalRunnerContainer =
        name.startsWith(VITEST_CONTAINER_NAME_PREFIX) &&
        EVAL_CONTAINER_CLASS_NAMES.some((className) => name.includes(`--${className}-`));
      return isEvalRunnerContainer ? id.trim() : "";
    })
    .filter(Boolean);
  if (ids.length === 0) return;
  spawnSync("docker", ["rm", "-f", ...ids], { stdio: "ignore" });
  console.log(`Pruned ${ids.length} leftover eval-runner container(s) (${reason}; workers-sdk#14242)`);
}

// Single source of truth: the eval manifest. Adding an eval = add a manifest entry + a
// workers/main/tests/evals/<id>.test.ts that ends in emitEvalTranscript(...) (see ./eval-transcript).
// All evals share one transcript marker pair, so no per-eval wiring is needed here.
const EVALS_DIR = "workers/main/tests/evals";
const START_MARKER = "EVAL_TRANSCRIPT_START ";
const END_MARKER = " EVAL_TRANSCRIPT_END";
const manifest = JSON.parse(
  readFileSync(path.resolve(EVALS_DIR, "manifest.json"), "utf8"),
);
const manifestEvalIds = manifest.evals.map((entry) => entry.id);
const manifestEvalById = new Map(manifest.evals.map((entry) => [entry.id, entry]));
// custom-prompt-live is the generic env-driven custom harness — runnable but not a manifest eval.
const evalIds = [...manifestEvalIds, "custom-prompt-live"];
const configFor = (id) => ({
  testFile: `${EVALS_DIR}/${id}.test.ts`,
  startMarker: START_MARKER,
  endMarker: END_MARKER,
});

const firstArg = process.argv[2];
const evalName = firstArg && !firstArg.startsWith("--") ? firstArg : "deploy-fake-data-live";
const cliArgs = process.argv.slice(firstArg && !firstArg.startsWith("--") ? 3 : 2);

function usage() {
  console.log(`Usage: node scripts/run-agent-eval.mjs [eval-name] [options]

Available evals: ${evalIds.join(", ")}

Options:
  --model <id>              Thread model id, for example sonnet, gpt-5.4, custom
  --custom-base-url <url>   Base URL for EVAL_MODEL=custom
  --custom-api-key <key>    API key for EVAL_MODEL=custom
  --custom-api <api>        openai-completions, openai-responses, or anthropic-messages
  --custom-model <id>       Upstream model id for EVAL_MODEL=custom
  --custom-model-id <id>    Alias for --custom-model
  --timeout-ms <ms>         Agent session timeout override
  --enforce-signal          Set EVAL_ENFORCE_SIGNAL for legacy evals
  --max-assistant-turns <n> Assistant turn warning/failure threshold
  --max-bad-tool-calls <n>  Bad tool call warning/failure threshold
  --max-sdk-turns <n>       SDK turn_start warning/failure threshold
  --artifact-dir <path>     Directory for the captured transcript JSON
  --help                    Show this help message

Environment:
  EVAL_LLM_JUDGE=0 disables the advisory LLM judge
  EVAL_JUDGE_MODEL overrides the judge model (default: openai/gpt-5.5)
  EVAL_JUDGE_GATEWAY_PROVIDER overrides the AI Gateway route (default: compat)
  EVAL_JUDGE_REASONING_EFFORT overrides judge reasoning effort (default: high)
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
      `filteredEnvLimitations=${signal.filteredEnvLimitationCount ?? 0}`,
      `filteredHarnessErrors=${signal.filteredHarnessErrorCount ?? 0}`,
    ].join(" "),
  );

  if (signal.tokenUsage) {
    const usage = signal.tokenUsage;
    const tokenParts = [
      `tokens=${usage.totalTokens}`,
      `input=${usage.inputTokens}`,
      `output=${usage.outputTokens}`,
      `cacheRead=${usage.cacheReadInputTokens}`,
      `cacheWrite=${usage.cacheCreationInputTokens}`,
      `turns=${usage.turnCount}`,
    ];
    if (typeof usage.costUsd === "number") {
      tokenParts.push(`costUsd=${usage.costUsd}`);
    }
    console.log(`Eval token usage: ${tokenParts.join(" ")}`);
  }

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

  if (signal.filteredEnvLimitations?.length) {
    console.log("Filtered eval-env tool limitations:");
    for (const limitation of signal.filteredEnvLimitations) {
      const label = limitation.id ? `${limitation.tool} (${limitation.id})` : limitation.tool;
      console.log(`- ${label}: ${limitation.reason}`);
    }
  }

  if (signal.filteredHarnessErrors?.length) {
    console.log("Filtered harness duplicate/env errors:");
    for (const error of signal.filteredHarnessErrors) {
      console.log(`- ${error.reason}: ${error.output ?? ""}`);
    }
  }
}

const config = evalIds.includes(evalName) ? configFor(evalName) : null;

if (!config) {
  console.error(`Unknown eval "${evalName}". Available evals: ${evalIds.join(", ")}`);
  process.exit(1);
}

const evalEnv = withLoadedEvalEnv({
  ...process.env,
  ...parseOptions(cliArgs),
});

ensureAnalysisSandboxImage(evalName);

const artifactDir = path.resolve(evalEnv.EVAL_ARTIFACT_DIR ?? ".eval-artifacts");
const artifactModelLabel =
  evalEnv.EVAL_MODEL === "custom" && evalEnv.EVAL_CUSTOM_MODEL_ID
    ? evalEnv.EVAL_CUSTOM_MODEL_ID
    : evalEnv.EVAL_MODEL;
const artifactSuffix = artifactModelLabel
  ? `-${artifactModelLabel.replace(/[^a-zA-Z0-9._-]/g, "_")}`
  : "";
const artifactPath = path.join(artifactDir, `${evalName}${artifactSuffix}.json`);

// With EVAL_REPORT=1, the full run output is captured next to the artifact and the
// finished run is uploaded to the shared results viewer (scripts/report-eval-run.mjs).
const reportRun = evalEnv.EVAL_REPORT === "1";
const logPath = path.join(artifactDir, `${evalName}${artifactSuffix}.log`);
const startedAt = new Date().toISOString();
if (reportRun) {
  mkdirSync(artifactDir, { recursive: true });
  // Clear leftovers from a previous run of the same eval/model: a run that fails
  // before writing a fresh transcript must not report the stale artifact.
  rmSync(logPath, { force: true });
  rmSync(artifactPath, { force: true });
}

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

function classifyFilteredHarnessError(piece) {
  if (piece.includes("callToolEnvelope")) return "enveloped_tool_duplicate";
  if (piece.includes("Screenshot capture requires the BROWSER binding")) {
    return "missing_browser_binding_screenshot";
  }
  if (piece.includes("Browser sessions require the BROWSER binding")) {
    return "missing_browser_binding_session";
  }
  if (piece.includes("DISPATCHER service binding is not configured")) {
    return "missing_dispatcher_binding";
  }
  if (piece.includes("ServiceStub serialization requires the 'experimental' compat flag")) {
    return "servicestub_experimental_compat_missing";
  }
  return null;
}

function extractVitestUnhandledErrors(output) {
  if (!/Unhandled Errors/i.test(output)) return { harnessErrors: [], filteredHarnessErrors: [] };
  const pieces = output.split(/Unhandled (?:Rejection|Exception)/i).slice(1);
  const harnessErrors = [];
  const filteredHarnessErrors = [];
  for (const piece of pieces) {
    const line = firstMeaningfulLine(piece);
    if (!line) continue;
    const filteredReason = classifyFilteredHarnessError(piece);
    if (filteredReason) {
      filteredHarnessErrors.push({
        tool: "harness",
        reason: filteredReason,
        output: line.slice(0, 500),
      });
      continue;
    }
    harnessErrors.push({
      tool: "harness",
      reason: "vitest_unhandled_error",
      output: line.slice(0, 500),
    });
  }
  return { harnessErrors, filteredHarnessErrors };
}

function addHarnessSignal(transcript, harnessSignal) {
  if (!transcript) return transcript;
  const harnessErrors = harnessSignal.harnessErrors ?? [];
  const filteredHarnessErrors = harnessSignal.filteredHarnessErrors ?? [];
  if (!harnessErrors.length && !filteredHarnessErrors.length) return transcript;
  const signal = transcript.signal ?? {};
  const existingHarnessErrors = Array.isArray(signal.harnessErrors)
    ? signal.harnessErrors
    : [];
  const mergedHarnessErrors = [...existingHarnessErrors, ...harnessErrors];
  const existingFilteredHarnessErrors = Array.isArray(signal.filteredHarnessErrors)
    ? signal.filteredHarnessErrors
    : [];
  const mergedFilteredHarnessErrors = [
    ...existingFilteredHarnessErrors,
    ...filteredHarnessErrors,
  ];
  transcript.signal = {
    ...signal,
    harnessErrors: mergedHarnessErrors,
    harnessErrorCount: mergedHarnessErrors.length,
    filteredHarnessErrors: mergedFilteredHarnessErrors,
    filteredHarnessErrorCount: mergedFilteredHarnessErrors.length,
    violations: [
      ...(Array.isArray(signal.violations) ? signal.violations : []),
      ...(mergedHarnessErrors.length > 0
        ? [`harness unhandled errors ${mergedHarnessErrors.length}`]
        : []),
    ],
  };
  return transcript;
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function validateEvaluationContract(transcript) {
  if (!isObject(transcript)) {
    throw new Error("captured transcript is not a JSON object");
  }
  const evaluation = transcript.evaluation;
  if (!isObject(evaluation)) {
    throw new Error("captured transcript is missing required evaluation object");
  }
  if (!isObject(evaluation.passFail)) {
    throw new Error("evaluation.passFail must be an object");
  }
  if (!Array.isArray(evaluation.passFail.criteria)) {
    throw new Error("evaluation.passFail.criteria must be an array");
  }
  if (!isObject(evaluation.scorecard)) {
    throw new Error("evaluation.scorecard must be an object");
  }
  if (!Array.isArray(evaluation.scorecard.criteria)) {
    throw new Error("evaluation.scorecard.criteria must be an array");
  }
}

function isRealEvalDeployEnabled(env) {
  if (env.RUN_AGENT_EVALS !== "1") return false;
  const flag = env.EVAL_REAL_DEPLOY?.trim().toLowerCase();
  if (flag === "0" || flag === "false") return false;
  return Boolean(env.CF_API_TOKEN?.trim());
}

function hasSkippedTests(output) {
  return /\b\d+\s+skipped\b/i.test(output);
}

function isExpectedMarkerlessSkip(exitCode, output) {
  if (exitCode !== 0) return false;
  if (!hasSkippedTests(output)) return false;
  const manifestEntry = manifestEvalById.get(evalName);
  return manifestEntry?.realDeploy === true && !isRealEvalDeployEnabled({
    ...evalEnv,
    RUN_AGENT_EVALS: "1",
  });
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

sweepEvalContainers("pre-run");

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
  if (reportRun) appendFileSync(logPath, chunk);
  observeProcessOutput(chunk);
  observeChunk(chunk);
});

child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
  if (reportRun) appendFileSync(logPath, chunk);
  observeProcessOutput(chunk);
  observeChunk(chunk);
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});

child.on("close", async (code) => {
  let exitCode = code ?? 1;
  // A real-deploy eval that legitimately skipped (no CF_API_TOKEN / EVAL_REAL_DEPLOY=0)
  // produced no result — reporting it would record a bogus contract failure.
  let skippedRun = false;
  if (complete) {
    try {
      mkdirSync(artifactDir, { recursive: true });
      const transcript = addHarnessSignal(
        JSON.parse(captured),
        extractVitestUnhandledErrors(processOutputTail),
      );
      validateEvaluationContract(transcript);
      await attachEvalLlmJudge(transcript, {
        env: evalEnv,
        evalName,
        targetModel: artifactModelLabel,
      });
      writeFileSync(artifactPath, JSON.stringify(transcript, null, 2));
      console.log(`Wrote eval artifact: ${artifactPath}`);
      const judgeSummary = formatEvalLlmJudgeSummary(transcript);
      if (judgeSummary) console.log(judgeSummary);
      printSignalSummary(transcript);
      // dangerouslyIgnoreUnhandledErrors (eval runs only) stops vitest from
      // exiting 1 on the enveloped-tool duplicates filtered above — but that
      // also silences REAL unhandled errors. Any that survived the filter must
      // still fail the run here.
      const realHarnessErrors = transcript?.signal?.harnessErrorCount ?? 0;
      if (exitCode === 0 && realHarnessErrors > 0) {
        console.error(
          `Failing eval: ${realHarnessErrors} unfiltered harness unhandled error(s).`,
        );
        exitCode = 1;
      }
    } catch (error) {
      console.error(
        `Eval transcript contract failed for "${evalName}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      exitCode = 1;
    }
  } else if (isExpectedMarkerlessSkip(exitCode, processOutputTail)) {
    skippedRun = true;
    console.log(
      `No transcript marker found for skipped real-deploy eval "${evalName}"; preserving Vitest success.`,
    );
  } else {
    console.error(`No transcript marker found for eval "${evalName}".`);
    exitCode = 1;
  }

  sweepEvalContainers("post-run");

  if (reportRun && !skippedRun) {
    // Failed runs (even without an artifact) are reported too — the viewer
    // synthesizes an evaluation-contract failure for them.
    const reporterArgs = [
      path.resolve("scripts/report-eval-run.mjs"),
      "--eval", evalName,
      "--exit-code", String(exitCode),
      "--started", startedAt,
      "--finished", new Date().toISOString(),
      "--log", logPath,
    ];
    if (existsSync(artifactPath)) reporterArgs.push("--artifact", artifactPath);
    if (artifactModelLabel) reporterArgs.push("--model", artifactModelLabel);
    if (evalEnv.EVAL_REAL_DEPLOY !== undefined) {
      reporterArgs.push("--real-deploy", evalEnv.EVAL_REAL_DEPLOY === "0" ? "0" : "1");
    }
    spawnSync(process.execPath, reporterArgs, { stdio: "inherit", env: evalEnv });
  }

  process.exit(exitCode);
});
