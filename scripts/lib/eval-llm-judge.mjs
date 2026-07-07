import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_GATEWAY_ORIGIN = "https://gateway.ai.cloudflare.com";
const DEFAULT_JUDGE_GATEWAY_PROVIDER = "compat";
const DEFAULT_JUDGE_MODEL = "openai/gpt-5.5";
const DEFAULT_JUDGE_REASONING_EFFORT = "high";
const DEFAULT_MAX_TOKENS = 1400;
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_STRING_LENGTH = 4000;
const MAX_ARRAY_ITEMS = 24;
const MAX_OBJECT_KEYS = 60;
const MAX_DEPTH = 6;
const MAX_TRAJECTORY_ITEMS = 90;

const DEV_VAR_ALLOWLIST = new Set([
  "AI_GATEWAY_AUTH_TOKEN",
  "CF_ACCESS_CLIENT_ID",
  "CF_ACCESS_CLIENT_SECRET",
  "CF_ACCOUNT_ID",
  "CF_API_TOKEN",
  "CF_GATEWAY_BASE_URL",
  "CF_GATEWAY_NAME",
  "CF_GATEWAY_TOKEN",
  "EVAL_JUDGE_GATEWAY_PROVIDER",
  "EVAL_JUDGE_MAX_ATTEMPTS",
  "EVAL_JUDGE_MAX_TOKENS",
  "EVAL_JUDGE_MODEL",
  "EVAL_JUDGE_REASONING_EFFORT",
  "EVAL_JUDGE_TIMEOUT_MS",
  "EVAL_LLM_JUDGE",
]);

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function excerpt(value, maxLength = MAX_STRING_LENGTH) {
  const text = String(value ?? "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...[truncated ${text.length - maxLength} chars]`;
}

function safeJsonStringify(value) {
  const seen = new WeakSet();
  return JSON.stringify(value, (key, item) => {
    if (typeof item === "bigint") return item.toString();
    if (item && typeof item === "object") {
      if (seen.has(item)) return "[circular]";
      seen.add(item);
    }
    return item;
  });
}

function compactValue(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return excerpt(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return excerpt(String(value));
  if (depth >= MAX_DEPTH) return `[${Array.isArray(value) ? "array" : "object"} omitted at depth]`;

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => compactValue(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) {
      items.push({ omittedItems: value.length - MAX_ARRAY_ITEMS });
    }
    return items;
  }

  const entries = Object.entries(value).slice(0, MAX_OBJECT_KEYS);
  const compact = {};
  for (const [key, item] of entries) {
    compact[key] = compactValue(item, depth + 1);
  }
  const omittedKeys = Object.keys(value).length - entries.length;
  if (omittedKeys > 0) compact.__omittedKeys = omittedKeys;
  return compact;
}

function parseMaybeQuotedValue(value) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
    if (quote === '"') {
      try {
        return JSON.parse(trimmed);
      } catch {
        return trimmed.slice(1, -1);
      }
    }
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseDevVars(text) {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    env[key] = parseMaybeQuotedValue(trimmed.slice(separator + 1));
  }
  return env;
}

function filterEvalDevVars(env) {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => DEV_VAR_ALLOWLIST.has(key)),
  );
}

function loadDevVars(env) {
  const explicitPath = env.CHIRIDION_DEV_VARS_PATH || env.EVAL_DEV_VARS_PATH;
  const candidates = [explicitPath, ".dev.vars"].filter(Boolean);
  for (const candidate of candidates) {
    const filePath = path.resolve(candidate);
    if (!existsSync(filePath)) continue;
    return filterEvalDevVars(parseDevVars(readFileSync(filePath, "utf8")));
  }
  return {};
}

export function withLoadedEvalEnv(env) {
  const devVars = loadDevVars(env);
  return { ...devVars, ...env };
}

function flagDisabled(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "off" || normalized === "no";
}

function resolveGatewayOrigin(env) {
  const replay = env.TEST_LLM_REPLAY_URL?.trim().replace(/\/+$/, "");
  if (replay) return replay;
  const override = env.CF_GATEWAY_BASE_URL?.trim().replace(/\/+$/, "");
  if (!override) return DEFAULT_GATEWAY_ORIGIN;
  return override.startsWith("http://") ? `https://${override.slice("http://".length)}` : override;
}

function resolveJudgeConfig(env) {
  if (flagDisabled(env.EVAL_LLM_JUDGE)) {
    return { skipped: true, reason: "EVAL_LLM_JUDGE disabled" };
  }

  const replay = env.TEST_LLM_REPLAY_URL?.trim() ? "replay" : undefined;
  const accountId = env.CF_ACCOUNT_ID?.trim() || replay;
  const gatewayId = env.CF_GATEWAY_NAME?.trim() || replay;
  const authToken = env.AI_GATEWAY_AUTH_TOKEN?.trim() || env.CF_GATEWAY_TOKEN?.trim() || replay;
  if (!accountId || !gatewayId || !authToken) {
    return {
      skipped: true,
      reason: "Cloudflare AI Gateway credentials were not available to the eval runner",
    };
  }

  const maxTokens = Number(env.EVAL_JUDGE_MAX_TOKENS ?? DEFAULT_MAX_TOKENS);
  const timeoutMs = Number(env.EVAL_JUDGE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const maxAttempts = Number(env.EVAL_JUDGE_MAX_ATTEMPTS ?? DEFAULT_MAX_ATTEMPTS);
  return {
    skipped: false,
    accountId,
    gatewayId,
    authToken,
    origin: resolveGatewayOrigin(env),
    gatewayProvider: env.EVAL_JUDGE_GATEWAY_PROVIDER?.trim() || DEFAULT_JUDGE_GATEWAY_PROVIDER,
    model: env.EVAL_JUDGE_MODEL?.trim() || DEFAULT_JUDGE_MODEL,
    reasoningEffort: env.EVAL_JUDGE_REASONING_EFFORT?.trim() || DEFAULT_JUDGE_REASONING_EFFORT,
    maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : DEFAULT_MAX_TOKENS,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : DEFAULT_TIMEOUT_MS,
    maxAttempts: Number.isFinite(maxAttempts) && maxAttempts > 0
      ? Math.floor(maxAttempts)
      : DEFAULT_MAX_ATTEMPTS,
  };
}

function summarizeMessages(messages) {
  if (!Array.isArray(messages)) return undefined;
  return messages.slice(-10).map((message) => {
    const role = isObject(message) && typeof message.role === "string" ? message.role : undefined;
    const content = isObject(message) ? message.content ?? message.parts ?? message : message;
    return {
      ...(role ? { role } : {}),
      content: excerpt(safeJsonStringify(content) ?? String(content), 2500),
    };
  });
}

function incrementCount(record, key) {
  if (!key) return;
  record[key] = (record[key] ?? 0) + 1;
}

function summarizeEvents(events) {
  if (!Array.isArray(events)) return undefined;
  const eventTypes = {};
  const runtimeMethods = {};
  const toolNames = {};
  const errorExcerpts = [];

  for (const event of events) {
    const record = isObject(event) ? event : undefined;
    const type = typeof record?.type === "string" ? record.type : undefined;
    incrementCount(eventTypes, type ?? "unknown");
    const runtimeEvent = isObject(record?.event) ? record.event : undefined;
    if (typeof runtimeEvent?.method === "string") incrementCount(runtimeMethods, runtimeEvent.method);

    const text = safeJsonStringify(event) ?? "";
    const toolMatch = text.match(/"(?:tool|name)"\s*:\s*"([A-Za-z0-9_.-]+)"/);
    if (toolMatch) incrementCount(toolNames, toolMatch[1]);
    if (/error|failed|exception/i.test(text) && errorExcerpts.length < 12) {
      errorExcerpts.push(excerpt(text, 900));
    }
  }

  return {
    eventCount: events.length,
    eventTypes,
    runtimeMethods,
    toolNames,
    errorExcerpts,
  };
}

function compactCriterionAnchor(criterion, kind) {
  if (!isObject(criterion)) return undefined;
  const id = typeof criterion.id === "string" ? criterion.id : undefined;
  const label = typeof criterion.label === "string" ? criterion.label : undefined;
  if (!id && !label) return undefined;
  return {
    kind,
    ...(id ? { id } : {}),
    ...(label ? { label } : {}),
    ...(typeof criterion.maxPoints === "number" ? { maxPoints: criterion.maxPoints } : {}),
  };
}

function buildRubricAnchors(evaluation) {
  const passFail = Array.isArray(evaluation?.passFail?.criteria)
    ? evaluation.passFail.criteria
    : [];
  const scorecard = Array.isArray(evaluation?.scorecard?.criteria)
    ? evaluation.scorecard.criteria
    : [];
  return {
    passFail: passFail
      .map((criterion) => compactCriterionAnchor(criterion, "pass_fail"))
      .filter(Boolean),
    scorecard: scorecard
      .map((criterion) => compactCriterionAnchor(criterion, "scorecard"))
      .filter(Boolean),
    scorecardMaxPoints: typeof evaluation?.scorecard?.maxPoints === "number"
      ? evaluation.scorecard.maxPoints
      : undefined,
  };
}

function deterministicSummary(evaluation) {
  const passFail = isObject(evaluation?.passFail) ? evaluation.passFail : {};
  const scorecard = isObject(evaluation?.scorecard) ? evaluation.scorecard : {};
  const failedCriteria = Array.isArray(passFail.criteria)
    ? passFail.criteria
      .filter((criterion) => isObject(criterion) && criterion.status === "failed")
      .map((criterion) => ({
        id: typeof criterion.id === "string" ? criterion.id : undefined,
        label: typeof criterion.label === "string" ? criterion.label : undefined,
      }))
      .filter((criterion) => criterion.id || criterion.label)
    : [];
  return {
    passed: typeof passFail.passed === "boolean" ? passFail.passed : undefined,
    failedCount: typeof passFail.failed === "number" ? passFail.failed : undefined,
    totalPassFail: typeof passFail.total === "number" ? passFail.total : undefined,
    failedCriteria,
    scorePoints: typeof scorecard.points === "number" ? scorecard.points : undefined,
    scoreMaxPoints: typeof scorecard.maxPoints === "number" ? scorecard.maxPoints : undefined,
    scorePercentage: typeof scorecard.percentage === "number" ? scorecard.percentage : undefined,
  };
}

function compactUsage(value) {
  const usage = isObject(value) ? value : undefined;
  if (!usage) return undefined;
  return compactValue({
    input: usage.input ?? usage.input_tokens ?? usage.inputTokens,
    output: usage.output ?? usage.output_tokens ?? usage.outputTokens,
    cacheRead: usage.cacheRead ?? usage.cache_read_input_tokens ?? usage.cacheReadInputTokens,
    cacheWrite: usage.cacheWrite ?? usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens,
    totalTokens: usage.totalTokens ?? usage.total_tokens,
    cost: usage.cost,
  }, 1);
}

function summarizeRuntimeItem(item) {
  if (!isObject(item)) return undefined;
  const result = isObject(item.result) ? item.result : undefined;
  const details = isObject(result?.details) ? result.details : undefined;
  const output = typeof item.aggregatedOutput === "string"
    ? item.aggregatedOutput
    : typeof details?.text === "string"
      ? details.text
      : result?.content !== undefined
        ? safeJsonStringify(result.content)
        : undefined;
  return {
    id: typeof item.id === "string" ? item.id : undefined,
    type: typeof item.type === "string" ? item.type : undefined,
    tool: typeof item.tool === "string"
      ? item.tool
      : item.type === "commandExecution"
        ? "bash"
        : undefined,
    status: typeof item.status === "string" ? item.status : undefined,
    arguments: compactValue(item.arguments),
    command: typeof item.command === "string" ? excerpt(item.command, 1600) : undefined,
    output: output ? excerpt(output, 2200) : undefined,
    success: typeof details?.success === "boolean" ? details.success : undefined,
    exitCode: typeof details?.exitCode === "number" ? details.exitCode : undefined,
    source: typeof details?.source === "string" ? details.source : undefined,
  };
}

function truncateMiddle(items, maxItems) {
  if (items.length <= maxItems) return { items, omittedItems: 0 };
  const headCount = Math.floor(maxItems / 3);
  const tailCount = maxItems - headCount;
  return {
    items: [
      ...items.slice(0, headCount),
      { kind: "omitted", omittedItems: items.length - maxItems },
      ...items.slice(items.length - tailCount),
    ],
    omittedItems: items.length - maxItems,
  };
}

function summarizeTrajectory(events) {
  if (!Array.isArray(events)) return undefined;
  const items = [];
  events.forEach((event, index) => {
    const record = isObject(event) ? event : undefined;
    if (record?.type !== "runtime_event") return;
    const runtimeEvent = isObject(record.event) ? record.event : undefined;
    const method = typeof runtimeEvent?.method === "string" ? runtimeEvent.method : undefined;
    const params = isObject(runtimeEvent?.params) ? runtimeEvent.params : {};
    if (method === "item/completed") {
      const item = summarizeRuntimeItem(params.item);
      if (item) items.push({ index, kind: "tool_completed", ...item });
      return;
    }
    if (method === "sdk/turn/started" || method === "sdk/turn/completed") {
      items.push({
        index,
        kind: method,
        sdkTurnIndex: params.sdkTurnIndex,
        durationMs: params.durationMs,
        provider: params.provider,
        usage: compactUsage(params.usage),
      });
      return;
    }
    if (method === "turn/completed") {
      items.push({
        index,
        kind: "turn_completed",
        durationMs: params.turnDurationMs,
        sdkTurnCount: params.sdkTurnCount,
        usage: compactUsage(params.usage),
      });
    }
  });
  const truncated = truncateMiddle(items, MAX_TRAJECTORY_ITEMS);
  return {
    eventCount: events.length,
    itemCount: items.length,
    omittedItems: truncated.omittedItems,
    items: truncated.items,
  };
}

function buildJudgeInput(transcript, context) {
  const topLevel = {};
  for (const [key, value] of Object.entries(transcript)) {
    if (key === "events" || key === "messages" || key === "llmJudge" || key === "evaluation" || key === "model") continue;
    topLevel[key] = compactValue(value);
  }
  return {
    evalName: context.evalName,
    generatedAt: new Date().toISOString(),
    blindReview: {
      hiddenFromJudge: [
        "deterministic pass/fail statuses",
        "deterministic scorecard points",
        "target model identity",
      ],
    },
    rubricAnchors: buildRubricAnchors(transcript.evaluation),
    artifacts: topLevel,
    messages: summarizeMessages(transcript.messages),
    trajectory: summarizeTrajectory(transcript.events),
    eventSummary: summarizeEvents(transcript.events),
  };
}

function judgeSystemPrompt() {
  return [
    "You are an independent advisory LLM judge for camelAI agent evals.",
    "You are intentionally blind to deterministic pass/fail statuses, deterministic score points, and target model identity. Infer the outcome from the rubric anchors, artifacts, structured trajectory, signal summary, runtime assertions, and smoke-check evidence you are given.",
    "The caller will compare your independent outcome to deterministic pass/fail after you respond. Do not claim to know deterministic pass/fail.",
    "Use high standards: identify trajectory quality, tool misuse, efficiency, verification quality, artifact quality, hidden risks, likely root causes, and concrete follow-ups.",
    "Score each dimension from 0 to 5 with 5 meaning strong eval evidence, not just a successful final answer. Efficiency should reward fewer SDK/assistant turns and clean tool use. ScoreDiscrimination should reward artifacts/evidence that clearly separate strong and weak agent behavior.",
    "Do not include secrets, tokens, request headers, or long transcript excerpts.",
    "Return strict JSON only, with this shape: {\"outcome\":\"passed|failed|inconclusive\",\"confidence\":0.0,\"summary\":\"...\",\"scores\":{\"taskSuccess\":0,\"instructionFollowing\":0,\"toolUse\":0,\"verification\":0,\"artifactQuality\":0,\"efficiency\":0,\"scoreDiscrimination\":0},\"strengths\":[\"...\"],\"issues\":[{\"severity\":\"high|medium|low\",\"category\":\"...\",\"evidence\":\"...\",\"recommendation\":\"...\"}],\"rootCause\":\"...\",\"followUps\":[\"...\"],\"rubricNotes\":[\"...\"]}",
  ].join("\n");
}

function extractResponseText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    const text = content
      .map((part) => typeof part === "string" ? part : part?.text ?? part?.content ?? "")
      .join("")
      .trim();
    if (text) return text;
  }
  if (typeof payload?.response === "string") return payload.response.trim();
  if (typeof payload?.output_text === "string") return payload.output_text.trim();
  return "";
}

function extractJsonObject(text) {
  const withoutFence = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(withoutFence);
  } catch {
    const start = withoutFence.indexOf("{");
    const end = withoutFence.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(withoutFence.slice(start, end + 1));
    }
    throw new Error("Judge response did not contain a JSON object");
  }
}

function extractGatewayError(payload, text, status) {
  const message = payload?.error?.message ?? payload?.errors?.[0]?.message;
  return message || text.trim() || `AI Gateway judge request failed (${status})`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeGatewayUsage(usage) {
  if (!isObject(usage)) return undefined;
  const inputTokens = Number(
    usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokens ?? usage.input ?? 0,
  );
  const outputTokens = Number(
    usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokens ?? usage.output ?? 0,
  );
  const normalizedInputTokens = Number.isFinite(inputTokens) && inputTokens >= 0 ? inputTokens : 0;
  const normalizedOutputTokens = Number.isFinite(outputTokens) && outputTokens >= 0 ? outputTokens : 0;
  const totalTokens = Number(
    usage.total_tokens ?? usage.totalTokens ?? normalizedInputTokens + normalizedOutputTokens,
  );
  return {
    inputTokens: normalizedInputTokens,
    outputTokens: normalizedOutputTokens,
    totalTokens: Number.isFinite(totalTokens) && totalTokens >= 0
      ? totalTokens
      : normalizedInputTokens + normalizedOutputTokens,
  };
}

function buildJudgeRequestBody(config, judgeInput) {
  const isOpenAiCompatJudge = config.gatewayProvider === "compat" && config.model.startsWith("openai/");
  const body = {
    model: config.model,
    messages: [
      { role: "system", content: judgeSystemPrompt() },
      { role: "user", content: safeJsonStringify(judgeInput) },
    ],
  };
  if (isOpenAiCompatJudge) {
    body.max_completion_tokens = config.maxTokens;
    if (config.reasoningEffort) body.reasoning_effort = config.reasoningEffort;
  } else {
    body.temperature = 0;
    body.max_tokens = config.maxTokens;
  }
  return body;
}

async function callJudgeGatewayOnce(config, judgeInput, context) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  const startedAt = Date.now();
  try {
    const url = `${config.origin}/v1/${encodeURIComponent(config.accountId)}/${encodeURIComponent(config.gatewayId)}/${encodeURIComponent(config.gatewayProvider)}/chat/completions`;
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${config.authToken}`,
        "content-type": "application/json",
        "cf-aig-metadata": JSON.stringify({
          uid: `eval-judge:${judgeInput.evalName}:${context.targetModel ?? "default"}`,
          chiridion: { component: "agent-eval-judge" },
        }),
      },
      body: JSON.stringify(buildJudgeRequestBody(config, judgeInput)),
    });
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : undefined;
    } catch (error) {
      const parseError = new Error(
        `AI Gateway returned non-JSON judge response: ${error instanceof Error ? error.message : String(error)}`,
      );
      parseError.rawResponse = excerpt(text, 1000);
      throw parseError;
    }
    if (!response.ok) {
      throw new Error(extractGatewayError(payload, text, response.status));
    }
    const responseText = extractResponseText(payload);
    if (!responseText) throw new Error("Judge response was empty");
    return {
      parsed: extractJsonObject(responseText),
      responseText,
      latencyMs: Date.now() - startedAt,
      tokenUsage: normalizeGatewayUsage(payload?.usage),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function callJudgeGateway(config, judgeInput, context) {
  const errors = [];
  const startedAt = Date.now();
  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    try {
      const result = await callJudgeGatewayOnce(config, judgeInput, context);
      return {
        ...result,
        attempts: attempt,
        totalLatencyMs: Date.now() - startedAt,
        retryErrors: errors,
      };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      if (attempt >= config.maxAttempts) {
        const finalError = error instanceof Error ? error : new Error(String(error));
        finalError.attempts = attempt;
        finalError.retryErrors = errors;
        finalError.totalLatencyMs = Date.now() - startedAt;
        throw finalError;
      }
      await delay(500 * attempt);
    }
  }
  throw new Error("Judge request failed before making an attempt");
}

function clampScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  return Math.max(0, Math.min(5, number));
}

function stringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim()).map((item) => excerpt(item, 1000))
    : [];
}

function normalizeIssues(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 12).map((item) => {
    const issue = isObject(item) ? item : { evidence: String(item) };
    const severity = ["high", "medium", "low"].includes(issue.severity)
      ? issue.severity
      : "medium";
    return {
      severity,
      category: typeof issue.category === "string" ? excerpt(issue.category, 120) : "general",
      evidence: typeof issue.evidence === "string" ? excerpt(issue.evidence, 1000) : excerpt(safeJsonStringify(issue), 1000),
      recommendation: typeof issue.recommendation === "string" ? excerpt(issue.recommendation, 1000) : "Review the transcript evidence and deterministic criteria.",
    };
  });
}

function buildJudgeAgreement(outcome, transcript) {
  const deterministic = deterministicSummary(transcript.evaluation);
  const judgePassed = outcome === "passed" ? true : outcome === "failed" ? false : null;
  return {
    deterministicPassed: deterministic.passed,
    judgePassed,
    matchesDeterministic:
      typeof deterministic.passed === "boolean" && judgePassed !== null
        ? deterministic.passed === judgePassed
        : null,
    deterministic,
  };
}

function normalizeJudgeResult(parsed, config, context, transcript, metadata = {}) {
  if (!isObject(parsed)) throw new Error("Judge JSON was not an object");
  const outcome = ["passed", "failed", "inconclusive"].includes(parsed.outcome)
    ? parsed.outcome
    : "inconclusive";
  const confidence = Number(parsed.confidence);
  const scores = isObject(parsed.scores) ? parsed.scores : {};
  return {
    status: "completed",
    schemaVersion: 2,
    advisory: true,
    independentBlindReview: true,
    generatedAt: new Date().toISOString(),
    evalName: context.evalName,
    targetModel: context.targetModel,
    judgeModel: config.model,
    gatewayProvider: config.gatewayProvider,
    reasoningEffort: config.reasoningEffort,
    attempts: metadata.attempts,
    latencyMs: metadata.totalLatencyMs ?? metadata.latencyMs,
    tokenUsage: metadata.tokenUsage,
    retryErrors: metadata.retryErrors,
    outcome,
    agreement: buildJudgeAgreement(outcome, transcript),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : undefined,
    summary: typeof parsed.summary === "string" ? excerpt(parsed.summary, 1600) : "",
    scores: {
      taskSuccess: clampScore(scores.taskSuccess),
      instructionFollowing: clampScore(scores.instructionFollowing),
      toolUse: clampScore(scores.toolUse),
      verification: clampScore(scores.verification),
      artifactQuality: clampScore(scores.artifactQuality),
      efficiency: clampScore(scores.efficiency),
      scoreDiscrimination: clampScore(scores.scoreDiscrimination),
    },
    strengths: stringArray(parsed.strengths),
    issues: normalizeIssues(parsed.issues),
    rootCause: typeof parsed.rootCause === "string" ? excerpt(parsed.rootCause, 1200) : null,
    followUps: stringArray(parsed.followUps),
    rubricNotes: stringArray(parsed.rubricNotes),
    deterministicSignalNotes: stringArray(parsed.deterministicSignalNotes),
  };
}

export async function attachEvalLlmJudge(transcript, context) {
  if (!isObject(transcript)) return transcript;
  const env = withLoadedEvalEnv(context.env ?? process.env);
  const config = resolveJudgeConfig(env);
  if (config.skipped) {
    transcript.llmJudge = {
      status: "skipped",
      schemaVersion: 2,
      advisory: true,
      independentBlindReview: true,
      generatedAt: new Date().toISOString(),
      evalName: context.evalName,
      targetModel: context.targetModel,
      reason: config.reason,
    };
    return transcript;
  }

  try {
    const judgeInput = buildJudgeInput(transcript, context);
    const judgeResult = await callJudgeGateway(config, judgeInput, context);
    const { parsed, responseText } = judgeResult;
    transcript.llmJudge = normalizeJudgeResult(parsed, config, context, transcript, judgeResult);
    if (!transcript.llmJudge.summary) {
      transcript.llmJudge.summary = excerpt(responseText, 1600);
    }
  } catch (error) {
    transcript.llmJudge = {
      status: "error",
      schemaVersion: 2,
      advisory: true,
      independentBlindReview: true,
      generatedAt: new Date().toISOString(),
      evalName: context.evalName,
      targetModel: context.targetModel,
      judgeModel: config.model,
      gatewayProvider: config.gatewayProvider,
      reasoningEffort: config.reasoningEffort,
      attempts: error && typeof error === "object" && "attempts" in error ? error.attempts : undefined,
      latencyMs: error && typeof error === "object" && "totalLatencyMs" in error
        ? error.totalLatencyMs
        : undefined,
      retryErrors: error && typeof error === "object" && "retryErrors" in error
        ? error.retryErrors
        : undefined,
      error: error instanceof Error ? error.message : String(error),
      ...(error && typeof error === "object" && "rawResponse" in error
        ? { rawResponse: error.rawResponse }
        : {}),
    };
  }
  return transcript;
}

export function formatEvalLlmJudgeSummary(transcript) {
  const judge = transcript?.llmJudge;
  if (!isObject(judge)) return undefined;
  if (judge.status === "completed") {
    const issueCount = Array.isArray(judge.issues) ? judge.issues.length : 0;
    const agreement = isObject(judge.agreement)
      ? judge.agreement.matchesDeterministic
      : undefined;
    return [
      `Eval LLM judge: completed outcome=${judge.outcome}`,
      `confidence=${judge.confidence ?? "n/a"}`,
      `agreement=${agreement ?? "n/a"}`,
      `issues=${issueCount}`,
      `attempts=${judge.attempts ?? "n/a"}`,
      `latencyMs=${judge.latencyMs ?? "n/a"}`,
    ].join(" ");
  }
  if (judge.status === "skipped") return `Eval LLM judge: skipped (${judge.reason})`;
  if (judge.status === "error") return `Eval LLM judge: error (${judge.error})`;
  return `Eval LLM judge: ${judge.status}`;
}
