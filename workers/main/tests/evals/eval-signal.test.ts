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
    expect(signal.toolCallCount).toBe(2);
    expect(signal.toolCallsByName).toEqual({ bash: 1, ls: 1 });
    expect(signal.harnessErrorCount).toBe(0);
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
});
