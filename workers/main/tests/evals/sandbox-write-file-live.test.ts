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

type SandboxWriteEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  WORKSPACE_FS: DurableObjectNamespace<WorkspaceFilesystemDO>;
  PROJECT_RUNTIME_HOST: Fetcher;
  RUN_AGENT_EVALS?: string;
};

const testEnv = env as unknown as SandboxWriteEvalEnv;
const maybeIt = testEnv.RUN_AGENT_EVALS === "1" ? it : it.skip;

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

      console.log(
        "SANDBOX_WRITE_EVAL_TRANSCRIPT_START " +
          JSON.stringify({
            status: result.status,
            error: result.error,
            model: testEnv.EVAL_MODEL,
            signal,
            result: result.result,
            events: result.events,
            messages: result.messages,
          }) +
          " SANDBOX_WRITE_EVAL_TRANSCRIPT_END",
      );

      expect(result.status).toBe("completed");
      assertEvalSignal(signal, testEnv);
      expect(result.result?.toLowerCase()).toContain("sandbox write eval ok");
      expect(signal.tokenUsage.turnCount).toBeGreaterThan(0);
      expect(signal.tokenUsage.totalTokens).toBeGreaterThan(0);
      expect(JSON.stringify(result.messages).toLowerCase()).not.toContain(
        "assistant error",
      );
      expect(result.events.some((event) => event.type === "runtime_event")).toBe(true);
      expect(result.events.some((event) => event.type === "result")).toBe(true);

      const runtime = testEnv.PROJECT_RUNTIME_HOST;
      const readResponse = await runtime.fetch(
        `http://runtime.test/v1/projects/${encodeURIComponent(project.id)}/fs/read?path=${encodeURIComponent("/workspace/eval-output.txt")}`,
      );
      expect(readResponse.ok).toBe(true);
      await expect(readResponse.text()).resolves.toContain("sandbox write eval ok");
    },
    240_000,
  );
});
