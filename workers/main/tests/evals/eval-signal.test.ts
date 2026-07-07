import { describe, expect, it } from "vitest";

import { countEvalTokenUsage, evaluateAgentEvalSignal } from "./eval-signal";

describe("eval signal scoring", () => {
  it("counts turns and flags failed or suspicious tool calls", () => {
    const signal = evaluateAgentEvalSignal(
      {
        messages: [
          {
            id: "msg1",
            thread_id: "thread1",
            role: "user",
            content: "do work",
            created_at: 1,
            forkEntryId: "msg1",
          },
          {
            id: "msg2",
            thread_id: "thread1",
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool1",
                name: "bash",
                input: { command: "npm test" },
              },
              {
                type: "tool_result",
                tool_use_id: "tool1",
                content:
                  'Validation failed for tool "bash": project is required',
              },
            ],
            created_at: 2,
            forkEntryId: "msg2",
          },
          {
            id: "msg3",
            thread_id: "thread1",
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool2",
                name: "ls",
                input: { path: "/workspace/index.html" },
              },
            ],
            created_at: 3,
            forkEntryId: "msg3",
          },
        ],
        events: [
          {
            type: "runtime_event",
            event: {
              method: "item/completed",
              params: {
                item: {
                  id: "tool1",
                  type: "commandExecution",
                  status: "failed",
                  aggregatedOutput:
                    'Validation failed for tool "bash": project is required',
                  result: { details: {} },
                },
              },
            },
          },
          {
            type: "runtime_event",
            event: {
              method: "item/completed",
              params: {
                item: {
                  id: "tool2",
                  type: "dynamicToolCall",
                  tool: "ls",
                  status: "completed",
                  arguments: { path: "/workspace/index.html" },
                  result: {
                    details: {
                      source: "bundled_skill",
                      text: "developing-software",
                    },
                  },
                },
              },
            },
          },
          {
            type: "runtime_event",
            event: {
              method: "item/completed",
              params: {
                item: {
                  id: "tool3",
                  type: "commandExecution",
                  status: "completed",
                  aggregatedOutput: "not found",
                  result: {
                    details: {
                      success: false,
                      exitCode: 1,
                      stderr: "not found",
                    },
                  },
                },
              },
            },
          },
        ],
      },
      {
        maxAssistantTurns: 1,
        maxBadToolCalls: 1,
      },
    );

    expect(signal.assistantTurnCount).toBe(2);
    expect(signal.sdkTurnStartCount).toBe(0);
    expect(signal.sdkTurnCompletedCount).toBe(0);
    expect(signal.toolCallCount).toBe(2);
    expect(signal.toolCallsByName).toEqual({ bash: 1, ls: 1 });
    expect(signal.harnessErrorCount).toBe(0);
    expect(signal.filteredEnvLimitationCount).toBe(0);
    expect(signal.badToolCalls.map((call) => call.reason)).toEqual([
      "validation_failed",
      "ls_file_path_resolved_to_skill_catalog",
      "tool_result_unsuccessful",
    ]);
    expect(signal.violations).toEqual([
      "assistant turns 2 exceeded max 1",
      "bad tool calls 3 exceeded max 1",
    ]);
    expect(signal.tokenUsage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalTokens: 0,
      turnCount: 0,
    });
  });

  it("does not count take_screenshot BROWSER-binding failures as bad tool calls", () => {
    // Known eval-env limitation: the Miniflare eval environment has no BROWSER
    // binding, so take_screenshot always fails there. Not agent misbehavior.
    const signal = evaluateAgentEvalSignal(
      {
        messages: [],
        events: [
          {
            type: "runtime_event",
            event: {
              method: "item/completed",
              params: {
                item: {
                  id: "tool1",
                  type: "dynamicToolCall",
                  tool: "take_screenshot",
                  status: "failed",
                  arguments: { app_name: "space-matching-game" },
                  result: {
                    details: {
                      text: "Screenshot capture requires the BROWSER binding, which is not configured for this environment.",
                    },
                  },
                },
              },
            },
          },
          {
            type: "runtime_event",
            event: {
              method: "item/completed",
              params: {
                item: {
                  id: "tool2",
                  type: "dynamicToolCall",
                  tool: "take_screenshot",
                  status: "failed",
                  arguments: { app_name: "space-matching-game" },
                  result: { details: { text: "some other real failure" } },
                },
              },
            },
          },
        ],
      },
      {},
    );

    expect(signal.badToolCallCount).toBe(1);
    expect(signal.filteredEnvLimitationCount).toBe(1);
    expect(signal.filteredEnvLimitations).toMatchObject([
      {
        id: "tool1",
        tool: "take_screenshot",
        reason: "missing_browser_binding_screenshot",
      },
    ]);
    expect(signal.badToolCalls).toMatchObject([
      { id: "tool2", tool: "take_screenshot", reason: "tool_status_failed" },
    ]);
  });

  it("does not count env.BROWSER.launch BROWSER-binding failures as bad tool calls", () => {
    // Same known eval-env limitation: no BROWSER binding, so js_exec code that
    // calls env.BROWSER.launch fails with the browser-session variant of the
    // message. Not agent misbehavior.
    const signal = evaluateAgentEvalSignal(
      {
        messages: [],
        events: [
          {
            type: "runtime_event",
            event: {
              method: "item/completed",
              params: {
                item: {
                  id: "tool1",
                  type: "dynamicToolCall",
                  tool: "js_exec",
                  status: "failed",
                  arguments: { code: "await env.BROWSER.launch({ scriptName })" },
                  result: {
                    details: {
                      text: "Browser sessions require the BROWSER binding",
                    },
                  },
                },
              },
            },
          },
        ],
      },
      {},
    );

    expect(signal.badToolCallCount).toBe(0);
    expect(signal.filteredEnvLimitationCount).toBe(1);
    expect(signal.filteredEnvLimitationsByReason).toEqual({
      missing_browser_binding_session: 1,
    });
  });

  it("counts SDK turns and enforces their threshold", () => {
    const signal = evaluateAgentEvalSignal(
      {
        messages: [],
        events: [
          { type: "runtime_event", event: { method: "sdk/turn/started", params: {} } },
          { type: "runtime_event", event: { method: "sdk/turn/completed", params: {} } },
          { type: "runtime_event", event: { method: "sdk/turn/started", params: {} } },
        ],
      },
      { maxSdkTurns: 1 },
    );

    expect(signal.sdkTurnStartCount).toBe(2);
    expect(signal.sdkTurnCompletedCount).toBe(1);
    expect(signal.violations).toEqual(["sdk turns 2 exceeded max 1"]);
  });

  it("sums token usage from Pi turn completion events", () => {
    const tokenUsage = countEvalTokenUsage({
      events: [
        {
          type: "runtime_event",
          event: {
            method: "turn/completed",
            params: {
              usage: {
                input: 1200,
                output: 340,
                cacheRead: 50,
                cacheWrite: 10,
                cost: { total: 0.0042 },
              },
            },
          },
        },
        {
          type: "runtime_event",
          event: {
            method: "turn/completed",
            params: {
              usage: {
                input_tokens: 800,
                output_tokens: 120,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
              },
            },
          },
        },
        {
          type: "runtime_event",
          event: {
            method: "turn/completed",
            params: {
              usage: {
                totalTokens: 256,
              },
            },
          },
        },
      ],
    });

    expect(tokenUsage).toEqual({
      inputTokens: 2000,
      outputTokens: 460,
      cacheReadInputTokens: 50,
      cacheCreationInputTokens: 10,
      totalTokens: 2776,
      turnCount: 3,
      costUsd: 0.0042,
    });
  });

  it("prefers SDK turn token usage over legacy visible turn completion usage", () => {
    const tokenUsage = countEvalTokenUsage({
      events: [
        {
          type: "runtime_event",
          event: {
            method: "turn/completed",
            params: { usage: { input: 9999, output: 9999 } },
          },
        },
        {
          type: "runtime_event",
          event: {
            method: "sdk/turn/completed",
            params: {
              usage: {
                input: 100,
                output: 20,
                cacheRead: 5,
                cost: { total: 0.001 },
              },
            },
          },
        },
        {
          type: "runtime_event",
          event: {
            method: "sdk/turn/completed",
            params: { usage: { input: 50, output: 10, cacheWrite: 2 } },
          },
        },
      ],
    });

    expect(tokenUsage).toEqual({
      inputTokens: 150,
      outputTokens: 30,
      cacheReadInputTokens: 5,
      cacheCreationInputTokens: 2,
      totalTokens: 187,
      turnCount: 2,
      costUsd: 0.001,
    });
  });
});
