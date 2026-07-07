import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_MODELS = [
  "sonnet",
  "deepseek-v4-auto",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
];

const DEFAULT_EVALS = [
  "do-backed-project-deploy-live",
  "data-analysis-report-live",
  "notebook-fix-rerun-live",
  "project-snapshot-revert-live",
  "project-revert-redeploy-live",
  "workflow-live",
  "scheduled-prompt-live",
  "integration-create-live",
];

const manifest = JSON.parse(
  readFileSync("workers/main/tests/evals/manifest.json", "utf8"),
);
const knownEvalIds = new Set([
  ...manifest.evals.map((entry) => entry.id),
  "custom-prompt-live",
]);

function usage() {
  console.log(`Usage: node scripts/run-agent-eval-matrix.mjs [options] [-- run-agent-eval args]

Runs each eval/model cell through scripts/run-agent-eval.mjs.

Options:
  --models <ids>          Comma-separated model ids. Default: ${DEFAULT_MODELS.join(",")}
  --evals <ids>           Comma-separated eval ids. Default: ${DEFAULT_EVALS.join(",")}
  --repeat <n>            Sequential repeats per eval/model cell. Default: 1
  --artifact-dir <path>   Root artifact directory. Default: .eval-artifacts/matrix-<timestamp>
  --dry-run               Print commands without running them
  --help                  Show this help message

Any args after -- are passed through to every run-agent-eval invocation.
Writes <artifact-dir>/matrix-summary.json when finished.
`);
}

function splitList(value, name) {
  const values = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (values.length === 0) throw new Error(`${name} must include at least one value`);
  return values;
}

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseOptions(args) {
  const options = {
    models: DEFAULT_MODELS,
    evals: DEFAULT_EVALS,
    repeat: 1,
    artifactDir: undefined,
    dryRun: false,
    passThrough: [],
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      options.passThrough = args.slice(index + 1);
      break;
    }
    if (arg === "--help") {
      usage();
      process.exit(0);
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--models" || arg === "--evals" || arg === "--repeat" || arg === "--artifact-dir") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      if (arg === "--models") options.models = splitList(value, "--models");
      if (arg === "--evals") options.evals = splitList(value, "--evals");
      if (arg === "--repeat") options.repeat = parsePositiveInteger(value, "--repeat");
      if (arg === "--artifact-dir") options.artifactDir = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option ${arg}. Use --help for usage.`);
  }
  return options;
}

function shellQuote(value) {
  return /[^A-Za-z0-9_/:=.,@%+-]/.test(value)
    ? `'${value.replace(/'/g, `'"'"'`)}'`
    : value;
}

function safePathPart(value) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function validateEvals(evals) {
  const unknown = evals.filter((evalId) => !knownEvalIds.has(evalId));
  if (unknown.length) {
    throw new Error(
      `Unknown eval id(s): ${unknown.join(", ")}. Known evals: ${[...knownEvalIds].join(", ")}`,
    );
  }
}

function uniqueMatches(text, pattern) {
  return [...new Set([...text.matchAll(pattern)].map((match) => match[0]))];
}

function summarizeArtifact(artifactPath) {
  if (!artifactPath || !existsSync(artifactPath)) return undefined;
  try {
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
    return {
      status: artifact.status,
      passFailPassed: artifact.evaluation?.passFail?.passed,
      passFailFailed: artifact.evaluation?.passFail?.failed,
      scorePercentage: artifact.evaluation?.scorecard?.percentage,
      scorePoints: artifact.evaluation?.scorecard?.points,
      scoreMaxPoints: artifact.evaluation?.scorecard?.maxPoints,
      assistantTurnCount: artifact.signal?.assistantTurnCount,
      sdkTurnStartCount: artifact.signal?.sdkTurnStartCount,
      badToolCallCount: artifact.signal?.badToolCallCount,
      tokenUsage: artifact.signal?.tokenUsage,
      llmJudge: artifact.llmJudge
        ? {
          status: artifact.llmJudge.status,
          outcome: artifact.llmJudge.outcome,
          agreement: artifact.llmJudge.agreement?.matchesDeterministic,
          confidence: artifact.llmJudge.confidence,
          issueCount: Array.isArray(artifact.llmJudge.issues)
            ? artifact.llmJudge.issues.length
            : undefined,
          attempts: artifact.llmJudge.attempts,
          latencyMs: artifact.llmJudge.latencyMs,
          tokenUsage: artifact.llmJudge.tokenUsage,
        }
        : undefined,
    };
  } catch (error) {
    return {
      artifactReadError: error instanceof Error ? error.message : String(error),
    };
  }
}

function runEval(args, env) {
  return new Promise((resolve) => {
    const child = spawn("bun", args, { env });
    let combined = "";
    const observe = (chunk, stream) => {
      stream.write(chunk);
      combined += chunk.toString("utf8");
      if (combined.length > 2_000_000) combined = combined.slice(-2_000_000);
    };
    child.stdout.on("data", (chunk) => observe(chunk, process.stdout));
    child.stderr.on("data", (chunk) => observe(chunk, process.stderr));
    child.on("error", (error) => {
      console.error(error);
      resolve({ code: 1, outputTail: combined, spawnError: error.message });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, outputTail: combined });
    });
  });
}

const options = parseOptions(process.argv.slice(2));
validateEvals(options.evals);

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const rootArtifactDir = path.resolve(
  options.artifactDir ?? `.eval-artifacts/matrix-${timestamp}`,
);
mkdirSync(rootArtifactDir, { recursive: true });

const startedAt = new Date().toISOString();
const results = [];

for (const model of options.models) {
  for (const evalName of options.evals) {
    for (let repeatIndex = 1; repeatIndex <= options.repeat; repeatIndex += 1) {
      const repeatLabel = `repeat-${String(repeatIndex).padStart(2, "0")}`;
      const artifactDir = options.repeat > 1
        ? path.join(rootArtifactDir, safePathPart(model), repeatLabel)
        : path.join(rootArtifactDir, safePathPart(model));
      const args = [
        "scripts/run-agent-eval.mjs",
        evalName,
        "--model",
        model,
        "--artifact-dir",
        artifactDir,
        ...options.passThrough,
      ];
      console.log(`\n[eval-matrix] ${evalName} model=${model} repeat=${repeatIndex}/${options.repeat}`);
      console.log(`bun ${args.map(shellQuote).join(" ")}`);
      if (options.dryRun) {
        results.push({ evalName, model, repeat: repeatIndex, code: 0, skipped: true, artifactDir });
        continue;
      }

      const child = await runEval(args, process.env);
      const reportUrls = uniqueMatches(
        child.outputTail,
        /https:\/\/evals\.camelai\.dev\/#\/run\/[A-Za-z0-9._-]+/g,
      );
      const artifactPaths = uniqueMatches(
        child.outputTail,
        /(?<=Wrote eval artifact: ).+/g,
      ).map((value) => value.trim());
      const artifactPath = artifactPaths.at(-1);
      results.push({
        evalName,
        model,
        repeat: repeatIndex,
        code: child.code,
        artifactDir,
        artifactPath,
        reportUrls,
        spawnError: child.spawnError,
        summary: summarizeArtifact(artifactPath),
      });
    }
  }
}

const finishedAt = new Date().toISOString();
const failures = results.filter((result) => result.code !== 0);
const summary = {
  schemaVersion: 1,
  startedAt,
  finishedAt,
  options: {
    models: options.models,
    evals: options.evals,
    repeat: options.repeat,
    passThrough: options.passThrough,
    dryRun: options.dryRun,
  },
  rootArtifactDir,
  totalRuns: results.length,
  failedRuns: failures.length,
  results,
};
const summaryPath = path.join(rootArtifactDir, "matrix-summary.json");
writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

console.log("\n[eval-matrix] summary");
for (const result of results) {
  const status = result.code === 0 ? "ok" : `failed(${result.code})`;
  const score = result.summary?.scorePercentage !== undefined
    ? ` score=${result.summary.scorePercentage}`
    : "";
  const agreement = result.summary?.llmJudge?.agreement !== undefined
    ? ` judgeAgreement=${result.summary.llmJudge.agreement}`
    : "";
  const report = result.reportUrls?.at(-1) ? ` report=${result.reportUrls.at(-1)}` : "";
  console.log(`${status}\t${result.model}\t${result.evalName}\trepeat=${result.repeat}${score}${agreement}${report}`);
}
console.log(`[eval-matrix] artifacts: ${rootArtifactDir}`);
console.log(`[eval-matrix] summary: ${summaryPath}`);

if (failures.length) process.exit(1);
