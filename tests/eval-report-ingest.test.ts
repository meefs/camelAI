import { describe, expect, it } from "vitest";

import { ingestResults } from "../workers/eval-reports/src/ingest";

function artifact(overrides: Record<string, unknown> = {}) {
  return {
    name: "sample.json",
    json: {
      evaluation: {
        passFail: {
          passed: false,
          total: 1,
          failed: 1,
          criteria: [
            { id: "brittle_probe", label: "Brittle probe", status: "failed" },
          ],
        },
        scorecard: { points: 0, maxPoints: 1, percentage: 0, criteria: [] },
      },
      ...overrides,
    },
  };
}

describe("eval report judge-primary ingest", () => {
  it("keeps failed machine probes as evidence without overriding a passing judge", () => {
    const result = ingestResults(0, [artifact({
      grading: {
        schemaVersion: 1,
        mode: "llm-judge",
        primary: true,
        passed: true,
        outcome: "passed",
        confidence: 0.96,
        weightedScore: 88,
        judgeModel: "openai/gpt-5.6-luna",
      },
    })]);

    expect(result.status).toBe("completed");
    expect(result.evaluation?.passFail.failed).toBe(1);
    expect(result.grading).toMatchObject({ primary: true, passed: true });
  });

  it("preserves a hard runner failure even when the judge passed", () => {
    const result = ingestResults(1, [artifact({
      grading: {
        schemaVersion: 1,
        mode: "llm-judge",
        primary: true,
        passed: true,
        outcome: "passed",
      },
    })]);

    expect(result.status).toBe("failed");
  });

  it("uses machine criteria when no primary judge grade is available", () => {
    const result = ingestResults(1, [artifact()]);
    expect(result.status).toBe("failed");
  });
});
