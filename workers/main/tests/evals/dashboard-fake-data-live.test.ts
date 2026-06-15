import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createOrg, createUser, type TestEnv } from "../test-helpers";
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
import type { WorkspaceFilesystemDO } from "../../src/workspace-filesystem-do";

type DashboardEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  WORKSPACE_FS: DurableObjectNamespace<WorkspaceFilesystemDO>;
  RUN_AGENT_EVALS?: string;
};

const testEnv = env as unknown as DashboardEvalEnv;
const maybeIt = testEnv.RUN_AGENT_EVALS === "1" ? it : it.skip;

describe("dashboard fake data agent eval", () => {
  maybeIt(
    "asks the agent to build a dashboard from fake data and prints the transcript",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const { userId } = await createUser(
        testEnv,
        `dashboard-eval-${suffix}@example.com`,
        "password123",
        "Dashboard Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Dashboard Eval ${suffix}`,
        userId,
      );

      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      await configureEvalModel(testEnv, orgStub, userId);
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Dashboard fake data eval",
        userId,
        undefined,
        testEnv.EVAL_MODEL,
      );

      const workspaceFs = testEnv.WORKSPACE_FS.get(
        testEnv.WORKSPACE_FS.idFromName(defaultWorkspaceId),
      );
      await workspaceFs.createProject({
        id: "dashboard-app",
        name: "dashboard-app",
        description: "Dashboard eval project.",
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
        userName: "Dashboard Eval",
        userEmail: `dashboard-eval-${suffix}@example.com`,
        messageSource: "eval",
        timeoutMs: getEvalTimeoutMs(testEnv, 240_000),
        message: [
          "In the dashboard-app project, create a polished static HTML dashboard using fake business data.",
          "Include at least three metric cards, a simple table, and a small chart or chart-like visualization.",
          "Write the dashboard to /workspace/index.html.",
          "Use only HTML, CSS, and vanilla JavaScript so the file can be opened directly.",
          "After creating it, verify the file exists and briefly summarize what you built.",
        ].join(" "),
      });
      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          maxAssistantTurns: 6,
          maxBadToolCalls: 0,
          maxSdkTurns: 6,
        }),
      );

      console.log(
        "DASHBOARD_EVAL_TRANSCRIPT_START " +
          JSON.stringify({
            status: result.status,
            error: result.error,
            model: testEnv.EVAL_MODEL,
            signal,
            result: result.result,
            events: result.events,
            messages: result.messages,
          }) +
          " DASHBOARD_EVAL_TRANSCRIPT_END",
      );

      expect(result.status).toBe("completed");
      assertEvalSignal(signal, testEnv);
      expect(result.result?.toLowerCase()).toContain("dashboard");
      const transcriptText = JSON.stringify({
        result: result.result,
        events: result.events,
        messages: result.messages,
      }).toLowerCase();
      expect(transcriptText).not.toContain("assistant error");
      expect(transcriptText).toContain("/workspace/index.html");
      expect(
        transcriptText.includes("successfully wrote") ||
          transcriptText.includes("file confirmed") ||
          transcriptText.includes("file exists") ||
          transcriptText.includes("-rw-r--r--"),
      ).toBe(true);
      expect(result.events.some((event) => event.type === "runtime_event")).toBe(true);
      expect(result.events.some((event) => event.type === "result")).toBe(true);
    },
    300_000,
  );
});
