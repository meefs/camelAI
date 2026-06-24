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

// This eval exercises the integration tools (create_integration / list_integrations).
// Those tools live in the "integrations" category, which the lean tool surface
// (PI_LEAN_TOOLS=1) drops from the model's top-level tool list — so this eval verifies
// the agent can still DISCOVER and use them via tools.search inside js_exec. A
// remote_mcp integration is created without any network call, so the assertion is
// deterministic: the integration must actually persist on the workspace.

type IntegrationEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  RUN_AGENT_EVALS?: string;
};

const testEnv = env as unknown as IntegrationEvalEnv;
const maybeIt = testEnv.RUN_AGENT_EVALS === "1" ? it : it.skip;

const INTEGRATION_NAME = "docs-mcp";
const INTEGRATION_TYPE = "remote_mcp";
const SERVER_URL = "https://mcp.example.com/sse";

describe("integration create agent eval", () => {
  maybeIt(
    "asks the agent to add a remote MCP integration and verifies it persisted",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const { userId } = await createUser(
        testEnv,
        `integration-eval-${suffix}@example.com`,
        "password123",
        "Integration Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Integration Eval ${suffix}`,
        userId,
      );

      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      await configureEvalModel(testEnv, orgStub, userId);
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Integration create eval",
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
        userName: "Integration Eval",
        userEmail: `integration-eval-${suffix}@example.com`,
        messageSource: "eval",
        timeoutMs: getEvalTimeoutMs(testEnv, 180_000),
        message: [
          "Add a remote MCP server integration to this workspace directly — do NOT prompt me to set it up interactively.",
          `Use integration type "${INTEGRATION_TYPE}", name it exactly "${INTEGRATION_NAME}",`,
          `set its server URL to "${SERVER_URL}" and auth type "none".`,
          "Reply with the integration name once it is created.",
        ].join(" "),
      });

      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          maxAssistantTurns: 6,
          maxBadToolCalls: 1,
        }),
      );

      // Verify the integration actually persisted on the workspace, independent of
      // the agent's reply.
      const integrations = await orgStub.getWorkspaceIntegrations(defaultWorkspaceId);
      const match = integrations.find(
        (i) => i.name === INTEGRATION_NAME && i.integration_type === INTEGRATION_TYPE,
      );

      emitEvalTranscript({
        status: result.status,
        error: result.error,
        model: testEnv.EVAL_MODEL,
        signal,
        result: result.result,
        events: result.events,
        messages: result.messages,
        runtimeAssertions: {
          integrationCount: integrations.length,
          createdName: match?.name ?? null,
          createdType: match?.integration_type ?? null,
          toolCallsByName: signal.toolCallsByName,
          failures: match
            ? []
            : [`no ${INTEGRATION_TYPE} integration named "${INTEGRATION_NAME}" was created`],
        },
      });

      expect(result.status).toBe("completed");
      assertEvalSignal(signal, testEnv);
      expect(match, `expected a ${INTEGRATION_TYPE} integration named "${INTEGRATION_NAME}"`).toBeTruthy();
      expect(match?.integration_type).toBe(INTEGRATION_TYPE);
      expect(signal.tokenUsage.totalTokens).toBeGreaterThan(0);
      expect(JSON.stringify(result.messages).toLowerCase()).not.toContain(
        "assistant error",
      );
    },
    240_000,
  );
});
