import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  attachEvalLlmJudge,
  buildEvalJudgeInput,
  EVAL_JUDGE_PROMPT_VERSION,
  evalJudgeEvidenceHash,
} from "./lib/eval-llm-judge.mjs";

const root = path.resolve(process.argv[2] ?? ".eval-artifacts");
const concurrency = Math.max(1, Number(process.env.EVAL_JUDGE_CONCURRENCY ?? 4));
if (!existsSync(root)) {
  console.error(`Artifact directory does not exist: ${root}`);
  process.exit(1);
}

const manifest = JSON.parse(
  readFileSync(path.resolve("workers/main/tests/evals/manifest.json"), "utf8"),
);
const manifestById = new Map(manifest.evals.map((entry) => [entry.id, entry]));

function artifactFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...artifactFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith(".json") && entry.name !== "summary.json") {
      files.push(fullPath);
    }
  }
  return files;
}

function evalIdFor(filePath) {
  const parent = path.basename(path.dirname(filePath));
  if (manifestById.has(parent)) return parent;
  const filename = path.basename(filePath, ".json");
  return [...manifestById.keys()]
    .sort((a, b) => b.length - a.length)
    .find((id) => filename === id || filename.startsWith(`${id}-`));
}

const jobs = artifactFiles(root)
  .map((filePath) => ({ filePath, evalId: evalIdFor(filePath) }))
  .filter((job) => job.evalId)
  .filter((job) => {
    if (process.env.EVAL_JUDGE_FORCE === "1") return true;
    try {
      const transcript = JSON.parse(readFileSync(job.filePath, "utf8"));
      const context = {
        evalName: job.evalId,
        targetModel: transcript.model,
        manifestEntry: manifestById.get(job.evalId),
      };
      return transcript.llmJudge?.promptVersion !== EVAL_JUDGE_PROMPT_VERSION ||
        transcript.llmJudge?.evidenceHash !== evalJudgeEvidenceHash(buildEvalJudgeInput(transcript, context));
    } catch {
      return true;
    }
  })
  .filter((job) => {
    if (process.env.EVAL_JUDGE_ONLY_ERRORS !== "1") return true;
    try {
      const transcript = JSON.parse(readFileSync(job.filePath, "utf8"));
      return transcript.llmJudge?.status !== "completed";
    } catch {
      return true;
    }
  });

let nextIndex = 0;
const results = [];
async function worker() {
  while (nextIndex < jobs.length) {
    const job = jobs[nextIndex++];
    try {
      const transcript = JSON.parse(readFileSync(job.filePath, "utf8"));
      await attachEvalLlmJudge(transcript, {
        env: process.env,
        evalName: job.evalId,
        targetModel: transcript.model,
        manifestEntry: manifestById.get(job.evalId),
      });
      writeFileSync(job.filePath, `${JSON.stringify(transcript, null, 2)}\n`);
      const outcome = transcript.grading?.outcome ?? "unavailable";
      results.push({ evalId: job.evalId, outcome, filePath: job.filePath });
      console.log(`[${outcome}] ${job.evalId}`);
    } catch (error) {
      results.push({
        evalId: job.evalId,
        outcome: "error",
        filePath: job.filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      console.error(`[error] ${job.evalId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));

const counts = Object.groupBy(results, (result) => result.outcome);
const summary = Object.fromEntries(
  Object.entries(counts).map(([outcome, values]) => [outcome, values.length]),
);
console.log(JSON.stringify({ root, total: results.length, summary }, null, 2));
if (results.some((result) => result.outcome === "error" || result.outcome === "unavailable")) {
  process.exitCode = 1;
}
