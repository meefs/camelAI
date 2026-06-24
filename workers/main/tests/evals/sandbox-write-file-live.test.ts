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
import type { WorkspaceFilesystemDO } from "../../src/workspace-filesystem-do";

type SandboxWriteEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  WORKSPACE_FS: DurableObjectNamespace<WorkspaceFilesystemDO>;
  PROJECT_RUNTIME_HOST: Fetcher;
  RUN_AGENT_EVALS?: string;
};

const testEnv = env as unknown as SandboxWriteEvalEnv;
const maybeIt = testEnv.RUN_AGENT_EVALS === "1" ? it : it.skip;
const EXPECTED_FILE_CONTENT = "sandbox write eval ok.";

describe("sandbox write file agent eval", () => {
  maybeIt(
    "asks the agent to write and read back a file in the project runtime",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const { userId } = await createUser(
        testEnv,
        `sandbox-write-eval-${suffix}@example.com`,
        "password123",
        "Sandbox Write Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Sandbox Write Eval ${suffix}`,
        userId,
      );

      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      await configureEvalModel(testEnv, orgStub, userId);
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Sandbox write file eval",
        userId,
        undefined,
        testEnv.EVAL_MODEL,
      );

      const workspaceFs = testEnv.WORKSPACE_FS.get(
        testEnv.WORKSPACE_FS.idFromName(defaultWorkspaceId),
      );
      const project = await workspaceFs.createProject({
        id: "sandbox-write-app",
        name: "sandbox-write-app",
        description: "Sandbox write-file eval project.",
        workspaceId: defaultWorkspaceId,
      });

      const chatThread = testEnv.CHAT_THREAD.get(
        testEnv.CHAT_THREAD.idFromName(thread.id),
      );
      const result = await chatThread.runAgentEvalSession({
        threadId: thread.id,
        workspaceId: defaultWorkspaceId,
        orgId: org.id,
        userId,
        userName: "Sandbox Write Eval",
        userEmail: `sandbox-write-eval-${suffix}@example.com`,
        messageSource: "eval",
        timeoutMs: getEvalTimeoutMs(testEnv, 180_000),
        message: [
          "Use bash in the sandbox-write-app project to create /workspace/eval-output.txt with exactly this text: sandbox write eval ok.",
          "Then read the file back and reply with the file contents only.",
        ].join(" "),
      });
      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          maxAssistantTurns: 4,
          maxBadToolCalls: 0,
        }),
      );

      const readResponse = await testEnv.PROJECT_RUNTIME_HOST.fetch(
        `http://runtime.test/v1/projects/${encodeURIComponent(project.id)}/fs/read?path=${encodeURIComponent("/workspace/eval-output.txt")}`,
      );
      const fileContents = readResponse.ok ? await readResponse.text() : "";
      const normalizedFileContents = fileContents.trimEnd();
      const finalResult = result.result?.trim() ?? "";
      const finalResultLower = finalResult.toLowerCase();
      const finalResultExtra = finalResultLower
        .replace(EXPECTED_FILE_CONTENT, "")
        .trim();
      const transcriptText = JSON.stringify({
        result: result.result,
        events: result.events,
        messages: result.messages,
      }).toLowerCase();
      const evaluation = buildEvalCriteriaSummary({
        passFail: [
          buildSessionCompletedCriterion(result),
          passFailCriterion({
            id: "expected_file_written",
            label: "Agent wrote the expected file",
            passed: readResponse.ok,
            reason: readResponse.ok
              ? undefined
              : `Reading /workspace/eval-output.txt returned HTTP ${readResponse.status}.`,
            details: { status: readResponse.status },
          }),
          passFailCriterion({
            id: "file_contents_exact",
            label: "File contents are exactly correct",
            passed: normalizedFileContents === EXPECTED_FILE_CONTENT,
            reason:
              normalizedFileContents === EXPECTED_FILE_CONTENT
                ? undefined
                : `Expected "${EXPECTED_FILE_CONTENT}" after trailing whitespace normalization.`,
            details: { actual: normalizedFileContents },
          }),
          passFailCriterion({
            id: "final_response_includes_file_contents",
            label: "Agent final response includes the file contents",
            passed:
              finalResultLower.includes(EXPECTED_FILE_CONTENT) &&
              finalResultExtra.length <= 80,
            reason:
              finalResultLower.includes(EXPECTED_FILE_CONTENT)
                ? finalResultExtra.length <= 80
                  ? undefined
                  : "Final response included unrelated explanation beyond the requested file contents."
                : "Final response did not include the expected file contents.",
            details: { finalResult },
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
              { maxAssistantTurns: 4, maxBadToolCalls: 0, points: 4 },
              { maxAssistantTurns: 6, maxBadToolCalls: 1, points: 3 },
              { maxAssistantTurns: 10, maxBadToolCalls: 3, points: 2 },
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
        fileInspection: {
          path: "/workspace/eval-output.txt",
          readStatus: readResponse.status,
          contents: fileContents,
        },
      });

      assertPassFailCriteria(evaluation);
    },
    240_000,
  );
});
