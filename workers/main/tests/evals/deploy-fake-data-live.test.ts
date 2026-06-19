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

      console.log(
        "DEPLOY_EVAL_TRANSCRIPT_START " +
          JSON.stringify({
            status: result.status,
            error: result.error,
            model: testEnv.EVAL_MODEL,
            signal,
            deployedApps: result.deployedApps,
            result: result.result,
            events: result.events,
            messages: result.messages,
          }) +
          " DEPLOY_EVAL_TRANSCRIPT_END",
      );

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

      // The deploy flows through the real cf-api-proxy and registers in OrgDO like a normal
      // deploy, so the app surfaces in the eval result via the standard app path with the
      // testing-grounds host — no eval-specific registry involved.
      const resultApp = result.deployedApps?.find(
        (app) => app.name === "fake-data-dashboard",
      );
      expect(resultApp).toBeDefined();
      const appUrl = resultApp?.url ?? "";
      const appHost = new URL(appUrl).host;
      expect(appHost.startsWith("fake-data-dashboard")).toBe(true);
      expect(appHost.endsWith(".evals.camelai.app")).toBe(true);

      // The whole point: the app is actually reachable. Fetch the live URL and confirm the
      // deployed worker serves a non-empty 200 response.
      const live = await fetch(appUrl, { redirect: "follow" });
      expect(live.status).toBe(200);
      const liveBody = await live.text();
      expect(liveBody.length).toBeGreaterThan(0);
    },
    660_000,
  );
});
