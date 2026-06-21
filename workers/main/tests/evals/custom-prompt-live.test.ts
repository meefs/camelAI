import { env } from "cloudflare:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
import type { WorkspaceFilesystemDO } from "../../src/workspace-filesystem-do";

// Generic, env-driven eval used by the control plane to run custom prompts that are NOT
// committed to the source tree. The prompt, optional project name, and optional pass/fail
// substring assertions are supplied via env (whitelisted in vitest.workers.config.ts):
//   CUSTOM_EVAL_PROMPT            (required) the user message sent to the agent
//   CUSTOM_EVAL_PROJECT          (optional) project name to scaffold; default "custom-eval"
//   CUSTOM_EVAL_EXPECT_SUBSTRINGS (optional) JSON array of lowercase substrings that must
//                                  appear in the transcript for the eval to pass
// Model selection (EVAL_MODEL / EVAL_CUSTOM_*), signal thresholds (EVAL_MAX_* /
// EVAL_ENFORCE_SIGNAL), and real-deploy opt-in (EVAL_REAL_DEPLOY) reuse the shared harness.
type CustomEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  WORKSPACE_FS: DurableObjectNamespace<WorkspaceFilesystemDO>;
  RUN_AGENT_EVALS?: string;
  CUSTOM_EVAL_PROMPT?: string;
  CUSTOM_EVAL_PROJECT?: string;
  CUSTOM_EVAL_EXPECT_SUBSTRINGS?: string;
};

const testEnv = env as unknown as CustomEvalEnv;
const maybeIt = testEnv.RUN_AGENT_EVALS === "1" ? it : it.skip;

function persistEvalArtifact(name: string, value: unknown): void {
  try {
    const dir = path.resolve(
      process.env.EVAL_ARTIFACT_DIR ??
        path.join(os.tmpdir(), "camelai-eval-artifacts"),
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(value, null, 2));
  } catch (error) {
    console.warn(
      `Unable to persist eval artifact ${name}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function parseExpectSubstrings(raw: string | undefined): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `CUSTOM_EVAL_EXPECT_SUBSTRINGS must be a JSON array of strings: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("CUSTOM_EVAL_EXPECT_SUBSTRINGS must be a JSON array of strings");
  }
  return (parsed as string[]).map((item) => item.toLowerCase());
}

function projectId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "custom-eval";
}

describe("custom prompt agent eval", () => {
  maybeIt(
    "runs a control-plane supplied prompt and captures the transcript",
    async () => {
      const prompt = testEnv.CUSTOM_EVAL_PROMPT?.trim();
      if (!prompt) {
        // Fail loudly: a custom eval run was requested without a prompt to run.
        throw new Error(
          "CUSTOM_EVAL_PROMPT is required to run the custom-prompt-live eval",
        );
      }
      const expectSubstrings = parseExpectSubstrings(
        testEnv.CUSTOM_EVAL_EXPECT_SUBSTRINGS,
      );
      const projectName = testEnv.CUSTOM_EVAL_PROJECT?.trim() || "custom-eval";

      const suffix = crypto.randomUUID().slice(0, 8);
      const { userId } = await createUser(
        testEnv,
        `custom-eval-${suffix}@example.com`,
        "password123",
        "Custom Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Custom Eval ${suffix}`,
        userId,
      );

      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      await configureEvalModel(testEnv, orgStub, userId);
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Custom prompt eval",
        userId,
        undefined,
        testEnv.EVAL_MODEL,
      );

      const workspaceFs = testEnv.WORKSPACE_FS.get(
        testEnv.WORKSPACE_FS.idFromName(defaultWorkspaceId),
      );
      await workspaceFs.createProject({
        id: projectId(projectName),
        name: projectName,
        description: "Custom prompt eval project.",
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
        userName: "Custom Eval",
        userEmail: `custom-eval-${suffix}@example.com`,
        messageSource: "eval",
        timeoutMs: getEvalTimeoutMs(testEnv, 600_000),
        message: prompt,
      });
      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, { maxBadToolCalls: 0 }),
      );

      const payload = {
        status: result.status,
        error: result.error,
        model: testEnv.EVAL_MODEL,
        prompt,
        signal,
        deployedApps: result.deployedApps,
        result: result.result,
        events: result.events,
        messages: result.messages,
      };
      persistEvalArtifact("custom-prompt-live", payload);

      emitEvalTranscript(payload);

      const transcriptText = JSON.stringify({
        result: result.result,
        events: result.events,
        messages: result.messages,
      }).toLowerCase();

      expect(result.status).toBe("completed");
      assertEvalSignal(signal, testEnv);
      expect(transcriptText).not.toContain("assistant error");
      for (const substring of expectSubstrings) {
        expect(transcriptText).toContain(substring);
      }
      expect(result.events.some((event) => event.type === "runtime_event")).toBe(true);
      expect(result.events.some((event) => event.type === "result")).toBe(true);
    },
    660_000,
  );
});
