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

// This eval exercises the custom-domain tools (get_custom_domain). Those tools live in
// the "domains" category, which the lean tool surface (now the default) drops from the
// model's top-level tool list — so this eval verifies the agent can still DISCOVER and
// invoke them via tools.search inside js_exec. get_custom_domain is a workspace-level
// read (no args, no network when there are no deployed apps), so it is deterministic:
// the discriminating signal is whether the agent found and called the dropped tool.

type CustomDomainEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  RUN_AGENT_EVALS?: string;
};

const testEnv = env as unknown as CustomDomainEvalEnv;
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

describe("custom domain agent eval", () => {
  maybeIt(
    "asks the agent to report custom domain diagnostics, verifying tool discovery",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const { userId } = await createUser(
        testEnv,
        `custom-domain-eval-${suffix}@example.com`,
        "password123",
        "Custom Domain Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Custom Domain Eval ${suffix}`,
        userId,
      );

      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      await configureEvalModel(testEnv, orgStub, userId);
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Custom domain eval",
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
        userName: "Custom Domain Eval",
        userEmail: `custom-domain-eval-${suffix}@example.com`,
        messageSource: "eval",
        timeoutMs: getEvalTimeoutMs(testEnv, 150_000),
        message: [
          "Check whether any of this workspace's deployed apps have a custom domain configured,",
          "and report the custom domain diagnostics for the workspace.",
        ].join(" "),
      });

      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          maxAssistantTurns: 5,
          maxBadToolCalls: 1,
        }),
      );

      const calledGetCustomDomain = agentInvokedTool(
        "get_custom_domain",
        signal.toolCallsByName,
        result.messages,
      );

      const transcriptText = JSON.stringify({
        result: result.result,
        events: result.events,
        messages: result.messages,
      }).toLowerCase();
      const evaluation = buildEvalCriteriaSummary({
        passFail: [
          buildSessionCompletedCriterion(result),
          // The core regression check: in lean mode get_custom_domain is not a
          // top-level tool, so the agent must have discovered it via tools.search and
          // invoked it.
          passFailCriterion({
            id: "called_get_custom_domain",
            label: "Agent discovered and called get_custom_domain",
            passed: calledGetCustomDomain,
            reason: calledGetCustomDomain
              ? undefined
              : "Agent did not discover/call get_custom_domain.",
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
          calledGetCustomDomain,
          toolCallsByName: signal.toolCallsByName,
          failures: calledGetCustomDomain
            ? []
            : ["agent did not discover/call get_custom_domain"],
        },
      });

      assertPassFailCriteria(evaluation);
    },
    240_000,
  );
});
