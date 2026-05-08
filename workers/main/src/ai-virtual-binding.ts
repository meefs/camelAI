import { WorkerEntrypoint } from "cloudflare:workers";

interface AIVirtualBindingEnv {
  SANDBOX_HOST?: Fetcher;
  SANDBOX_PROXY_SECRET?: string;
  WORKER_BASE_URL?: string;
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
  "gemini-3-flash-preview": "google/gemini-3-flash-preview",
  "gemini-3.1-pro-preview": "google/gemini-3.1-pro-preview",
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

    if (!this.env.SANDBOX_HOST) {
      throw new Error("Sandbox host binding is not configured for virtual AI.");
    }

    const provider: GatewayProvider = isOpenRouterModel(resolvedModelName)
      ? "openrouter"
      : "compat";
    return runViaSandboxHostVirtualAI(
      this.env.SANDBOX_HOST,
      this.env.SANDBOX_PROXY_SECRET,
      this.env.WORKER_BASE_URL,
      this.ctx.props,
      sanitizedInput,
      resolvedModelName,
      provider,
    );
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

export async function runViaSandboxHostVirtualAI(
  sandboxHost: Fetcher,
  sandboxProxySecret: string | undefined,
  workerBaseURL: string | undefined,
  props: AIVirtualBindingProps,
  input: unknown,
  model: string = "dynamic/auto",
  provider: GatewayProvider = "compat",
): Promise<unknown> {
  const headers = new Headers();
  headers.set("Content-Type", "application/json");
  headers.set("x-chiridion-org-id", props.orgId);
  headers.set("x-chiridion-workspace-id", props.workspaceId);
  if (sandboxProxySecret?.trim()) {
    headers.set("x-sandbox-secret", sandboxProxySecret.trim());
  }
  if (workerBaseURL?.trim()) {
    headers.set("x-chiridion-worker-base-url", workerBaseURL.trim());
  }
  if (props.userId?.trim()) {
    headers.set("x-chiridion-user-id", props.userId.trim());
  }

  const payload = toGatewayPayload(
    input,
    provider === "openrouter" ? openRouterNitroModel(model) : model,
  );
  const resp = await sandboxHost.fetch(
    "http://sandbox/v1/virtual-ai/chat/completions",
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
      extractErrorMessage(responsePayload) ??
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

function extractErrorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const message = (payload as { error?: unknown }).error;
  return typeof message === "string" && message.trim() ? message : undefined;
}
