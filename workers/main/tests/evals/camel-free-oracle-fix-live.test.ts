import { env } from "cloudflare:test";
import { describe, it } from "vitest";

import type { ChatThreadDO } from "../../src/chat-thread-do";
import {
  ProjectFilesystemClient,
  type WorkspaceFilesystemDO,
} from "../../src/workspace-filesystem-do";
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
  capabilityChildUsedTools,
  toolCallReferences,
  usedTool,
} from "./project-eval-helpers";

type OracleFixEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  WORKSPACE_FS: DurableObjectNamespace<WorkspaceFilesystemDO>;
  RUN_AGENT_EVALS?: string;
};

const testEnv = env as unknown as OracleFixEvalEnv;
const maybeIt = testEnv.RUN_AGENT_EVALS === "1" ? it : it.skip;
const SESSION_TIMEOUT_MS = getEvalTimeoutMs(testEnv, 300_000);
const CAMEL_CODE_MODEL = "deepseek-v4-auto";
const FIX_MARKER = "ORACLE_FIXED_HALF_OFF";
const PROOF = "Oracle directly repaired the discount implementation.";

describe("camelCode Oracle direct-fix agent eval", () => {
  maybeIt(
    "delegates a blocked implementation issue for Oracle to repair directly",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const projectName = `oracle-fix-${suffix}`;
      const email = `oracle-fix-${suffix}@example.com`;
      const { userId } = await createUser(
        testEnv,
        email,
        "password123",
        "Oracle Fix Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Oracle Fix Eval ${suffix}`,
        userId,
        { billingPlan: "free" },
      );
      const workspaceFs = testEnv.WORKSPACE_FS.get(
        testEnv.WORKSPACE_FS.idFromName(defaultWorkspaceId),
      );
      const project = await workspaceFs.createProject({
        name: projectName,
        description: "Seeded discount bug for Oracle to repair.",
        workspaceId: defaultWorkspaceId,
        backend: "do-r2",
      });
      const files = new ProjectFilesystemClient(testEnv, project.id);
      await files.writeFile(
        "/discount.ts",
        [
          "export function applyHalfOff(subtotal: number, coupon: string): number {",
          '  if (coupon === "HALF") {',
          "    return subtotal * 0.75;",
          "  }",
          "  return subtotal;",
          "}",
          "",
        ].join("\n"),
      );

      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Oracle direct fix eval",
        userId,
        undefined,
        CAMEL_CODE_MODEL,
      );
      const chatThread = testEnv.CHAT_THREAD.get(
        testEnv.CHAT_THREAD.idFromName(thread.id),
      );
      const result = await chatThread.runAgentEvalSession({
        threadId: thread.id,
        workspaceId: defaultWorkspaceId,
        orgId: org.id,
        userId,
        userName: "Oracle Fix Eval",
        userEmail: email,
        messageSource: "eval",
        timeoutMs: SESSION_TIMEOUT_MS,
        message: [
          `You have already made two unsuccessful attempts at a bug in the existing project "${projectName}" and are now stuck.`,
          "Get unstuck and complete the repair, but do not edit or write project files yourself.",
          `Inspect /discount.ts, change the HALF path to return exactly subtotal * 0.5, add the comment // ${FIX_MARKER} immediately above that return, and verify the result.`,
          `Also create /oracle-fix-proof.txt containing exactly: ${PROOF}`,
          "After the repair finishes, report whether it was completed directly.",
        ].join(" "),
      });

      const discountRead = await files.readFile("/discount.ts");
      const proofRead = await files.readFile("/oracle-fix-proof.txt");
      const discount = discountRead.content ?? "";
      const proof = (proofRead.content ?? "").trim();
      const calledOracle = usedTool(result.events, "Oracle");
      const delegatedSpecificTask =
        toolCallReferences(result.events, "Oracle", projectName) &&
        toolCallReferences(result.events, "Oracle", FIX_MARKER);
      const childToolsUsed = capabilityChildUsedTools(result.events, "Oracle");
      const oraclePerformedMutations = childToolsUsed.includes("edit") ||
        childToolsUsed.includes("write");
      const mainAgentAvoidedMutations = !usedTool(result.events, "edit") &&
        !usedTool(result.events, "write");
      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          maxAssistantTurns: 5,
          maxBadToolCalls: 0,
        }),
      );
      const fixedImplementation = discount.includes(FIX_MARKER) &&
        /return\s+subtotal\s*\*\s*0\.5\s*;/.test(discount) &&
        !discount.includes("subtotal * 0.75");
      const evaluation = buildEvalCriteriaSummary({
        passFail: [
          buildSessionCompletedCriterion(result),
          passFailCriterion({
            id: "oracle_received_fix_task",
            label: "Stuck main agent selected Oracle and delegated the concrete repair",
            passed: calledOracle && delegatedSpecificTask,
            reason: calledOracle && delegatedSpecificTask
              ? undefined
              : "Oracle was not called with the seeded project and repair marker.",
          }),
          passFailCriterion({
            id: "oracle_performed_fix_mutations",
            label: "Oracle—not the main agent—performed the file mutations",
            passed: oraclePerformedMutations && mainAgentAvoidedMutations,
            reason: oraclePerformedMutations && mainAgentAvoidedMutations
              ? undefined
              : `Oracle child tools: ${childToolsUsed.join(", ") || "none"}.`,
            details: { childToolsUsed, mainAgentAvoidedMutations },
          }),
          passFailCriterion({
            id: "oracle_fixed_implementation",
            label: "Oracle directly repaired the seeded implementation",
            passed: discountRead.success && fixedImplementation,
            reason: discountRead.success && fixedImplementation
              ? undefined
              : discountRead.error ?? "The expected implementation change was absent.",
            details: { discount },
          }),
          passFailCriterion({
            id: "oracle_wrote_fix_proof",
            label: "Oracle wrote the requested proof artifact",
            passed: proofRead.success && proof === PROOF,
            reason: proofRead.success && proof === PROOF
              ? undefined
              : proofRead.error ?? `Unexpected proof content: ${proof}`,
            details: { proof },
          }),
          buildNoAssistantErrorCriterion(result),
          buildRuntimeEventsCriterion(result),
          buildResultEventCriterion(result),
        ],
        scorecard: [
          scoreSignalEfficiency(signal, {
            maxPoints: 8,
            fallbackPoints: 2,
            tiers: [
              { maxAssistantTurns: 3, maxBadToolCalls: 0, points: 8 },
              { maxAssistantTurns: 5, maxBadToolCalls: 0, points: 6 },
              { maxAssistantTurns: 8, maxBadToolCalls: 1, points: 4 },
            ],
          }),
        ],
      });

      emitEvalTranscript({
        status: result.status,
        evaluation,
        error: result.error,
        model: CAMEL_CODE_MODEL,
        signal,
        result: result.result,
        events: result.events,
        messages: result.messages,
        runtimeAssertions: {
          calledOracle,
          delegatedSpecificTask,
          childToolsUsed,
          oraclePerformedMutations,
          mainAgentAvoidedMutations,
          fixedImplementation,
          proofMatches: proof === PROOF,
        },
      });

      assertPassFailCriteria(evaluation);
    },
    SESSION_TIMEOUT_MS + 60_000,
  );
});
