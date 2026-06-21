import { env } from "cloudflare:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
import { isRealEvalDeployEnabled } from "../../src/eval-deploy-context";
import {
  assertDeployedApp,
  assertDeployedAppLive,
  countWorkspaceApps,
} from "./eval-deploy-assert";
import { emitEvalTranscript } from "./eval-transcript";
import type { ChatThreadDO } from "../../src/chat-thread-do";
import type { WorkspaceFilesystemDO } from "../../src/workspace-filesystem-do";

type DeployEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  APP_DB?: D1Database;
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  WORKSPACE_FS: DurableObjectNamespace<WorkspaceFilesystemDO>;
  RUN_AGENT_EVALS?: string;
  EVAL_REAL_DEPLOY?: string;
  CF_API_TOKEN?: string;
};

const testEnv = env as unknown as DeployEvalEnv;
// Real deploy is required for this eval (it publishes to the testing-grounds namespace and
// fetches the live URL). Skips when not an agent eval run, real deploy is disabled, or no
// CF_API_TOKEN is available.
const maybeIt = isRealEvalDeployEnabled(testEnv) ? it : it.skip;

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

describe("deploy fake data agent eval", () => {
  maybeIt(
    "asks the agent to scaffold from the bundled template and deploy with wrangler",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const { userId } = await createUser(
        testEnv,
        `deploy-eval-${suffix}@example.com`,
        "password123",
        "Deploy Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Deploy Eval ${suffix}`,
        userId,
      );

      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      await configureEvalModel(testEnv, orgStub, userId);
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Deploy fake data eval",
        userId,
        undefined,
        testEnv.EVAL_MODEL,
      );

      const workspaceFs = testEnv.WORKSPACE_FS.get(
        testEnv.WORKSPACE_FS.idFromName(defaultWorkspaceId),
      );
      await workspaceFs.createProject({
        id: "deploy-fake-data",
        name: "deploy-fake-data",
        description: "Deploy eval project.",
        workspaceId: defaultWorkspaceId,
      });

      const chatThread = testEnv.CHAT_THREAD.get(
        testEnv.CHAT_THREAD.idFromName(thread.id),
      );
      // Snapshot the workspace's app count so we can assert the eval actually deployed one.
      const appsBefore = await countWorkspaceApps(orgStub, defaultWorkspaceId);
      const result = await chatThread.runAgentEvalSession({
        threadId: thread.id,
        workspaceId: defaultWorkspaceId,
        orgId: org.id,
        userId,
        userName: "Deploy Eval",
        userEmail: `deploy-eval-${suffix}@example.com`,
        messageSource: "eval",
        timeoutMs: getEvalTimeoutMs(testEnv, 600_000),
        message: [
          "In the deploy-fake-data project, use the bundled create-worker command to scaffold a Cloudflare Worker app named fake-data-dashboard.",
          "Customize the generated app into a polished fake-data dashboard or operations app using believable sample business data.",
          "Then run the generated app's exact deploy script with bun run deploy so it exercises wrangler deploy from the template.",
          "This eval runtime injects CLOUDFLARE_API_BASE_URL and CLOUDFLARE_API_TOKEN, so do not ask for login or real Cloudflare credentials.",
          "After deploying, call list_apps and verify fake-data-dashboard appears, then call set_preview for fake-data-dashboard.",
          "Summarize the deploy result and list_apps/set_preview result.",
        ].join(" "),
      });
      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          maxAssistantTurns: 14,
          maxBadToolCalls: 0,
        }),
      );
      persistEvalArtifact("deploy-fake-data-live", {
        status: result.status,
        error: result.error,
        model: testEnv.EVAL_MODEL,
        signal,
        deployedApps: result.deployedApps,
        result: result.result,
        events: result.events,
        messages: result.messages,
      });

      emitEvalTranscript({
        status: result.status,
        error: result.error,
        model: testEnv.EVAL_MODEL,
        signal,
        deployedApps: result.deployedApps,
        result: result.result,
        events: result.events,
        messages: result.messages,
      });

      const transcriptText = JSON.stringify({
        result: result.result,
        events: result.events,
        messages: result.messages,
      }).toLowerCase();

      expect(result.status).toBe("completed");
      assertEvalSignal(signal, testEnv);
      expect(transcriptText).not.toContain("assistant error");
      expect(transcriptText).toContain("deploy");
      expect(transcriptText).toContain("list_apps");
      expect(transcriptText).toContain("set_preview");
      expect(transcriptText).toContain("fake-data-dashboard");
      expect(transcriptText).toContain("evals.camelai.app");
      expect(result.events.some((event) => event.type === "runtime_event")).toBe(true);
      expect(result.events.some((event) => event.type === "result")).toBe(true);

      // The eval must actually create an app: the workspace had `appsBefore` registered apps
      // before the run and must have exactly one more now. This is name-agnostic (doesn't depend
      // on what the agent named the app) and fails loudly if the agent never deployed.
      expect(await countWorkspaceApps(orgStub, defaultWorkspaceId)).toBe(appsBefore + 1);

      // The deploy flows through the real cf-api-proxy and registers in OrgDO like a normal deploy,
      // so the app surfaces in result.deployedApps with the testing-grounds host. Confirm it is
      // actually reachable: fetch the live URL and require a non-empty 200.
      const deployedApp = assertDeployedApp(result, { hostSuffix: ".evals.camelai.app" });
      await assertDeployedAppLive(deployedApp);
    },
    660_000,
  );
});
