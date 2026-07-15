import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

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
import { usedTool } from "./project-eval-helpers";

type OracleTrivialEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  RUN_AGENT_EVALS?: string;
};

const testEnv = env as unknown as OracleTrivialEvalEnv;
const maybeIt = testEnv.RUN_AGENT_EVALS === "1" ? it : it.skip;
const SESSION_TIMEOUT_MS = getEvalTimeoutMs(testEnv, 120_000);
const CAMEL_FREE_MODEL = "deepseek-v4-auto";

describe("Camel Free Oracle restraint eval", () => {
  maybeIt(
    "answers a trivial question without Oracle",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const email = `oracle-trivial-${suffix}@example.com`;
      const { userId } = await createUser(testEnv, email, "password123", "Oracle Restraint Eval");
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Oracle Restraint Eval ${suffix}`,
        userId,
        { billingPlan: "free" },
      );
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Camel Free Oracle restraint eval",
        userId,
        undefined,
        CAMEL_FREE_MODEL,
      );
      const chatThread = testEnv.CHAT_THREAD.get(testEnv.CHAT_THREAD.idFromName(thread.id));
      const result = await chatThread.runAgentEvalSession({
        threadId: thread.id,
        workspaceId: defaultWorkspaceId,
        orgId: org.id,
        userId,
        userName: "Oracle Restraint Eval",
        userEmail: email,
        messageSource: "eval",
        timeoutMs: SESSION_TIMEOUT_MS,
        message: "What is 12 multiplied by 7? Answer with only the number.",
      });

      const calledOracle = usedTool(result.events, "Oracle");
      const answeredCorrectly = (result.result ?? "").trim() === "84";
      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          maxAssistantTurns: 2,
          maxBadToolCalls: 0,
        }),
      );
      const evaluation = buildEvalCriteriaSummary({
        passFail: [
          buildSessionCompletedCriterion(result),
          passFailCriterion({
            id: "oracle_not_used_for_trivial_question",
            label: "Camel Free reserved Oracle for work that warrants it",
            passed: !calledOracle,
            reason: calledOracle ? "Oracle was unnecessarily called for trivial arithmetic." : undefined,
          }),
          passFailCriterion({
            id: "trivial_answer_correct",
            label: "Camel Free answered the trivial question correctly",
            passed: answeredCorrectly,
            reason: answeredCorrectly ? undefined : `Unexpected answer: ${result.result ?? ""}`,
          }),
          buildNoAssistantErrorCriterion(result),
          buildRuntimeEventsCriterion(result),
          buildResultEventCriterion(result),
        ],
        scorecard: [
          scoreSignalEfficiency(signal, {
            maxPoints: 2,
            fallbackPoints: 0,
            tiers: [
              { maxAssistantTurns: 1, maxBadToolCalls: 0, points: 2 },
              { maxAssistantTurns: 2, maxBadToolCalls: 0, points: 1 },
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
        runtimeAssertions: { calledOracle, answeredCorrectly },
      });

      assertPassFailCriteria(evaluation);
      expect(calledOracle).toBe(false);
    },
    SESSION_TIMEOUT_MS + 60_000,
  );
});
