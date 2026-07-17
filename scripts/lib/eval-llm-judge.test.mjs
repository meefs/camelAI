import assert from "node:assert/strict";
import test from "node:test";

import {
  attachEvalLlmJudge,
  buildEvalJudgeInput,
  computeRubricGrade,
  resolveEvalGrade,
  shouldAdjudicateEvalJudge,
  validateEvalRubric,
} from "./eval-llm-judge.mjs";

function transcript(overrides = {}) {
  return {
    status: "completed",
    rubric: {
      version: 1,
      objective: "Repair the app and verify it",
      passThreshold: 75,
      criticalMinimum: 3,
      criteria: [
        {
          id: "working_result",
          description: "The final app works for the requested flow",
          weight: 60,
          critical: true,
          evidenceHints: ["livePageSmoke"],
        },
        {
          id: "verification",
          description: "The agent verified the final state",
          weight: 25,
        },
        {
          id: "reporting",
          description: "The final response accurately reports the result",
          weight: 15,
        },
      ],
    },
    evaluation: {
      passFail: {
        passed: false,
        total: 1,
        failed: 1,
        criteria: [
          {
            id: "literal_row_probe",
            label: "Static inspector found enough literal rows",
            status: "failed",
            reason: "Inspector counted one literal row",
            details: { literalRows: 1 },
          },
        ],
      },
      scorecard: { points: 0, maxPoints: 1, percentage: 0, criteria: [] },
    },
    livePageSmoke: { status: 200, renderedRows: 8 },
    grading: { mode: "llm-judge", outcome: "failed", passed: false },
    ...overrides,
  };
}

test("judge input uses task rubric and hides machine verdicts and target model", () => {
  const input = buildEvalJudgeInput(transcript(), {
    evalName: "dashboard-live",
    targetModel: "deepseek-v4-auto",
    manifestEntry: { description: "Build a dashboard", kind: "skill" },
  });

  assert.equal(input.rubric.objective, "Repair the app and verify it");
  assert.equal(input.rubric.criteria[0].weight, 60);
  assert.deepEqual(input.artifacts.livePageSmoke, { status: 200, renderedRows: 8 });
  assert.equal(JSON.stringify(input).includes("deepseek-v4-auto"), false);
  assert.equal(JSON.stringify(input).includes('"status":"failed"'), false);
  assert.equal(input.rubric.source, "task");
  assert.equal(input.artifacts.rubric, undefined);
  assert.equal(input.artifacts.grading, undefined);
});

test("the harness computes outcome and weighted score from exact criterion judgments", () => {
  const rubric = buildEvalJudgeInput(transcript(), {
    evalName: "dashboard-live",
    manifestEntry: {},
  }).rubric;
  const grade = computeRubricGrade(rubric, [
    { id: "working_result", score: 4, status: "met", evidenceRefs: ["livePageSmoke"], rationale: "works" },
    { id: "verification", score: 3, status: "met", evidenceRefs: ["trajectory:12"], rationale: "verified" },
    { id: "reporting", score: 3, status: "met", evidenceRefs: ["result"], rationale: "accurate" },
  ]);
  assert.equal(grade.outcome, "passed");
  assert.equal(grade.weightedScore, 90);
  assert.equal(grade.criticalGatePassed, true);
  assert.throws(
    () => computeRubricGrade(rubric, [
      { id: "working_result", score: 4, status: "met", evidenceRefs: [] },
      { id: "verification", score: 3, status: "met", evidenceRefs: ["x"] },
      { id: "reporting", score: 3, status: "met", evidenceRefs: ["x"] },
    ]),
    /without evidenceRefs/,
  );
  assert.throws(
    () => computeRubricGrade(rubric, [
      { id: "working_result", score: 4, status: "met", evidenceRefs: ["x"] },
      { id: "verification", score: 3, status: "met", evidenceRefs: ["x"] },
      { id: "verification", score: 3, status: "met", evidenceRefs: ["x"] },
    ]),
    /exactly once/,
  );
});

test("reference evidence is isolated as trusted ground truth", () => {
  const input = buildEvalJudgeInput(transcript({
    referenceEvidence: { facts: ["compatibility date 2026-03-24"] },
  }), { evalName: "research-live", manifestEntry: {} });
  assert.deepEqual(input.referenceEvidence, { facts: ["compatibility date 2026-03-24"] });
  assert.equal(input.artifacts.referenceEvidence, undefined);
});

test("selective adjudication triggers for disagreement but not confident clear results", () => {
  const rubric = buildEvalJudgeInput(transcript(), {
    evalName: "dashboard-live",
    manifestEntry: {},
  }).rubric;
  const clear = {
    outcome: "passed",
    confidence: 0.95,
    weightedScore: 95,
    criteria: rubric.criteria.map((criterion) => ({ id: criterion.id, score: 4 })),
  };
  assert.equal(shouldAdjudicateEvalJudge(clear, transcript({
    evaluation: { passFail: { passed: true } },
  }), rubric), null);
  assert.equal(shouldAdjudicateEvalJudge(clear, transcript(), rubric), "machine_disagreement");
});

test("judge result is primary even when machine probes disagree", () => {
  const grade = resolveEvalGrade(transcript({
    llmJudge: {
      status: "completed",
      outcome: "passed",
      confidence: 0.92,
      weightedScore: 86,
      judgeModel: "openai/gpt-5.6-luna",
    },
  }));

  assert.deepEqual(grade, {
    schemaVersion: 1,
    mode: "llm-judge",
    primary: true,
    passed: true,
    outcome: "passed",
    confidence: 0.92,
    weightedScore: 86,
    judgeModel: "openai/gpt-5.6-luna",
  });
});

test("disabled or unavailable judge falls back to machine probes", async () => {
  const value = transcript({
    evaluation: {
      passFail: { passed: true, total: 0, failed: 0, criteria: [] },
      scorecard: { points: 0, maxPoints: 0, percentage: 0, criteria: [] },
    },
  });

  await attachEvalLlmJudge(value, {
    env: { EVAL_LLM_JUDGE: "0" },
    evalName: "fallback-live",
    targetModel: "hidden",
  });

  assert.equal(value.llmJudge.status, "skipped");
  assert.equal(value.grading.mode, "machine-fallback");
  assert.equal(value.grading.passed, true);
});

test("task rubrics require distinct criteria whose weights total 100", () => {
  assert.throws(
    () => validateEvalRubric({
      criteria: [
        { id: "one", description: "One", weight: 60 },
        { id: "two", description: "Two", weight: 30 },
        { id: "three", description: "Three", weight: 5 },
      ],
    }),
    /weights must total 100/,
  );
});
