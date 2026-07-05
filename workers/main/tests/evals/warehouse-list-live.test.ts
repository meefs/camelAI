import { env } from "cloudflare:test";
import { describe, it } from "vitest";

import { createOrg, createUser, type TestEnv } from "../test-helpers";
import {
  assertPassFailCriteria,
  buildEvalCriteriaSummary,
  buildNoAssistantErrorCriterion,
  buildResultEventCriterion,
  buildRuntimeEventsCriterion,
  buildSessionCompletedCriterion,
  passFailCriterion,
  scoreSignalEfficiency,
} from "./eval-criteria";
import { emitEvalTranscript } from "./eval-transcript";
import {
  evaluateAgentEvalSignal,
  getEvalSignalThresholds,
  type EvalSignalEnv,
} from "./eval-signal";
import {
  configureEvalModel,
  getEvalTimeoutMs,
  type EvalModelEnv,
} from "./model-config";
import type { ChatThreadDO } from "../../src/chat-thread-do";

// This eval exercises the analysis connections listing (analysis_list_connections;
// warehouse_list_connections is its hidden source-compat alias). The tool lives in
// the "connections" category, which the lean tool surface (now the default) drops
// from the model's top-level tool list — so this eval verifies the agent can still
// DISCOVER and invoke it via tools.search inside js_exec. Listing connections is a
// clean read (empty in the eval workspace, no network), so the discriminating
// signal is whether the agent found and called the dropped tool.

type WarehouseEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  RUN_AGENT_EVALS?: string;
};

const testEnv = env as unknown as WarehouseEvalEnv;
const maybeIt = testEnv.RUN_AGENT_EVALS === "1" ? it : it.skip;

// A tool can be invoked either as a top-level tool call (full mode) or via
// `tools.<name>(...)` / `tools["<name>"](...)` inside js_exec (lean mode) — the
// tools.search() `call` hint recommends the bracket form — so detect all three.
// Top-level calls show up in signal.toolCallsByName; js_exec calls only appear
// in the js_exec `code`.
function agentInvokedTool(
  toolName: string,
  toolCallsByName: Record<string, number>,
  messages: unknown,
): boolean {
  if ((toolCallsByName[toolName] ?? 0) >= 1) return true;
  const callPattern = new RegExp(`(?:tools\\.|tools\\[\\s*["'])?${toolName}(?:["']\\s*\\])?\\s*\\(`);
  for (const msg of (Array.isArray(messages) ? messages : []) as Array<{
    content?: Array<{ type?: string; name?: string; input?: { code?: unknown } }>;
  }>) {
    for (const item of msg.content ?? []) {
      if (item.type === "tool_use" && item.name === "js_exec") {
        const code = typeof item.input?.code === "string" ? item.input.code : "";
        if (callPattern.test(code)) return true;
      }
    }
  }
  return false;
}

describe("warehouse list connections agent eval", () => {
  maybeIt(
    "asks the agent to list warehouse connections, verifying tool discovery",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const { userId } = await createUser(
        testEnv,
        `warehouse-eval-${suffix}@example.com`,
        "password123",
        "Warehouse Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Warehouse Eval ${suffix}`,
        userId,
      );

      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      await configureEvalModel(testEnv, orgStub, userId);
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Warehouse list eval",
        userId,
        undefined,
        testEnv.EVAL_MODEL,
      );

      const chatThread = testEnv.CHAT_THREAD.get(
        testEnv.CHAT_THREAD.idFromName(thread.id),
      );
      const result = await chatThread.runAgentEvalSession({
        threadId: thread.id,
        workspaceId: defaultWorkspaceId,
        orgId: org.id,
        userId,
        userName: "Warehouse Eval",
        userEmail: `warehouse-eval-${suffix}@example.com`,
        messageSource: "eval",
        timeoutMs: getEvalTimeoutMs(testEnv, 150_000),
        message: [
          "Using the data-warehouse query tooling, list the data warehouse connections configured in this workspace",
          "(for example BigQuery, ClickHouse, Snowflake, or Databricks) and report how many there are.",
        ].join(" "),
      });

      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          maxAssistantTurns: 5,
          maxBadToolCalls: 1,
        }),
      );

      // The canonical tool is analysis_list_connections; warehouse_list_connections
      // remains a callable-but-hidden source-compat alias, so accept either.
      const calledWarehouseList =
        agentInvokedTool("analysis_list_connections", signal.toolCallsByName, result.messages) ||
        agentInvokedTool("warehouse_list_connections", signal.toolCallsByName, result.messages);

      const transcriptText = JSON.stringify({
        result: result.result,
        events: result.events,
        messages: result.messages,
      }).toLowerCase();
      const evaluation = buildEvalCriteriaSummary({
        passFail: [
          buildSessionCompletedCriterion(result),
          // The core regression check: the connections listing is not a top-level
          // tool, so the agent must have discovered it via tools.search.
          passFailCriterion({
            id: "called_warehouse_list",
            label: "Agent discovered and called analysis_list_connections",
            passed: calledWarehouseList,
            reason: calledWarehouseList
              ? undefined
              : "Agent did not discover/call analysis_list_connections (or the warehouse_list_connections alias).",
            details: { toolCallsByName: signal.toolCallsByName },
          }),
          passFailCriterion({
            id: "produced_token_usage",
            label: "Agent produced token usage",
            passed: signal.tokenUsage.totalTokens > 0,
            reason:
              signal.tokenUsage.totalTokens > 0
                ? undefined
                : "Signal reported zero total tokens.",
            details: { totalTokens: signal.tokenUsage.totalTokens },
          }),
          buildNoAssistantErrorCriterion(transcriptText),
          buildRuntimeEventsCriterion(result),
          buildResultEventCriterion(result),
        ],
        scorecard: [
          scoreSignalEfficiency(signal, {
            maxPoints: 4,
            fallbackPoints: 1,
            tiers: [
              { maxAssistantTurns: 5, maxBadToolCalls: 1, points: 4 },
              { maxAssistantTurns: 10, maxBadToolCalls: 2, points: 3 },
              { maxAssistantTurns: 15, maxBadToolCalls: 3, points: 2 },
            ],
          }),
        ],
      });

      emitEvalTranscript({
        status: result.status,
        evaluation,
        error: result.error,
        model: testEnv.EVAL_MODEL,
        signal,
        result: result.result,
        events: result.events,
        messages: result.messages,
        runtimeAssertions: {
          calledWarehouseList,
          toolCallsByName: signal.toolCallsByName,
          failures: calledWarehouseList
            ? []
            : ["agent did not discover/call warehouse_list_connections"],
        },
      });

      assertPassFailCriteria(evaluation);
    },
    240_000,
  );
});
