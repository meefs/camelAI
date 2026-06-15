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

type AgentEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  WORKSPACE_FS: DurableObjectNamespace<WorkspaceFilesystemDO>;
  PROJECT_RUNTIME_HOST: Fetcher;
  RUN_AGENT_EVALS?: string;
};

const testEnv = env as unknown as AgentEvalEnv;
const maybeIt = testEnv.RUN_AGENT_EVALS === "1" ? it : it.skip;

describe("agent evals with Sandbox runtime", () => {
  maybeIt(
    "runs a ChatThreadDO eval session and returns a transcript",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const { userId } = await createUser(
        testEnv,
        `agent-eval-${suffix}@example.com`,
        "password123",
        "Agent Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Agent Eval ${suffix}`,
        userId,
      );

      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      await configureEvalModel(testEnv, orgStub, userId);
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Sandbox agent eval",
        userId,
        undefined,
        testEnv.EVAL_MODEL,
      );

      const workspaceFs = testEnv.WORKSPACE_FS.get(
        testEnv.WORKSPACE_FS.idFromName(defaultWorkspaceId),
      );
      const project = await workspaceFs.createProject({
        id: "eval-app",
        name: "eval-app",
        description: "Project used by the live Sandbox agent eval.",
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
        userName: "Agent Eval",
        userEmail: `agent-eval-${suffix}@example.com`,
        messageSource: "eval",
        timeoutMs: getEvalTimeoutMs(testEnv, 180_000),
        message: [
          "Use bash in the eval-app project to create /workspace/eval-output.txt with exactly this text: sandbox agent eval ok.",
          "Then read the file back and reply with the file contents only.",
        ].join(" "),
      });
      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          maxAssistantTurns: 4,
          maxBadToolCalls: 0,
          maxSdkTurns: 4,
        }),
      );

      expect(result.status).toBe("completed");
      assertEvalSignal(signal, testEnv);
      expect(result.result?.toLowerCase()).toContain("sandbox agent eval ok");
      expect(JSON.stringify(result.messages).toLowerCase()).not.toContain(
        "assistant error",
      );
      expect(result.events.some((event) => event.type === "runtime_event")).toBe(true);
      expect(result.events.some((event) => event.type === "result")).toBe(true);
      expect(result.messages.length).toBeGreaterThan(0);

      const runtime = testEnv.PROJECT_RUNTIME_HOST;
      const readResponse = await runtime.fetch(
        `http://runtime.test/v1/projects/${encodeURIComponent(project.id)}/fs/read?path=${encodeURIComponent("/workspace/eval-output.txt")}`,
      );
      expect(readResponse.ok).toBe(true);
      await expect(readResponse.text()).resolves.toContain("sandbox agent eval ok");
    },
    240_000,
  );
});
