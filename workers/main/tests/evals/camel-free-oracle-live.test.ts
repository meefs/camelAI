import { env } from "cloudflare:test";
import { describe, it } from "vitest";

import type { ChatThreadDO } from "../../src/chat-thread-do";
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
import { getEvalTimeoutMs, type EvalModelEnv } from "./model-config";
import {
  completedToolDetails,
  toolProgressText,
  toolCallReferences,
  usedTool,
} from "./project-eval-helpers";

type OracleEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  RUN_AGENT_EVALS?: string;
};

const testEnv = env as unknown as OracleEvalEnv;
const maybeIt = testEnv.RUN_AGENT_EVALS === "1" ? it : it.skip;
const SESSION_TIMEOUT_MS = getEvalTimeoutMs(testEnv, 240_000);
const CAMEL_FREE_MODEL = "deepseek-v4-auto";
const EXPECTED_MARKER = "ORACLE_CHECK_231";

describe("Camel Free Oracle agent eval", () => {
  maybeIt(
    "uses the Camel Free-only Oracle and incorporates its answer",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const email = `oracle-eval-${suffix}@example.com`;
      const { userId } = await createUser(
        testEnv,
        email,
        "password123",
        "Oracle Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Oracle Eval ${suffix}`,
        userId,
        { billingPlan: "free" },
      );
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Camel Free Oracle eval",
        userId,
        undefined,
        CAMEL_FREE_MODEL,
      );
      const chatThread = testEnv.CHAT_THREAD.get(
        testEnv.CHAT_THREAD.idFromName(thread.id),
      );
      const oracleQuestion = [
        "Review this migration rule: three independent services must all succeed;",
        "their success rates are 0.99, 0.98, and 0.97.",
        "Compute the combined success probability and end the recommendation with",
        `${EXPECTED_MARKER}.`,
      ].join(" ");
      const result = await chatThread.runAgentEvalSession({
        threadId: thread.id,
        workspaceId: defaultWorkspaceId,
        orgId: org.id,
        userId,
        userName: "Oracle Eval",
        userEmail: email,
        messageSource: "eval",
        timeoutMs: SESSION_TIMEOUT_MS,
        message: [
          "You must call Oracle exactly once for a second opinion before answering.",
          `Give Oracle this question: ${oracleQuestion}`,
          `After Oracle returns, summarize its recommendation and include ${EXPECTED_MARKER}.`,
        ].join(" "),
      });
      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          maxAssistantTurns: 5,
          maxBadToolCalls: 0,
        }),
      );
      const calledOracle = usedTool(result.events, "Oracle");
      const successfulOracleCall = toolCallReferences(
        result.events,
        "Oracle",
        "combined success probability",
      );
      const oracleDetails = completedToolDetails(result.events, "Oracle");
      const oracleDetailsHideModel = !oracleDetails ||
        (!("model" in oracleDetails) && !/gpt|luna/i.test(JSON.stringify(oracleDetails)));
      const oracleProgress = toolProgressText(result.events, "Oracle");
      const oracleProgressHidesModel = oracleProgress.length > 0 &&
        !/gpt|luna|\bmodel\b/i.test(oracleProgress.join("\n"));
      const finalResult = result.result ?? "";
      const includesMarker = finalResult.includes(EXPECTED_MARKER);
      const includesProbability = /0\.94(?:1|14)|94\.1/i.test(finalResult);
      const evaluation = buildEvalCriteriaSummary({
        passFail: [
          buildSessionCompletedCriterion(result),
          passFailCriterion({
            id: "called_oracle",
            label: "Camel Free agent called Oracle",
            passed: calledOracle,
            reason: calledOracle ? undefined : "Oracle was not called.",
            details: { toolCallsByName: signal.toolCallsByName },
          }),
          passFailCriterion({
            id: "oracle_call_succeeded",
            label: "Oracle completed the requested second opinion",
            passed: successfulOracleCall,
            reason: successfulOracleCall
              ? undefined
              : "No successful Oracle call referenced the supplied probability question.",
          }),
          passFailCriterion({
            id: "oracle_answer_incorporated",
            label: "Final answer incorporated the Oracle result",
            passed: includesMarker && includesProbability,
            reason: includesMarker && includesProbability
              ? undefined
              : "Final answer lacked the marker or combined probability (~94.1%).",
            details: { includesMarker, includesProbability, finalResult },
          }),
          passFailCriterion({
            id: "oracle_model_hidden",
            label: "Oracle execution details do not expose its backing model",
            passed: oracleDetailsHideModel,
            reason: oracleDetailsHideModel
              ? undefined
              : "Oracle execution details exposed backing-model information.",
            details: { oracleDetails },
          }),
          passFailCriterion({
            id: "oracle_progress_model_hidden",
            label: "Oracle progress updates do not expose its backing model",
            passed: oracleProgressHidesModel,
            reason: oracleProgressHidesModel
              ? undefined
              : "Oracle progress was missing or exposed backing-model information.",
            details: { oracleProgress },
          }),
          buildNoAssistantErrorCriterion(result),
          buildRuntimeEventsCriterion(result),
          buildResultEventCriterion(result),
        ],
        scorecard: [
          scoreSignalEfficiency(signal, {
            maxPoints: 5,
            fallbackPoints: 1,
            tiers: [
              { maxAssistantTurns: 3, maxBadToolCalls: 0, points: 5 },
              { maxAssistantTurns: 5, maxBadToolCalls: 0, points: 4 },
              { maxAssistantTurns: 8, maxBadToolCalls: 1, points: 2 },
            ],
          }),
        ],
      });

      emitEvalTranscript({
        status: result.status,
        evaluation,
        error: result.error,
        model: CAMEL_FREE_MODEL,
        signal,
        result: result.result,
        events: result.events,
        messages: result.messages,
        runtimeAssertions: {
          calledOracle,
          successfulOracleCall,
          oracleDetails,
          oracleDetailsHideModel,
          oracleProgress,
          oracleProgressHidesModel,
          includesMarker,
          includesProbability,
        },
      });

      assertPassFailCriteria(evaluation);
    },
    SESSION_TIMEOUT_MS + 60_000,
  );
});
