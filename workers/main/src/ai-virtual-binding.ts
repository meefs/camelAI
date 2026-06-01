import { WorkerEntrypoint } from "cloudflare:workers";
import type { OrgDO } from "./auth";
import { ensureLegacyHostUsageBackfilled } from "./legacy-usage-backfill-gate";
import { decryptCredentials } from "../../../src/lib/integration-crypto";
import { parseStoredLlmProviderConfig } from "../../../src/lib/llm-provider-config";
import { chatCompletionToPiCall, runBedrockViaPi } from "./bedrock-pi-adapter";

export interface AIVirtualBindingEnv {
  ORG: DurableObjectNamespace<OrgDO>;
  AI?: Ai;
  R2_BUCKET?: R2Bucket;
  SANDBOX_HOST?: Fetcher;
  CF_ACCOUNT_ID?: string;
  CF_GATEWAY_NAME?: string;
  CF_GATEWAY_TOKEN?: string;
  AI_GATEWAY_AUTH_TOKEN?: string;
  INTEGRATION_SECRET_KEY?: string;
}

export interface AIVirtualBindingProps {
  orgId: string;
  workspaceId: string;
  userId?: string;
}

export interface VirtualAiRunScope {
  env: AIVirtualBindingEnv;
  props: AIVirtualBindingProps;
  waitUntil: (promise: Promise<unknown>) => void;
}

export type TierName = "cheap" | "fast" | "auto" | "smart";
export type ProviderKind = "openai" | "anthropic" | "bedrock" | "openrouter";

const TIERS: ReadonlySet<TierName> = new Set(["cheap", "fast", "auto", "smart"]);

const TIER_MODELS: Readonly<Record<ProviderKind, Readonly<Record<TierName, string>>>> = {
  openai: {
    cheap: "gpt-5.4-nano",
    fast: "gpt-5.4-mini",
    auto: "gpt-5.4-mini",
    smart: "gpt-5.5",
  },
  anthropic: {
    cheap: "claude-haiku-4-5-20251001",
    fast: "claude-haiku-4-5-20251001",
    auto: "claude-sonnet-4-6",
    smart: "claude-opus-4-8",
  },
  bedrock: {
    cheap: "global.anthropic.claude-haiku-4-5-20251001-v1:0",
    fast: "global.anthropic.claude-haiku-4-5-20251001-v1:0",
    auto: "global.anthropic.claude-sonnet-4-6",
    smart: "global.anthropic.claude-opus-4-8",
  },
  openrouter: {
    cheap: "deepseek/deepseek-v4-flash",
    fast: "deepseek/deepseek-v4-flash",
    auto: "moonshotai/kimi-k2.6",
    smart: "anthropic/claude-sonnet-4.6",
  },
};

// Matches the fallback used by the BYOK key-validation route and
// pi-bedrock-provider (chat path). Bedrock model access is granted per region,
// so an org that validated/used Bedrock in us-east-1 must hit the same region
// for env.AI.run tier calls.
const DEFAULT_BEDROCK_REGION = "us-east-1";

/**
 * Back-compat shim for already-deployed user workers that still call the old
 * model strings the pre-tier `resolveModel` accepted. Without this, the
 * pass-through path would turn `gpt-5.5` into `gpt-5.5:nitro` (a non-existent
 * OpenRouter id) and `auto_search` into `auto_search:nitro`, breaking those
 * apps on rollout.
 *
 * - The old "auto"-family routes (`dynamic/auto`, `auto_search`) map to the
 *   `auto` tier. Search grounding was removed, so `auto_search` degrades to a
 *   plain completion rather than erroring.
 * - `dynamic/auto_image` maps to the private `auto_image` route (see
 *   executeVirtualAiRun) so image generation keeps working.
 * - The old friendly model names map to their OpenRouter ids; the pass-through
 *   path then appends `:nitro` as usual.
 */
const LEGACY_MODEL_ALIASES: Readonly<Record<string, string>> = {
  "dynamic/auto": "auto",
  auto_search: "auto",
  "dynamic/auto_search": "auto",
  "dynamic/auto_image": "auto_image",
  "gpt-5.5": "openai/gpt-5.5",
  "kimi-k2.6": "moonshotai/kimi-k2.6",
  "kimi-latest": "moonshotai/kimi-k2.6",
  opus: "anthropic/claude-opus-4.8",
  "opus-4.7": "anthropic/claude-opus-4.8",
  "opus-4.8": "anthropic/claude-opus-4.8",
  "grok-4.3": "x-ai/grok-4.3",
  "grok-latest": "x-ai/grok-4.3",
  "gemini-3.5-flash": "google/gemini-3.5-flash",
  "gemini-3-flash-preview": "google/gemini-3-flash-preview",
  "gemini-3.1-pro-preview": "google/gemini-3.5-flash",
  "deepseek-v4-pro": "deepseek/deepseek-v4-pro",
  "deepseek-v4-flash": "deepseek/deepseek-v4-flash",
};

/**
 * Rewrite a legacy model string to its current equivalent. Idempotent — a
 * value that isn't a legacy alias (including current tier names and OpenRouter
 * ids) passes through unchanged.
 */
export function normalizeLegacyModel(model: string): string {
  const trimmed = model.trim();
  return LEGACY_MODEL_ALIASES[trimmed] ?? trimmed;
}

interface ResolvedRouting {
  /** Provider whose endpoint we hit. */
  provider: ProviderKind;
  /** Model id sent to the provider (already :nitro-suffixed for OpenRouter). */
  model: string;
  /** Per-request auth: user's BYOK key, or undefined to use the hosted gateway token. */
  byokKey?: string;
  /** Bedrock-only: region for the Converse URL. */
  awsRegion?: string;
}

/**
 * Resolve a model string + the org's BYOK config into a concrete provider route.
 *
 * Friendly tiers (`cheap`/`fast`/`auto`/`smart`) pick a per-provider model based
 * on the org's active BYOK key (Anthropic / OpenAI / Bedrock / OpenRouter) —
 * orgs without BYOK get the OpenRouter mapping routed through our hosted credits.
 * Anything else is treated as a real OpenRouter model id and passes through to
 * the OpenRouter route (still using the org's OpenRouter BYOK if present).
 */
export async function resolveRouting(
  scope: VirtualAiRunScope,
  rawModel: string,
): Promise<ResolvedRouting> {
  const byok = await readOrgByok(scope.env, scope.props);
  const trimmed = normalizeLegacyModel(rawModel);

  if (TIERS.has(trimmed as TierName)) {
    const tier = trimmed as TierName;
    const provider = byok?.provider ?? "openrouter";
    const baseModel = TIER_MODELS[provider][tier];
    return {
      provider,
      model: formatModelForProvider(provider, baseModel),
      byokKey: byok?.apiKey,
      awsRegion: byok?.awsRegion,
    };
  }

  // Pass-through: always route to OpenRouter. Use org's OpenRouter BYOK only if
  // that's the configured provider; otherwise the hosted gateway token (CF AI
  // Gateway has the OpenRouter key stored at the gateway level).
  return {
    provider: "openrouter",
    model: appendNitro(trimmed || TIER_MODELS.openrouter.auto),
    byokKey: byok?.provider === "openrouter" ? byok.apiKey : undefined,
  };
}

async function readOrgByok(
  env: AIVirtualBindingEnv,
  props: AIVirtualBindingProps,
): Promise<{ provider: ProviderKind; apiKey: string; awsRegion?: string } | null> {
  const orgStub = env.ORG.get(env.ORG.idFromName(props.orgId));
  const record = await orgStub.getLlmProviderConfig();
  if (!record) return null;

  // Org has BYOK configured but the worker can't decrypt it (missing secret,
  // rotated key, corrupted record). Surface this loudly — silently falling
  // back to hosted credits would change both billing and the upstream data
  // path without the user noticing.
  if (!env.INTEGRATION_SECRET_KEY) {
    throw new Error(
      "BYOK credentials are configured but INTEGRATION_SECRET_KEY is unavailable in this worker; cannot decrypt your provider key.",
    );
  }

  let creds: Record<string, string>;
  try {
    creds = await decryptCredentials<Record<string, string>>(
      record.credentials_encrypted,
      env.INTEGRATION_SECRET_KEY,
    );
  } catch (error) {
    console.error("[AIVirtualBinding] failed to decrypt BYOK creds", error);
    throw new Error(
      "Failed to decrypt your stored AI provider credentials. Re-save your key in Settings -> AI Provider to continue using BYOK.",
    );
  }
  const config = parseStoredLlmProviderConfig(record.config);

  const missingKey = (): Error =>
    new Error(
      `Your stored ${record.provider} credentials are missing an API key. Re-save your key in Settings -> AI Provider to continue using BYOK.`,
    );

  switch (record.provider) {
    case "openai":
      if (!creds.api_key) throw missingKey();
      return { provider: "openai", apiKey: creds.api_key };
    case "anthropic":
      if (!creds.api_key) throw missingKey();
      return { provider: "anthropic", apiKey: creds.api_key };
    case "openrouter":
      if (!creds.api_key) throw missingKey();
      return { provider: "openrouter", apiKey: creds.api_key };
    case "bedrock":
      if (!creds.bearer_token) throw missingKey();
      return {
        provider: "bedrock",
        apiKey: creds.bearer_token,
        awsRegion: config.aws_region ?? DEFAULT_BEDROCK_REGION,
      };
    default:
      // Unknown provider in the record — fall through to hosted rather than
      // failing loudly, because unsupported-but-recorded providers shouldn't
      // brick the worker for the user. Logged for visibility.
      console.warn(
        `[AIVirtualBinding] unknown BYOK provider in record: ${record.provider}`,
      );
      return null;
  }
}

export async function executeVirtualAiRun(
  scope: VirtualAiRunScope,
  model: string,
  input: unknown,
  _options?: unknown,
): Promise<unknown> {
  const { model: inputModel, input: sanitizedInput } = extractModelFromInput(input);
  const requestedModel = normalizeLegacyModel(pickModel(model, inputModel));

  // Internal legacy escape hatch used by generate-image.ts → env.CAMELAI.generateImage.
  // Not a public model name — kept private until image generation moves to a
  // concrete provider model. Always routes through the gateway's compat path
  // on our hosted credits (no BYOK, charges credits). `dynamic/auto_image`
  // (old public string) is normalized to `auto_image` by normalizeLegacyModel.
  if (requestedModel === "auto_image") {
    const settings = requireGatewaySettings(scope.env);
    return runLegacyAutoImage(scope, settings, sanitizedInput);
  }

  const routing = await resolveRouting(scope, requestedModel);
  const usesByok = routing.byokKey !== undefined;
  const access = usesByok
    ? { creditChargeable: false }
    : await checkHostedModelAccess(scope.env, scope.props);
  const billingSource: "byok" | "hosted" = usesByok ? "byok" : "hosted";

  const settings = routing.provider === "bedrock"
    ? undefined
    : requireGatewaySettings(scope.env);

  const startedAt = Date.now();
  const result =
    routing.provider === "bedrock"
      ? await runBedrockViaPi({
          call: chatCompletionToPiCall(sanitizedInput),
          modelId: routing.model,
          // Bedrock BYOK is the only path here — if we got bedrock routing
          // without a key, that's a bug in resolveRouting (would mean an org
          // with Bedrock-typed BYOK record but no decryptable bearer token,
          // which `readOrgByok` now throws on).
          bearerToken: routing.byokKey!,
          region: routing.awsRegion,
        })
      : await runViaGatewayHTTP(
          settings,
          scope.props,
          sanitizedInput,
          routing.model,
          routing.provider === "openrouter" ? "openrouter" : "compat",
          routing.byokKey,
        );

  const fallbackModel = routing.model;
  const record = (usage: ExtractedUsage) =>
    recordVirtualAiUsage(
      scope.env,
      scope.props,
      usage,
      routing.provider,
      Date.now() - startedAt,
      access.creditChargeable,
      billingSource,
    ).catch((error) => {
      console.error("[AIVirtualBinding] failed to record usage", error);
    });
  if (result instanceof ReadableStream) {
    const [clientStream, usageStream] = result.tee();
    scope.waitUntil(
      extractStreamingUsage(usageStream, fallbackModel).then((usage) =>
        usage ? record(usage) : undefined,
      ),
    );
    return clientStream;
  }
  const usage = extractJsonUsage(result, fallbackModel);
  if (usage) {
    scope.waitUntil(record(usage));
  }
  return result;
}

async function runLegacyAutoImage(
  scope: VirtualAiRunScope,
  settings: GatewaySettings,
  input: unknown,
): Promise<unknown> {
  const access = await checkHostedModelAccess(scope.env, scope.props);
  const startedAt = Date.now();
  const result = await runViaGatewayHTTP(
    settings,
    scope.props,
    input,
    "dynamic/auto_image",
    "compat",
    undefined,
  );
  const fallbackModel = "dynamic/auto_image";
  const record = (usage: ExtractedUsage) =>
    recordVirtualAiUsage(
      scope.env,
      scope.props,
      usage,
      "openrouter",
      Date.now() - startedAt,
      access.creditChargeable,
      "hosted",
    ).catch((error) => {
      console.error("[AIVirtualBinding] failed to record usage", error);
    });
  if (result instanceof ReadableStream) {
    const [clientStream, usageStream] = result.tee();
    scope.waitUntil(
      extractStreamingUsage(usageStream, fallbackModel).then((usage) =>
        usage ? record(usage) : undefined,
      ),
    );
    return clientStream;
  }
  const usage = extractJsonUsage(result, fallbackModel);
  if (usage) {
    scope.waitUntil(record(usage));
  }
  return result;
}

async function checkHostedModelAccess(
  env: AIVirtualBindingEnv,
  props: AIVirtualBindingProps,
): Promise<{ creditChargeable: boolean }> {
  const orgStub = env.ORG.get(env.ORG.idFromName(props.orgId));
  const org = await orgStub.getInfo();
  if (!org) {
    throw new Error("Organization not found");
  }
  const status = org.billing_status ?? "inactive";
  const plan = org.billing_plan ?? "payg";
  if (status === "enterprise") return { creditChargeable: false };
  const isPayAsYouGo = plan === "payg";
  if (status === "past_due") {
    throw new Error(
      "Your subscription is past due. Update payment details, switch to Pay as you go in Settings -> Billing, or add your own API key in Settings -> AI Provider to continue.",
    );
  }
  if (status === "canceled") {
    throw new Error(
      "Your subscription was canceled. Start a new subscription, switch to Pay as you go in Settings -> Billing, or add your own API key in Settings -> AI Provider to continue.",
    );
  }
  if (!isPayAsYouGo && status !== "trialing" && status !== "active") {
    throw new Error(
      "Hosted models require billing access. Choose Pay as you go, start a subscription, or add your own API key in Settings -> AI Provider.",
    );
  }
  await ensureLegacyHostUsageBackfilled(env, props.orgId);
  const usage = await orgStub.getUsageLogSum(0, Date.now(), true);
  const spentCents = Math.round(Number(usage.total_cost_usd ?? 0) * 100);
  const totalCreditsCents =
    (org.billing_credit_purchase_total_cents ?? 0) +
    (org.billing_credit_grant_total_cents ?? 0);
  if (totalCreditsCents - spentCents <= 0) {
    throw new Error(
      `Hosted model credits are used up. You have used ${(spentCents / 100).toFixed(2)} of ${(totalCreditsCents / 100).toFixed(2)} credits.`,
    );
  }
  return { creditChargeable: true };
}

async function recordVirtualAiUsage(
  env: AIVirtualBindingEnv,
  props: AIVirtualBindingProps,
  usage: ExtractedUsage,
  provider: ProviderKind,
  durationMs: number,
  creditChargeable: boolean,
  billingSource: "byok" | "hosted",
): Promise<void> {
  const orgStub = env.ORG.get(env.ORG.idFromName(props.orgId));
  await orgStub.recordUsage({
    workspace_id: props.workspaceId,
    user_id: props.userId ?? "",
    thread_id: "virtual-ai",
    model: usage.model,
    provider,
    billing_source: billingSource,
    credit_chargeable: creditChargeable,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_creation_input_tokens: usage.cacheCreationInputTokens,
    cache_read_input_tokens: usage.cacheReadInputTokens,
    reported_cost_usd: usage.reportedCostUsd,
    upstream_inference_cost_usd: usage.upstreamInferenceCostUsd,
    duration_ms: durationMs,
    created_at_ms: Date.now(),
  });
}

/**
 * Virtual AI binding for user-uploaded workers.
 *
 * User workers can declare a native `ai` binding, and deploy-time rewriting
 * maps it to this entrypoint for tenant-safe routing through the platform worker.
 */
export class AIVirtualBinding extends WorkerEntrypoint<
  AIVirtualBindingEnv,
  AIVirtualBindingProps
> {
  async run(
    model: string,
    input: unknown,
    options?: unknown,
  ): Promise<unknown> {
    return executeVirtualAiRun(
      {
        env: this.env,
        props: this.ctx.props,
        waitUntil: (promise) => this.ctx.waitUntil(promise),
      },
      model,
      input,
      options,
    );
  }
}

function pickModel(...candidates: (string | undefined)[]): string {
  for (const c of candidates) {
    const trimmed = c?.trim();
    if (trimmed) return trimmed;
  }
  return "auto";
}

export function extractModelFromInput(input: unknown): {
  model: string | undefined;
  input: unknown;
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { model: undefined, input };
  }
  const obj = input as Record<string, unknown>;
  if (!("model" in obj)) {
    return { model: undefined, input };
  }

  const { model, ...rest } = obj;
  return { model: typeof model === "string" ? model : undefined, input: rest };
}

export interface GatewaySettings {
  accountID: string;
  gatewayID: string;
  authToken: string;
}

function requireGatewaySettings(env: AIVirtualBindingEnv): GatewaySettings {
  const settings = resolveGatewaySettings(env);
  if (!settings) {
    throw new Error("AI Gateway is not configured for virtual AI.");
  }
  return settings;
}

function resolveGatewayAuthToken(
  env: Pick<AIVirtualBindingEnv, "AI_GATEWAY_AUTH_TOKEN" | "CF_GATEWAY_TOKEN">,
): string | undefined {
  const explicitToken = env.AI_GATEWAY_AUTH_TOKEN?.trim();
  if (explicitToken) return explicitToken;

  const cfToken = env.CF_GATEWAY_TOKEN?.trim();
  if (cfToken) return cfToken;

  return undefined;
}

export function resolveGatewaySettings(
  env: Pick<
    AIVirtualBindingEnv,
    | "CF_ACCOUNT_ID"
    | "CF_GATEWAY_NAME"
    | "AI_GATEWAY_AUTH_TOKEN"
    | "CF_GATEWAY_TOKEN"
  >,
): GatewaySettings | undefined {
  const accountID = env.CF_ACCOUNT_ID?.trim();
  const gatewayID = env.CF_GATEWAY_NAME?.trim();
  const authToken = resolveGatewayAuthToken(env);
  if (!accountID || !gatewayID || !authToken) return undefined;

  return {
    accountID,
    gatewayID,
    authToken,
  };
}

function buildGatewayMetadata(props: AIVirtualBindingProps): string {
  const userId = props.userId?.trim();
  const uid = userId
    ? `${props.orgId}:${props.workspaceId}:${userId}`
    : `${props.orgId}:${props.workspaceId}`;
  const chiridion: Record<string, string> = {
    orgId: props.orgId,
    workspaceId: props.workspaceId,
  };
  if (userId) {
    chiridion.userId = userId;
  }
  return JSON.stringify({
    uid,
    chiridion,
  });
}

export type GatewayProvider = "compat" | "openrouter";

function buildGatewayURL(
  accountID: string,
  gatewayID: string,
  provider: GatewayProvider = "compat",
): string {
  return `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(accountID)}/${encodeURIComponent(gatewayID)}/${provider}/chat/completions`;
}

/**
 * Format a tier-resolved model id for the destination route.
 *
 * - OpenAI/Anthropic compat routing requires `provider/model` (CF AI Gateway's
 *   unified API dispatches on the prefix).
 * - OpenRouter ids stay bare and get `:nitro` appended.
 * - Bedrock ids go in the URL path, not the body, so they're returned as-is.
 */
function formatModelForProvider(
  provider: ProviderKind,
  baseModel: string,
): string {
  switch (provider) {
    case "openai":
      return `openai/${baseModel}`;
    case "anthropic":
      return `anthropic/${baseModel}`;
    case "bedrock":
      return baseModel;
    case "openrouter":
      return appendNitro(baseModel);
  }
}

export function appendNitro(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) return trimmed;
  const lastSegment = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  if (lastSegment.includes(":")) return trimmed;
  return `${trimmed}:nitro`;
}

export async function runViaGatewayHTTP(
  settings: GatewaySettings,
  props: AIVirtualBindingProps,
  input: unknown,
  model: string,
  provider: GatewayProvider = "compat",
  byokKey?: string,
): Promise<unknown> {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${byokKey ?? settings.authToken}`);
  if (byokKey) {
    headers.set("cf-aig-authorization", `Bearer ${settings.authToken}`);
  }
  headers.set("Content-Type", "application/json");
  headers.set("cf-aig-metadata", buildGatewayMetadata(props));
  const payload = toGatewayPayload(input, model);

  const resp = await fetch(
    buildGatewayURL(settings.accountID, settings.gatewayID, provider),
    {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    },
  );

  const streamRequested = payload.stream === true;
  if (resp.ok && shouldPassthroughStream(resp, streamRequested)) {
    if (!resp.body) {
      throw new Error("AI Gateway returned an empty streaming response");
    }
    return resp.body;
  }

  const responseText = await resp.text();
  const responsePayload = responseText
    ? safeJsonParse(responseText)
    : undefined;
  if (!resp.ok) {
    const message =
      extractGatewayErrorMessage(responsePayload) ??
      (responseText.trim() || undefined) ??
      `AI Gateway request failed (${resp.status})`;
    throw new Error(message);
  }

  if (responsePayload !== undefined) {
    return responsePayload;
  }

  if (responseText.trim()) {
    throw new Error("AI Gateway returned a non-JSON non-streaming response");
  }
  return {};
}

interface ExtractedUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  reportedCostUsd: number | null;
  upstreamInferenceCostUsd: number | null;
}

function extractJsonUsage(payload: unknown, fallbackModel: string): ExtractedUsage | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  return extractUsageFromObject(payload as Record<string, unknown>, fallbackModel);
}

async function extractStreamingUsage(
  stream: ReadableStream,
  fallbackModel: string,
): Promise<ExtractedUsage | null> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastUsage: ExtractedUsage | null = null;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice("data:".length).trim();
        if (!data || data === "[DONE]") continue;
        const parsed = safeJsonParse(data);
        const usage = extractJsonUsage(parsed, fallbackModel);
        if (usage) lastUsage = usage;
      }
    }
    if (buffer.trim()) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith("data:")) {
        const parsed = safeJsonParse(trimmed.slice("data:".length).trim());
        const usage = extractJsonUsage(parsed, fallbackModel);
        if (usage) lastUsage = usage;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return lastUsage;
}

function extractUsageFromObject(
  payload: Record<string, unknown>,
  fallbackModel: string,
): ExtractedUsage | null {
  const usage = payload.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const usageObj = usage as Record<string, unknown>;
  const costDetails = asRecord(usageObj.cost_details);
  const inputDetails = asRecord(usageObj.input_tokens_details);
  const promptDetails = asRecord(usageObj.prompt_tokens_details);
  const inputTokens = usageNumber(
    usageObj.input_tokens ?? usageObj.prompt_tokens,
  );
  const outputTokens = usageNumber(
    usageObj.output_tokens ?? usageObj.completion_tokens,
  );
  const cacheReadInputTokens = usageNumber(
    inputDetails?.cached_tokens ?? promptDetails?.cached_tokens,
  );
  const cacheCreationInputTokens = usageNumber(
    inputDetails?.cache_write_tokens ??
      inputDetails?.cache_creation_input_tokens ??
      promptDetails?.cache_write_tokens,
  );
  const reportedCostUsd = usageCostNumber(usageObj.cost);
  const upstreamInferenceCostUsd = usageCostNumber(
    costDetails?.upstream_inference_cost,
  );
  if (
    inputTokens <= 0 &&
    outputTokens <= 0 &&
    cacheReadInputTokens <= 0 &&
    cacheCreationInputTokens <= 0 &&
    (reportedCostUsd === null || reportedCostUsd <= 0) &&
    (upstreamInferenceCostUsd === null || upstreamInferenceCostUsd <= 0)
  ) {
    return null;
  }
  return {
    model: typeof payload.model === "string" && payload.model.trim()
      ? payload.model.trim()
      : fallbackModel,
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    reportedCostUsd,
    upstreamInferenceCostUsd,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function usageNumber(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0;
}

function usageCostNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function toGatewayPayload(
  input: unknown,
  model: string,
): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const asObject = input as Record<string, unknown>;
    return { ...asObject, model };
  }
  return { model };
}

function shouldPassthroughStream(
  resp: Response,
  streamRequested: boolean,
): boolean {
  if (!streamRequested) return false;
  const contentType = (resp.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("text/event-stream")) return true;
  return !!resp.body;
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export {
  type AiRunBinding,
  type GeneratedImage,
  type GenerateImageOptions,
  type GenerateImageResult,
  buildGenerateImageMessages,
  generateImage,
  parseGenerateImageResponse,
} from "./generate-image.js";

function extractGatewayErrorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }

  const error = (payload as { error?: unknown }).error;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }

  const errors = (payload as { errors?: unknown }).errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0];
    if (first && typeof first === "object" && !Array.isArray(first)) {
      const message = (first as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) return message;
    }
  }

  return undefined;
}
