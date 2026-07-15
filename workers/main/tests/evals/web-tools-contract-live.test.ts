import { env } from "cloudflare:test";
import { describe, it } from "vitest";

import type { ChatThreadDO } from "../../src/chat-thread-do";
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
import {
  asRecord,
  asString,
  collectRuntimeEvidence,
  jsExecCodeMentionsTool,
  runtimeItemSucceeded,
} from "./project-eval-helpers";

type WebContractEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  RUN_AGENT_EVALS?: string;
};

const testEnv = env as unknown as WebContractEvalEnv;
const maybeIt = testEnv.RUN_AGENT_EVALS === "1" ? it : it.skip;
const SESSION_TIMEOUT_MS = getEvalTimeoutMs(testEnv, 240_000);
const SEARCH_MARKER = "SEARCH_ARRAY=true";
const FETCH_MARKER = "FETCH_TYPE=string";

type JsExecObservation = {
  output: string;
  value?: Record<string, unknown>;
};

function successfulJsExecObservation(
  events: Array<Record<string, unknown>>,
): JsExecObservation {
  const outputs: string[] = [];
  for (const rawEvent of events) {
    if (rawEvent.type !== "runtime_event") continue;
    const runtimeEvent = asRecord(rawEvent.event);
    if (runtimeEvent?.method !== "item/completed") continue;
    const item = asRecord(asRecord(runtimeEvent.params)?.item);
    if (!item || !runtimeItemSucceeded(item)) continue;
    const tool = asString(item.tool)?.toLowerCase();
    if (tool !== "js_exec" && !tool?.endsWith("__js_exec")) continue;
    const result = asRecord(item.result);
    const detailsText = asString(asRecord(result?.details)?.text);
    const contentText = Array.isArray(result?.content)
      ? result.content
        .map((entry) => asString(asRecord(entry)?.text))
        .find((entry): entry is string => Boolean(entry))
      : undefined;
    const output = detailsText ?? contentText ??
      (typeof item.result === "string"
        ? item.result
        : JSON.stringify(item.result));
    outputs.push(output);
    try {
      const value = asRecord(JSON.parse(output));
      if (value) return { output, value };
    } catch {
      // Keep looking: a later successful js_exec call may contain the observation.
    }
  }
  return { output: outputs.join("\n") };
}

function findCompactSearchKeys(value: unknown): string[] {
  if (Array.isArray(value)) {
    const keys = value.filter((entry): entry is string =>
      typeof entry === "string"
    );
    if (keys.includes("url")) return keys;
    for (const entry of value) {
      const nested = findCompactSearchKeys(entry);
      if (nested.length > 0) return nested;
    }
    return [];
  }
  const record = asRecord(value);
  if (!record) return [];
  for (const entry of Object.values(record)) {
    const nested = findCompactSearchKeys(entry);
    if (nested.length > 0) return nested;
  }
  return [];
}

describe("WebSearch and WebFetch js_exec contract agent eval", () => {
  maybeIt(
    "uses the compact WebSearch array and WebFetch string return values",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const email = `web-contract-eval-${suffix}@example.com`;
      const { userId } = await createUser(
        testEnv,
        email,
        "password123",
        "Web Contract Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Web Contract Eval ${suffix}`,
        userId,
      );
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      await configureEvalModel(testEnv, orgStub, userId);
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Web tools contract eval",
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
        userName: "Web Contract Eval",
        userEmail: email,
        messageSource: "eval",
        timeoutMs: SESSION_TIMEOUT_MS,
        message: [
          "Use js_exec, not the top-level web tools, to test the web helper return contract.",
          "In JavaScript call tools.WebSearch for Cloudflare Browser Run Quick Actions with 3 results.",
          "Confirm search.ok, select its first URL, then call tools.WebFetch for that URL.",
          "The JavaScript must inspect the actual values and return both literal markers",
          `${SEARCH_MARKER} when Array.isArray(search.data), and ${FETCH_MARKER}`,
          "when typeof fetched.data is string. Also return the sorted keys from the first search result.",
          "Report the observed markers and keys without guessing.",
        ].join(" "),
      });
      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          maxAssistantTurns: 6,
          maxBadToolCalls: 0,
        }),
      );
      const evidence = collectRuntimeEvidence(result.events);
      const webCode = evidence.jsExecCodeBlocks.find((code) =>
        jsExecCodeMentionsTool(code, "WebSearch") &&
        jsExecCodeMentionsTool(code, "WebFetch")
      );
      const observation = successfulJsExecObservation(result.events);
      const runtimeOutput = observation.output;
      const runtimeSawSearchArray = runtimeOutput.includes(SEARCH_MARKER) ||
        /"SEARCH_ARRAY"\s*:\s*(?:true|"true")/.test(runtimeOutput);
      const runtimeSawFetchString = runtimeOutput.includes(FETCH_MARKER) ||
        /"FETCH_TYPE"\s*:\s*"string"/.test(runtimeOutput);
      const fetchSucceeded = observation.value?.fetch_ok === true ||
        observation.value?.fetched_ok === true ||
        /"fetch(?:ed)?_ok"\s*:\s*true/.test(runtimeOutput);
      const runtimeCallsSucceeded = runtimeSawSearchArray && fetchSucceeded;
      const firstKeys = findCompactSearchKeys(observation.value);
      const runtimeSawCompactSearchItem = firstKeys.includes("url") &&
        firstKeys.every((key) => ["title", "url", "snippet"].includes(key));
      const finalResult = result.result ?? "";
      const evaluation = buildEvalCriteriaSummary({
        passFail: [
          buildSessionCompletedCriterion(result),
          passFailCriterion({
            id: "web_tools_called_in_js_exec",
            label: "A successful js_exec run called WebSearch and WebFetch",
            passed: Boolean(webCode),
            reason: webCode
              ? undefined
              : "No js_exec code block called both WebSearch and WebFetch.",
            details: { jsExecCodeBlocks: evidence.jsExecCodeBlocks },
          }),
          passFailCriterion({
            id: "compact_web_contract_observed",
            label: "Runtime observed the compact array/string return contract",
            passed: runtimeCallsSucceeded && runtimeSawSearchArray &&
              runtimeSawFetchString && runtimeSawCompactSearchItem,
            reason: runtimeCallsSucceeded && runtimeSawSearchArray &&
                runtimeSawFetchString && runtimeSawCompactSearchItem
              ? undefined
              : "Successful js_exec output did not match the compact web-tool contract.",
            details: {
              runtimeCallsSucceeded,
              runtimeSawSearchArray,
              runtimeSawFetchString,
              runtimeSawCompactSearchItem,
              firstKeys,
              runtimeOutput,
            },
          }),
          passFailCriterion({
            id: "web_contract_reported",
            label: "Final answer reported the observed return types",
            passed: finalResult.includes(SEARCH_MARKER) && finalResult.includes(FETCH_MARKER),
            reason: finalResult.includes(SEARCH_MARKER) && finalResult.includes(FETCH_MARKER)
              ? undefined
              : "Final answer did not report both observed markers.",
            details: { finalResult },
          }),
          buildNoAssistantErrorCriterion(result),
          buildRuntimeEventsCriterion(result),
          buildResultEventCriterion(result),
        ],
        scorecard: [
          scoreSignalEfficiency(signal, {
            maxPoints: 5,
            fallbackPoints: 1,
            tiers: [
              { maxAssistantTurns: 4, maxBadToolCalls: 0, points: 5 },
              { maxAssistantTurns: 6, maxBadToolCalls: 0, points: 4 },
              { maxAssistantTurns: 9, maxBadToolCalls: 1, points: 2 },
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
          webCode,
          runtimeSawSearchArray,
          runtimeSawFetchString,
          runtimeCallsSucceeded,
          runtimeSawCompactSearchItem,
          firstKeys,
          runtimeOutput,
        },
      });

      assertPassFailCriteria(evaluation);
    },
    SESSION_TIMEOUT_MS + 60_000,
  );
});
