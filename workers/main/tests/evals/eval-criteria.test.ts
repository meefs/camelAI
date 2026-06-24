import { describe, expect, it } from "vitest";

import {
  assertPassFailCriteria,
  buildEvalCriteriaSummary,
  passFailCriterion,
  scoreCriterion,
  scoreSignalEfficiency,
} from "./eval-criteria";

describe("eval criteria helpers", () => {
  it("builds pass/fail and scorecard totals", () => {
    const summary = buildEvalCriteriaSummary({
      passFail: [
        passFailCriterion({ id: "a", label: "A", passed: true }),
        passFailCriterion({
          id: "b",
          label: "B",
          passed: false,
          reason: "missing evidence",
        }),
      ],
      scorecard: [
        scoreCriterion({ id: "s1", label: "S1", points: 2, maxPoints: 4 }),
        scoreCriterion({ id: "s2", label: "S2", points: 3, maxPoints: 6 }),
      ],
    });

    expect(summary.passFail).toMatchObject({
      passed: false,
      total: 2,
      failed: 1,
    });
    expect(summary.scorecard).toMatchObject({
      points: 5,
      maxPoints: 10,
      percentage: 50,
    });
    expect(() => assertPassFailCriteria(summary)).toThrow(
      /B \(b\): missing evidence/,
    );
  });

  it("scores signal efficiency by the first matching tier", () => {
    expect(
      scoreSignalEfficiency(
        { assistantTurnCount: 9, badToolCallCount: 1 },
        {
          maxPoints: 4,
          fallbackPoints: 1,
          tiers: [
            { maxAssistantTurns: 6, maxBadToolCalls: 0, points: 4 },
            { maxAssistantTurns: 10, maxBadToolCalls: 1, points: 3 },
          ],
        },
      ).points,
    ).toBe(3);
  });

  it("rejects invalid score criteria", () => {
    expect(() =>
      scoreCriterion({ id: "bad", label: "Bad", points: 2, maxPoints: 1 }),
    ).toThrow(/between 0 and maxPoints/);
  });
});
