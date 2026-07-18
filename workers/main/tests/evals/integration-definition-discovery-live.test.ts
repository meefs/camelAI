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
import { usedTool } from "./project-eval-helpers";
import type { ChatThreadDO } from "../../src/chat-thread-do";

type IntegrationDefinitionEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  RUN_AGENT_EVALS?: string;
};

const testEnv = env as unknown as IntegrationDefinitionEvalEnv;
const maybeIt = testEnv.RUN_AGENT_EVALS === "1" ? it : it.skip;
const SESSION_TIMEOUT_MS = getEvalTimeoutMs(testEnv, 150_000);
const CONNECTION_NAME = "inventory-api";
const TYPED_METHOD = "getWidget";

describe("imported integration definition discovery agent eval", () => {
  maybeIt(
    "discovers typed methods and the generic fetch fallback without calling upstream",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const { userId } = await createUser(
        testEnv,
        `integration-definition-eval-${suffix}@example.com`,
        "password123",
        "Integration Definition Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Integration Definition Eval ${suffix}`,
        userId,
      );

      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      const definitionId = crypto.randomUUID();
      const connectionId = crypto.randomUUID();
      const definition = {
        schemaVersion: 1,
        slug: "inventory-api",
        displayName: "Inventory API",
        description: "Read inventory widgets",
        surface: "openapi",
        source: "detected",
        sourceUrl: "https://inventory.example.com/openapi.json",
        baseUrl: "https://inventory.example.com/v1",
        auth: [{ kind: "none" }],
        operations: [{
          id: "getWidget",
          name: TYPED_METHOD,
          description: "Get one widget",
          method: "GET",
          path: "/widgets/{widgetId}",
          access: "read",
          inputSchema: {
            type: "object",
            properties: {
              path: {
                type: "object",
                properties: { widgetId: { type: "string" } },
                required: ["widgetId"],
              },
            },
            required: ["path"],
          },
        }],
        provenance: { kind: "detected", importedAt: Date.now() },
      };
      await orgStub.createWorkspaceIntegrationDefinition(
        defaultWorkspaceId,
        definitionId,
        definition.slug,
        JSON.stringify(definition),
        definition.source,
        definition.sourceUrl,
        userId,
      );
      await orgStub.createWorkspaceIntegration(
        defaultWorkspaceId,
        connectionId,
        "other",
        CONNECTION_NAME,
        "saas",
        "api_key",
        JSON.stringify({
          display_name: "Inventory API",
          base_url: definition.baseUrl,
          auth_type: "none",
          operation_policy: "read_only",
          restrict_to_base_origin: true,
          generic_fetch_enabled: true,
        }),
        "",
        userId,
        null,
        definitionId,
      );

      await configureEvalModel(testEnv, orgStub, userId);
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Imported connection discovery eval",
        userId,
        undefined,
        testEnv.EVAL_MODEL,
      );
      const chatThread = testEnv.CHAT_THREAD.get(testEnv.CHAT_THREAD.idFromName(thread.id));
      const result = await chatThread.runAgentEvalSession({
        threadId: thread.id,
        workspaceId: defaultWorkspaceId,
        orgId: org.id,
        userId,
        userName: "Integration Definition Eval",
        userEmail: `integration-definition-eval-${suffix}@example.com`,
        messageSource: "eval",
        timeoutMs: SESSION_TIMEOUT_MS,
        message: [
          `Inspect the workspace connection named "${CONNECTION_NAME}" and report its exact callable method names.`,
          "Do not call the upstream API. Tell me both the typed widget method and the generic HTTP fallback method.",
        ].join(" "),
      });

      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, { maxAssistantTurns: 5, maxBadToolCalls: 1 }),
      );
      const usedConnectionDiscovery =
        usedTool(result.events, "connections_find", [/env\.CONNECTIONS\.find\s*\(/]) ||
        usedTool(result.events, "connections_methods", [/env\.CONNECTIONS\.methods\s*\(/]);
      const finalReply = result.result ?? "";
      const reportedTypedMethod = finalReply.includes(TYPED_METHOD);
      const reportedGenericFallback = /\bfetch\b/.test(finalReply);
      const stored = await orgStub.getWorkspaceIntegration(defaultWorkspaceId, connectionId);
      const evaluation = buildEvalCriteriaSummary({
        passFail: [
          buildSessionCompletedCriterion(result),
          passFailCriterion({
            id: "used_connection_discovery",
            label: "Agent inspected the connection method catalog",
            passed: usedConnectionDiscovery,
            reason: usedConnectionDiscovery ? undefined : "Agent did not call env.CONNECTIONS.find() or methods().",
            details: { toolCallsByName: signal.toolCallsByName },
          }),
          passFailCriterion({
            id: "reported_typed_method",
            label: "Agent reported the imported typed method",
            passed: reportedTypedMethod,
            reason: reportedTypedMethod ? undefined : `Final reply did not include ${TYPED_METHOD}.`,
          }),
          passFailCriterion({
            id: "reported_generic_fallback",
            label: "Agent reported generic fetch fallback",
            passed: reportedGenericFallback,
            reason: reportedGenericFallback ? undefined : "Final reply did not include fetch.",
          }),
          passFailCriterion({
            id: "definition_joined",
            label: "Definition remained linked to the connection",
            passed: stored?.definition_id === definitionId && Boolean(stored.definition),
            reason: stored?.definition_id === definitionId && stored.definition
              ? undefined
              : "Stored connection did not return its joined definition payload.",
          }),
          passFailCriterion({
            id: "produced_token_usage",
            label: "Agent produced token usage",
            passed: signal.tokenUsage.totalTokens > 0,
            reason: signal.tokenUsage.totalTokens > 0 ? undefined : "Signal reported zero total tokens.",
          }),
          buildNoAssistantErrorCriterion(result),
          buildRuntimeEventsCriterion(result),
          buildResultEventCriterion(result),
        ],
        scorecard: [
          scoreSignalEfficiency(signal, {
            maxPoints: 4,
            fallbackPoints: 1,
            tiers: [
              { maxAssistantTurns: 5, maxBadToolCalls: 1, points: 4 },
              { maxAssistantTurns: 10, maxBadToolCalls: 2, points: 3 },
              { maxAssistantTurns: 15, maxBadToolCalls: 3, points: 2 },
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
        runtimeAssertions: {
          usedConnectionDiscovery,
          reportedTypedMethod,
          reportedGenericFallback,
          definitionId: stored?.definition_id ?? null,
          toolCallsByName: signal.toolCallsByName,
          failures: [
            ...(!usedConnectionDiscovery ? ["connection catalog was not inspected"] : []),
            ...(!reportedTypedMethod ? [`final reply omitted ${TYPED_METHOD}`] : []),
            ...(!reportedGenericFallback ? ["final reply omitted fetch"] : []),
          ],
        },
      });

      assertPassFailCriteria(evaluation);
    },
    SESSION_TIMEOUT_MS + 60_000,
  );
});
