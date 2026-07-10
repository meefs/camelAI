import { describe, expect, it } from "vitest";

import {
  assertPassFailCriteria,
  buildEvalCriteriaSummary,
  buildNoAssistantErrorCriterion,
  passFailCriterion,
  scoreCriterion,
  scoreSignalEfficiency,
  scoreLatestPreview,
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

  it("detects structured assistant error blocks without matching ordinary text", () => {
    expect(
      buildNoAssistantErrorCriterion({
        messages: [{ role: "assistant", content: [{ type: "error", title: "Assistant error", error: "boom" }] }] as never,
      }).status,
    ).toBe("failed");
    expect(
      buildNoAssistantErrorCriterion({
        messages: [{ role: "assistant", content: [{ type: "text", text: "The phrase assistant error is harmless here." }] }] as never,
      }).status,
    ).toBe("passed");
  });

  it("awards full preview points after a deploy_project invocation", () => {
    const events = [
      { type: "runtime_event", event: { method: "item/completed", params: { item: { tool: "js_exec", arguments: { code: "await tools.deploy_project({ project: 'demo' });" } } } } },
      { type: "runtime_event", event: { method: "item/completed", params: { item: { tool: "set_preview", arguments: { app_name: "demo" } } } } },
    ];
    expect(scoreLatestPreview(events).points).toBe(5);
  });

  it("does not award full preview points when preview precedes the final deploy", () => {
    const events = [
      { type: "runtime_event", event: { method: "item/completed", params: { item: { tool: "set_preview", arguments: { app_name: "demo" } } } } },
      { type: "runtime_event", event: { method: "item/completed", params: { item: { tool: "js_exec", arguments: { code: "await tools.deploy_project({ project: 'demo' });" } } } } },
    ];
    expect(scoreLatestPreview(events)).toMatchObject({
      points: 2,
      maxPoints: 5,
      reason: "A set_preview call was found, but not after the final completed deploy invocation.",
    });
  });

  it("ignores deploy_project mentions in result text after the preview", () => {
    const events = [
      { type: "runtime_event", event: { method: "item/completed", params: { item: { tool: "js_exec", arguments: { code: "await tools.deploy_project({ project: 'demo' });" } } } } },
      { type: "runtime_event", event: { method: "item/completed", params: { item: { tool: "set_preview", arguments: { app_name: "demo" } } } } },
      { type: "result", result: "The app was deployed with deploy_project and previewed." },
    ];

    expect(scoreLatestPreview(events)).toMatchObject({
      points: 5,
      maxPoints: 5,
      details: {
        invocationOrder: ["deploy_project", "set_preview"],
        finalDeployIndex: 0,
        finalPreviewIndex: 1,
      },
    });
  });

  it("recognizes a completed deploy command without scanning unrelated event text", () => {
    const events = [
      { type: "runtime_event", event: { method: "item/completed", params: { item: { type: "commandExecution", command: "bun run deploy" } } } },
      { type: "runtime_event", event: { method: "item/completed", params: { item: { tool: "set_preview", arguments: { app_name: "demo" } } } } },
    ];

    expect(scoreLatestPreview(events)).toMatchObject({
      points: 5,
      details: {
        invocationOrder: ["deploy_command", "set_preview"],
      },
    });
  });

  it("does not award full preview credit for failed deploy or preview calls", () => {
    const failedDeployEvents = [
      { type: "runtime_event", event: { method: "item/completed", params: { item: { tool: "js_exec", status: "completed", arguments: { code: "await tools.deploy_project({ project: 'demo' });" }, result: { success: false, error: "build failed" } } } } },
      { type: "runtime_event", event: { method: "item/completed", params: { item: { tool: "set_preview", status: "completed", arguments: { app_name: "demo" }, result: { ok: true } } } } },
    ];
    expect(scoreLatestPreview(failedDeployEvents)).toMatchObject({
      points: 2,
      details: {
        invocationOrder: ["set_preview"],
        finalDeployIndex: -1,
        finalPreviewIndex: 0,
      },
    });

    const failedPreviewEvents = [
      { type: "runtime_event", event: { method: "item/completed", params: { item: { tool: "deploy_project", status: "completed", result: { success: true } } } } },
      { type: "runtime_event", event: { method: "item/completed", params: { item: { tool: "set_preview", status: "completed", isError: true, result: { ok: false } } } } },
    ];
    expect(scoreLatestPreview(failedPreviewEvents)).toMatchObject({
      points: 0,
      reason: "No set_preview call was found.",
    });
  });
});
