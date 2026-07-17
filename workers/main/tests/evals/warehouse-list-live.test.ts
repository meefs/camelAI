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
import { usedTool } from "./project-eval-helpers";

// This eval exercises connection discovery through the lean code-mode surface.
// The specialized analysis listing and the general connections listing both
// answer an empty-workspace warehouse question correctly, so grade the semantic
// listing behavior rather than overfitting to one internal alias.

type WarehouseEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  RUN_AGENT_EVALS?: string;
};

const testEnv = env as unknown as WarehouseEvalEnv;
const maybeIt = testEnv.RUN_AGENT_EVALS === "1" ? it : it.skip;
const SESSION_TIMEOUT_MS = getEvalTimeoutMs(testEnv, 150_000);

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
        timeoutMs: SESSION_TIMEOUT_MS,
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
        usedTool(result.events, "analysis_list_connections") ||
        usedTool(result.events, "warehouse_list_connections") ||
        usedTool(result.events, "connections_list");
      const evaluation = buildEvalCriteriaSummary({
        passFail: [
          buildSessionCompletedCriterion(result),
          passFailCriterion({
            id: "called_warehouse_list",
            label: "Agent used a connection-listing path to inspect warehouses",
            passed: calledWarehouseList,
            reason: calledWarehouseList
              ? undefined
              : "Agent did not call a supported connection-listing path.",
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
          buildNoAssistantErrorCriterion(result),
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
            : ["agent did not call a supported connection-listing path"],
        },
      });

      assertPassFailCriteria(evaluation);
    },
    SESSION_TIMEOUT_MS + 60_000,
  );
});
