#!/usr/bin/env bun
// Opt-in live semantic evaluator. It calls the same production selector with a
// Workers AI REST adapter and prints aggregate metrics plus compact diagnostics
// for failed cases. No application route or runtime diagnostic surface is used.
//
// Hosted-model output is noisy even at temperature 0, so quality thresholds are
// advisory: this script exits unsuccessfully only for setup/authentication errors.
//
//   bun run eval:chat-group-icons:live
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { AUXILIARY_AI_MODEL } from "../src/lib/auxiliary-ai.server.ts";
import {
  CHAT_GROUP_ICON_SELECTION_STRATEGY,
  generateChatGroupIconWithOpenAI,
} from "../src/lib/chat-group-avatar-generation.server.ts";
import { DEFAULT_CHAT_GROUP_ICON } from "../src/lib/chat-group-icons.ts";
import {
  parseGeneratedPictogramTerms,
  searchLucideIconMetadata,
} from "../src/lib/lucide-icon-metadata.ts";
import { CHAT_GROUP_ICON_SEMANTIC_CORPUS } from "../tests/fixtures/chat-group-icon-semantic-corpus.ts";

if (existsSync(".dev.vars")) {
  for (const line of readFileSync(".dev.vars", "utf8").split(/\r?\n/)) {
    const match = line.match(
      /^\s*(CF_API_TOKEN|CF_ACCOUNT_ID|CF_GATEWAY_NAME|CF_GATEWAY_TOKEN)\s*=\s*(.*?)\s*$/,
    );
    if (!match) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, "$2");
    if (!process.env[match[1]]) process.env[match[1]] = value;
  }
}

function readAccountId() {
  if (process.env.CF_ACCOUNT_ID) return process.env.CF_ACCOUNT_ID;
  const wrangler = readFileSync("wrangler.jsonc", "utf8");
  return wrangler.match(/"CF_ACCOUNT_ID"\s*:\s*"([a-f0-9]+)"/)?.[1] ?? null;
}

const accountId = readAccountId();
const apiToken = process.env.CF_API_TOKEN;
const gatewayName = process.env.CF_GATEWAY_NAME ?? "chiridion";
const gatewayToken = process.env.CF_GATEWAY_TOKEN;
if (!accountId || (!apiToken && !gatewayToken)) {
  console.error(
    "Live icon evaluation requires CF_ACCOUNT_ID and either CF_GATEWAY_TOKEN or CF_API_TOKEN.",
  );
  process.exit(1);
}

let lastRawOutput = null;
const ai = {
  async run(model, inputs) {
    const useGateway = Boolean(gatewayToken);
    const response = await fetch(
      useGateway
        ? `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayName}/compat/chat/completions`
        : `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`,
      {
        method: "POST",
        headers: {
          ...(useGateway
            ? { "cf-aig-authorization": `Bearer ${gatewayToken}` }
            : { Authorization: `Bearer ${apiToken}` }),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          useGateway ? { ...inputs, model: `workers-ai/${model}` } : inputs,
        ),
      },
    );
    const payload = await response.json();
    if (!response.ok || payload.success === false) {
      const message = payload.errors?.[0]?.message ?? response.statusText;
      const error = new Error(
        `Workers AI request failed (${response.status}): ${message}`,
      );
      error.status = response.status;
      throw error;
    }
    const result = payload.result ?? payload;
    lastRawOutput =
      result.choices?.[0]?.message?.content ?? result.response ?? null;
    return result;
  },
};

const results = [];
for (const testCase of CHAT_GROUP_ICON_SEMANTIC_CORPUS) {
  const startedAt = performance.now();
  let outcome = "ai_error";
  let icon = null;
  let error = null;
  lastRawOutput = null;
  try {
    icon = await generateChatGroupIconWithOpenAI(
      ai,
      testCase.title,
      undefined,
      {
        onOutcome: (value) => {
          outcome = value;
        },
      },
    );
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
    if (
      cause &&
      typeof cause === "object" &&
      "status" in cause &&
      (cause.status === 401 || cause.status === 403)
    ) {
      console.error(error);
      process.exit(1);
    }
  }
  const terms = parseGeneratedPictogramTerms(lastRawOutput);
  results.push({
    id: testCase.id,
    icon,
    outcome,
    durationMs: performance.now() - startedAt,
    acceptable: icon !== null && testCase.acceptable.includes(icon),
    defaulted: icon === null || icon === DEFAULT_CHAT_GROUP_ICON,
    terms,
    candidates: terms.map((term) => ({
      term,
      matches: searchLucideIconMetadata(term, 3),
    })),
    error,
  });
}

const sortedDurations = results
  .map((result) => result.durationMs)
  .sort((left, right) => left - right);
const count = results.length;
const failures = results.filter(
  (result) => result.defaulted || !result.acceptable || result.error,
);
const nonDefaultRate =
  results.filter((result) => !result.defaulted).length / count;
const acceptableIconRate =
  results.filter((result) => result.acceptable).length / count;
const qualityTargets = {
  minimumNonDefaultRate: 0.95,
  minimumAcceptableIconRate: 0.9,
};
const meetsQualityTargets =
  nonDefaultRate >= qualityTargets.minimumNonDefaultRate &&
  acceptableIconRate >= qualityTargets.minimumAcceptableIconRate;
const summary = {
  strategy: CHAT_GROUP_ICON_SELECTION_STRATEGY,
  model: AUXILIARY_AI_MODEL,
  cases: count,
  nonDefaultRate,
  acceptableIconRate,
  unparseableOutputRate:
    results.filter((result) => result.outcome === "unparseable_output").length /
    count,
  aiErrorRate:
    results.filter((result) => result.outcome === "ai_error").length / count,
  meanDurationMs:
    sortedDurations.reduce((sum, duration) => sum + duration, 0) / count,
  p95DurationMs:
    sortedDurations[Math.max(0, Math.ceil(sortedDurations.length * 0.95) - 1)],
  qualityTargets: {
    ...qualityTargets,
    met: meetsQualityTargets,
  },
  failures: failures.map(({ id, icon, outcome, terms, candidates, error }) => ({
    id,
    icon,
    outcome,
    terms,
    candidates,
    error,
  })),
};

const outputPath = process.env.EVAL_OUTPUT;
if (outputPath) {
  writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(
    JSON.stringify(
      { ...summary, failures: `${failures.length} cases; see ${outputPath}` },
      null,
      2,
    ),
  );
} else {
  console.log(JSON.stringify(summary, null, 2));
}
if (!meetsQualityTargets) {
  console.warn(
    "Directional live evaluation missed its advisory quality targets; review repeated runs before changing production behavior.",
  );
}
