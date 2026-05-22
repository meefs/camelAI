import { WorkerEntrypoint } from "cloudflare:workers";
import type { OrgDO } from "./auth";
import { ensureLegacyHostUsageBackfilled } from "./legacy-usage-backfill-gate";

interface AIVirtualBindingEnv {
  ORG: DurableObjectNamespace<OrgDO>;
  SANDBOX_HOST?: Fetcher;
  CF_ACCOUNT_ID?: string;
  CF_GATEWAY_NAME?: string;
  CF_GATEWAY_TOKEN?: string;
  AI_GATEWAY_AUTH_TOKEN?: string;
  AI_VIRTUAL_MODEL?: string;
}

interface AIVirtualBindingProps {
  orgId: string;
  workspaceId: string;
  userId?: string;
}

const DEFAULT_VIRTUAL_MODEL = "google/gemini-3-flash-preview";
const DYNAMIC_MODEL_ALIASES = new Set(["auto_search", "auto_image"]);
const MODEL_ALIASES: Readonly<Record<string, string>> = {
  "gpt-5.5": "openai/gpt-5.5",
  "kimi-k2.6": "~moonshotai/kimi-latest",
  "kimi-latest": "~moonshotai/kimi-latest",
  "opus-4.7": "anthropic/claude-opus-4.7",
  "grok-4.3": "x-ai/grok-4.3",
  "grok-latest": "x-ai/grok-4.3",
  "gemini-3.5-flash": "google/gemini-3.5-flash",
  "gemini-3-flash-preview": "google/gemini-3-flash-preview",
  "gemini-3.1-pro-preview": "google/gemini-3.5-flash",
  "deepseek-v4-pro": "deepseek/deepseek-v4-pro",
  "deepseek-v4-flash": "deepseek/deepseek-v4-flash",
};

/**
 * Resolve a model string to its gateway representation.
 *
 * - `auto`/`dynamic/auto` map to the current default OpenRouter model.
 * - Known capability aliases (`auto_search`, `auto_image`) map to `dynamic/{alias}`.
 * - Non-auto models already prefixed with `dynamic/` pass through unchanged.
 * - Everything else is treated as an OpenRouter model and passes through as-is.
 */
export function resolveModel(model: string): string {
  const trimmed = model.trim();
  if (trimmed === "auto" || trimmed === "dynamic/auto") {
    return DEFAULT_VIRTUAL_MODEL;
  }
  const alias = MODEL_ALIASES[trimmed];
  if (alias) {
    return alias;
  }
  if (DYNAMIC_MODEL_ALIASES.has(trimmed)) {
    return `dynamic/${trimmed}`;
  }
  return trimmed || DEFAULT_VIRTUAL_MODEL;
}

/**
 * Returns true when the resolved model should route through the OpenRouter
 * gateway provider endpoint (`/openrouter/`) rather than the Cloudflare
 * compat endpoint (`/compat/`).
 */
export function isOpenRouterModel(resolvedModel: string): boolean {
  return !resolvedModel.startsWith("dynamic/");
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
    _options?: unknown,
  ): Promise<unknown> {
    const { model: inputModel, input: sanitizedInput } =
      extractModelFromInput(input);
    const envDefault = resolveVirtualModel(this.env);

    // Resolve model: caller param → input body model → env default — first non-empty wins
    const picked = pickModel(model, inputModel, envDefault);
    const resolvedModelName = resolveModel(picked);

    const provider: GatewayProvider = isOpenRouterModel(resolvedModelName)
      ? "openrouter"
      : "compat";
    const access = await this.checkHostedModelAccess();
    const settings = resolveGatewaySettings(this.env);
    if (!settings) {
      throw new Error("AI Gateway is not configured for virtual AI.");
    }

    const startedAt = Date.now();
    const result = await runViaGatewayHTTP(
      settings,
      this.ctx.props,
      sanitizedInput,
      resolvedModelName,
      provider,
    );
    const record = (usage: ExtractedUsage) =>
      this.recordUsage(usage, provider, Date.now() - startedAt, access.creditChargeable).catch((error) => {
        console.error("[AIVirtualBinding] failed to record usage", error);
      });
    if (result instanceof ReadableStream) {
      const [clientStream, usageStream] = result.tee();
      this.ctx.waitUntil(
        extractStreamingUsage(usageStream, resolvedModelName).then((usage) =>
          usage ? record(usage) : undefined,
        ),
      );
      return clientStream;
    }
    const usage = extractJsonUsage(result, resolvedModelName);
    if (usage) {
      this.ctx.waitUntil(record(usage));
    }
    return result;
  }

  /**
   * Generate images from a text prompt. Available at runtime on the virtual binding
   * (`env.AI.generateImage` in `js_exec`). In deployed user-worker TypeScript, import
   * `generateImage` from `workers/camelai-ai.ts` and call `generateImage(env.AI, ...)`
   * so code typechecks with standard Wrangler `Ai` types (only `run()` is declared).
   *
   * Prefer this over `run("auto_image", ...)` — it returns parsed image data URLs
   * instead of the raw gateway payload. `workers-ai-provider` / `generateText()`
   * with `auto_image` drops images; do not use those for image generation.
   */
  async generateImage(
    input: string | GenerateImageOptions,
  ): Promise<GenerateImageResult> {
    const messages = buildGenerateImageMessages(input);
    const raw = await this.run("auto_image", { messages });
    if (raw instanceof ReadableStream) {
      throw new Error("generateImage does not support streaming responses");
    }
    return parseGenerateImageResponse(raw);
  }

  private async checkHostedModelAccess(): Promise<{ creditChargeable: boolean }> {
    const orgStub = this.env.ORG.get(this.env.ORG.idFromName(this.ctx.props.orgId));
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
    await ensureLegacyHostUsageBackfilled(this.env, this.ctx.props.orgId);
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

  private async recordUsage(
    usage: ExtractedUsage,
    gatewayProvider: GatewayProvider,
    durationMs: number,
    creditChargeable: boolean,
  ): Promise<void> {
    const orgStub = this.env.ORG.get(this.env.ORG.idFromName(this.ctx.props.orgId));
    await orgStub.recordUsage({
      workspace_id: this.ctx.props.workspaceId,
      user_id: this.ctx.props.userId ?? "",
      thread_id: "virtual-ai",
      model: usage.model,
      provider: gatewayProvider === "openrouter" ? "openrouter" : "openai",
      billing_source: "hosted",
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
}

export function resolveVirtualModel(
  env: Pick<AIVirtualBindingEnv, "AI_VIRTUAL_MODEL">,
): string {
  const configured = env.AI_VIRTUAL_MODEL?.trim();
  return configured || DEFAULT_VIRTUAL_MODEL;
}

function pickModel(...candidates: (string | undefined)[]): string {
  for (const c of candidates) {
    const trimmed = c?.trim();
    if (trimmed) return trimmed;
  }
  return DEFAULT_VIRTUAL_MODEL;
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

export async function runViaGatewayHTTP(
  settings: GatewaySettings,
  props: AIVirtualBindingProps,
  input: unknown,
  model: string = "dynamic/auto",
  provider: GatewayProvider = "compat",
): Promise<unknown> {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${settings.authToken}`);
  headers.set("Content-Type", "application/json");
  headers.set("cf-aig-metadata", buildGatewayMetadata(props));
  const payload = toGatewayPayload(
    input,
    provider === "openrouter" ? openRouterNitroModel(model) : model,
  );

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

function openRouterNitroModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) return model;
  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith("dynamic/") ||
    lower.startsWith("google/gemini-") ||
    lower.startsWith("deepseek/deepseek-v4-") ||
    lower.startsWith("anthropic/claude-opus-4.") ||
    lower.endsWith(":nitro")
  ) {
    return trimmed;
  }
  const lastSegment = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  if (lastSegment.includes(":")) {
    return trimmed;
  }
  return `${trimmed}:nitro`;
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

export interface GenerateImageOptions {
  prompt: string;
  /** Optional reference image (URL or `data:image/...` data URL) for style consistency. */
  referenceImageUrl?: string;
}

export interface GeneratedImage {
  dataUrl: string;
  index: number;
}

export interface GenerateImageResult {
  text: string | null;
  imageDataUrl: string | null;
  images: GeneratedImage[];
}

export function buildGenerateImageMessages(
  input: string | GenerateImageOptions,
): Array<{ role: "user"; content: string | Array<Record<string, unknown>> }> {
  const options = typeof input === "string" ? { prompt: input } : input;
  const prompt = options.prompt?.trim();
  if (!prompt) {
    throw new Error("generateImage requires a non-empty prompt");
  }

  const referenceImageUrl = options.referenceImageUrl?.trim();
  if (!referenceImageUrl) {
    return [{ role: "user", content: prompt }];
  }

  return [
    {
      role: "user",
      content: [
        {
          type: "image_url",
          image_url: { url: referenceImageUrl },
        },
        { type: "text", text: prompt },
      ],
    },
  ];
}

export function parseGenerateImageResponse(
  payload: unknown,
): GenerateImageResult {
  const empty: GenerateImageResult = {
    text: null,
    imageDataUrl: null,
    images: [],
  };
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return empty;
  }

  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return empty;
  }

  const firstChoice = choices[0];
  if (!firstChoice || typeof firstChoice !== "object") {
    return empty;
  }

  const message = (firstChoice as { message?: unknown }).message;
  if (!message || typeof message !== "object") {
    return empty;
  }

  const msg = message as Record<string, unknown>;
  const text =
    typeof msg.content === "string" && msg.content.trim()
      ? msg.content.trim()
      : null;

  const images: GeneratedImage[] = [];
  const rawImages = msg.images;
  if (Array.isArray(rawImages)) {
    for (const [fallbackIndex, item] of rawImages.entries()) {
      const dataUrl = extractGeneratedImageDataUrl(item);
      if (!dataUrl) continue;
      const index =
        item && typeof item === "object" && typeof (item as { index?: unknown }).index === "number"
          ? (item as { index: number }).index
          : fallbackIndex;
      images.push({ dataUrl, index });
    }
  }

  images.sort((a, b) => a.index - b.index);
  return {
    text,
    imageDataUrl: images[0]?.dataUrl ?? null,
    images,
  };
}

function extractGeneratedImageDataUrl(item: unknown): string | null {
  if (!item || typeof item !== "object") return null;
  const imageUrl = (item as { image_url?: unknown }).image_url;
  if (!imageUrl || typeof imageUrl !== "object") return null;
  const url = (imageUrl as { url?: unknown }).url;
  return typeof url === "string" && url.trim() ? url.trim() : null;
}

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
