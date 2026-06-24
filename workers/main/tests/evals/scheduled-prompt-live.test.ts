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

// This eval exercises the scheduled-prompt tools (create_scheduled_prompt /
// list_scheduled_prompts). Those tools live in the "schedules" category, which the
// lean tool surface (PI_LEAN_TOOLS=1) drops from the model's top-level tool list — so
// this eval also verifies the agent can still DISCOVER and use them via tools.search
// inside js_exec, the long-tail capability that had no coverage before.

type ScheduledPromptEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  WORKSPACE_CRON: DurableObjectNamespace<WorkspaceCronDO>;
  RUN_AGENT_EVALS?: string;
};

const testEnv = env as unknown as ScheduledPromptEvalEnv;
const maybeIt = testEnv.RUN_AGENT_EVALS === "1" ? it : it.skip;

const SCHEDULE_NAME = "daily-standup";
const SCHEDULE_CRON = "0 9 * * *";

describe("scheduled prompt agent eval", () => {
  maybeIt(
    "asks the agent to create a scheduled prompt and verifies it persisted",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const { userId } = await createUser(
        testEnv,
        `scheduled-prompt-eval-${suffix}@example.com`,
        "password123",
        "Scheduled Prompt Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Scheduled Prompt Eval ${suffix}`,
        userId,
      );

      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      await configureEvalModel(testEnv, orgStub, userId);
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Scheduled prompt eval",
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
        userName: "Scheduled Prompt Eval",
        userEmail: `scheduled-prompt-eval-${suffix}@example.com`,
        messageSource: "eval",
        timeoutMs: getEvalTimeoutMs(testEnv, 180_000),
        message: [
          `Schedule a recurring prompt for this workspace named exactly "${SCHEDULE_NAME}"`,
          `with the cron expression "${SCHEDULE_CRON}" and the prompt text`,
          `"Summarize the latest commits from yesterday.".`,
          "Once it is scheduled, reply with the schedule's name and cron expression.",
        ].join(" "),
      });

      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          maxAssistantTurns: 6,
          maxBadToolCalls: 0,
        }),
      );

      // Verify the scheduled prompt actually persisted in the workspace cron DO,
      // independent of what the agent claims in its reply.
      const cronStub = testEnv.WORKSPACE_CRON.get(
        testEnv.WORKSPACE_CRON.idFromName(defaultWorkspaceId),
      );
      const prompts = await cronStub.listScheduledPrompts(defaultWorkspaceId);
      const match = prompts.find((p) => p.name === SCHEDULE_NAME);

      emitEvalTranscript({
        status: result.status,
        error: result.error,
        model: testEnv.EVAL_MODEL,
        signal,
        result: result.result,
        events: result.events,
        messages: result.messages,
        runtimeAssertions: {
          scheduledPromptCount: prompts.length,
          createdName: match?.name ?? null,
          createdCron: match?.cron_expression ?? null,
          failures: match
            ? []
            : [`no scheduled prompt named "${SCHEDULE_NAME}" was created`],
        },
      });

      expect(result.status).toBe("completed");
      assertEvalSignal(signal, testEnv);
      // The agent (in lean mode, after discovering the tool via tools.search) must
      // have persisted a scheduled prompt with the requested name and cron.
      expect(match, `expected a scheduled prompt named "${SCHEDULE_NAME}"`).toBeTruthy();
      expect(match?.cron_expression).toBe(SCHEDULE_CRON);
      expect((match?.prompt ?? "").length).toBeGreaterThan(0);
      expect(signal.tokenUsage.totalTokens).toBeGreaterThan(0);
      expect(JSON.stringify(result.messages).toLowerCase()).not.toContain(
        "assistant error",
      );
    },
    240_000,
  );
});
