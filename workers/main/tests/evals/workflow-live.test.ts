import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createOrg, createUser, type TestEnv } from "../test-helpers";
import { emitEvalTranscript } from "./eval-transcript";
import {
  assertEvalSignal,
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
import type { WorkspaceCronDO } from "../../src/workspace-cron";

// This eval exercises the workflow tools (validate_workflow / create_workflow /
// list_workflows). Those tools live in the "workflows" category, which the lean tool
// surface (PI_LEAN_TOOLS=1) drops from the model's top-level tool list — so this eval
// also verifies the agent can still DISCOVER and use them via tools.search inside
// js_exec, the long-tail capability that had no coverage before. Authoring a valid
// WorkflowEntrypoint module is part of the test (the agent should validate first).

type WorkflowEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  WORKSPACE_CRON: DurableObjectNamespace<WorkspaceCronDO>;
  RUN_AGENT_EVALS?: string;
};

const testEnv = env as unknown as WorkflowEvalEnv;
const maybeIt = testEnv.RUN_AGENT_EVALS === "1" ? it : it.skip;

const WORKFLOW_NAME = "hourly-heartbeat";
const WORKFLOW_CRON = "0 * * * *";

describe("workflow agent eval", () => {
  maybeIt(
    "asks the agent to create a deterministic workflow and verifies it persisted",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const { userId } = await createUser(
        testEnv,
        `workflow-eval-${suffix}@example.com`,
        "password123",
        "Workflow Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Workflow Eval ${suffix}`,
        userId,
      );

      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      await configureEvalModel(testEnv, orgStub, userId);
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Workflow eval",
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
        userName: "Workflow Eval",
        userEmail: `workflow-eval-${suffix}@example.com`,
        messageSource: "eval",
        timeoutMs: getEvalTimeoutMs(testEnv, 240_000),
        message: [
          `Create a workflow for this workspace named exactly "${WORKFLOW_NAME}"`,
          `with the cron expression "${WORKFLOW_CRON}" and a short description.`,
          "The workflow source must export `class AutomationWorkflow extends WorkflowEntrypoint`",
          "and may import ONLY from `cloudflare:workers`; it can run a single step that returns the string \"ok\".",
          "Validate the source first, then create the workflow, and reply with the workflow name once it is created.",
        ].join(" "),
      });

      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          // Authoring + validating a workflow module legitimately takes a few turns,
          // and a validate/fix cycle may surface one failed call.
          maxAssistantTurns: 12,
          maxBadToolCalls: 2,
        }),
      );

      // Verify the workflow actually persisted in the workspace cron DO.
      const cronStub = testEnv.WORKSPACE_CRON.get(
        testEnv.WORKSPACE_CRON.idFromName(defaultWorkspaceId),
      );
      const workflows = await cronStub.listDeterministicAutomations(defaultWorkspaceId);
      const match = workflows.find((w) => w.name === WORKFLOW_NAME);

      emitEvalTranscript({
        status: result.status,
        error: result.error,
        model: testEnv.EVAL_MODEL,
        signal,
        result: result.result,
        events: result.events,
        messages: result.messages,
        runtimeAssertions: {
          workflowCount: workflows.length,
          createdName: match?.name ?? null,
          createdCron: match?.cron_expression ?? null,
          sourceHasEntrypoint: match
            ? match.source.includes("WorkflowEntrypoint")
            : false,
          failures: match
            ? []
            : [`no workflow named "${WORKFLOW_NAME}" was created`],
        },
      });

      expect(result.status).toBe("completed");
      assertEvalSignal(signal, testEnv);
      // The agent (in lean mode, after discovering the tool via tools.search) must
      // have persisted a workflow with the requested name and cron, and the saved
      // source must be a real WorkflowEntrypoint module.
      expect(match, `expected a workflow named "${WORKFLOW_NAME}"`).toBeTruthy();
      expect(match?.cron_expression).toBe(WORKFLOW_CRON);
      expect(match?.source ?? "").toContain("WorkflowEntrypoint");
      expect((match?.description ?? "").length).toBeGreaterThan(0);
      expect(signal.tokenUsage.totalTokens).toBeGreaterThan(0);
      expect(JSON.stringify(result.messages).toLowerCase()).not.toContain(
        "assistant error",
      );
    },
    300_000,
  );
});
