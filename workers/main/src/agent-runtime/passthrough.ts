/**
 * The model-call forwarder for the hosted agent runtime (the AI Gateway
 * pattern): the runtime's own Pi client speaks a provider's native protocol to
 * `<base>/<provider>/…`; chiridion checks the call against the thread's
 * resolved route, swaps the runtime's credentials for the route's real ones,
 * forwards the body untouched and streams the answer back untouched, reading
 * the provider's usage out of it on the way for metering.
 *
 * Supported routes: the hosted AI Gateway's openrouter/anthropic/openai
 * providers, and BYOK OpenRouter, Anthropic and OpenAI keys. Bedrock, the
 * Codex subscription, custom endpoints, self-host providers and the gateway's
 * `compat` dynamic routes are not (their threads stay on the in-DO loop).
 */
import type { PiResolvedModelConfig } from "../chat-thread/pi-model-config";

/** A provider id the runtime's Pi client knows, and the model id it must send. */
export interface PassthroughRoute {
  /** Pi provider id: the path segment after the proxy's base, and the runtime model's provider. */
  provider: "openrouter" | "anthropic" | "openai";
  /** The upstream model id, exactly as the provider takes it (and the runtime sends it). */
  modelId: string;
  /** The provider's real base URL: `<base>/<provider>/<rest>` goes to `<upstreamBase>/<rest>`. */
  upstreamBase: string;
  /** The route's credential and extra headers (gateway auth and metadata, attribution). */
  headers: Record<string, string>;
}

const DIRECT_BASES: Record<PassthroughRoute["provider"], string> = {
  openrouter: "https://openrouter.ai/api/v1",
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
};

function isPassthroughProvider(value: unknown): value is PassthroughRoute["provider"] {
  return value === "openrouter" || value === "anthropic" || value === "openai";
}

function presentHeaders(headers: Record<string, string | null | undefined> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (typeof value === "string" && value.length > 0) out[name] = value;
  }
  return out;
}

/** The credential header a provider takes a key in. */
function credential(provider: PassthroughRoute["provider"], key: string): Record<string, string> {
  return provider === "anthropic" ? { "x-api-key": key } : { Authorization: `Bearer ${key}` };
}

/** The runtime model id for a route: `chiridion/<provider>/<model id>`. */
export function runtimeModelFor(endpoint: string, route: Pick<PassthroughRoute, "provider" | "modelId">): string {
  return `${endpoint}/${route.provider}/${route.modelId}`;
}

/** The pass-through route for a thread's resolved model, or null when it has none. */
export function passthroughRoute(config: PiResolvedModelConfig): PassthroughRoute | null {
  const { model } = config;
  const extra = presentHeaders(model.headers as Record<string, string | null> | undefined);
  if (model.provider === "cloudflare-ai-gateway") {
    // The gateway holds the provider keys; it takes its own token.
    if (!isPassthroughProvider(config.usageProvider)) return null;
    // A provider's own auth headers never go to the gateway.
    delete extra.Authorization;
    delete extra["x-api-key"];
    return {
      provider: config.usageProvider,
      modelId: model.id,
      upstreamBase: model.baseUrl.replace(/\/+$/, ""),
      headers: { ...extra, "cf-aig-authorization": `Bearer ${config.apiKey}` },
    };
  }
  if (config.billingSource !== "byok" || !config.apiKey) return null;
  const provider = config.usageProvider;
  if (!isPassthroughProvider(provider)) return null;
  // Only a provider's own endpoint: Bedrock, Codex and custom routes have their own.
  if (provider !== "openrouter" && model.provider !== provider) return null;
  if (provider === "openrouter" && !/^https:\/\/openrouter\.ai\/api(\/v1)?\/?$/.test(model.baseUrl)) return null;
  delete extra.Authorization;
  delete extra["x-api-key"];
  return {
    provider,
    modelId: model.id,
    upstreamBase: DIRECT_BASES[provider],
    headers: { ...extra, ...credential(provider, config.apiKey) },
  };
}

/** Request headers passed on to the provider; everything else (the runtime's auth, hop headers) is dropped. */
const FORWARDED_REQUEST_HEADERS = new Set([
  "content-type",
  "accept",
  "anthropic-version",
  "anthropic-beta",
  "openai-beta",
  "x-stainless-helper-method",
  "http-referer",
  "x-title",
]);

export function forwardedRequestHeaders(incoming: Iterable<[string, string]>, route: PassthroughRoute): Headers {
  const headers = new Headers();
  for (const [name, value] of incoming) {
    if (FORWARDED_REQUEST_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  }
  for (const [name, value] of Object.entries(route.headers)) headers.set(name, value);
  return headers;
}

const FORWARDED_RESPONSE_HEADERS = ["content-type", "cache-control", "retry-after", "request-id", "x-request-id"];

export function forwardedResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

/** Token usage read from a provider's answer, in Pi's terms (input excludes cache reads and writes). */
export interface ProviderUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  /** What the provider says the call cost (OpenRouter), in USD. */
  costUsd?: number;
  responseId?: string;
  responseModel?: string;
}

type JsonRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonRecord => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/**
 * Folds one parsed JSON value (an SSE event's data, or a whole non-streamed
 * body) into the usage seen so far. Knows OpenAI/OpenRouter Responses
 * (`response.completed`, or a response object), Anthropic Messages
 * (`message_start` + `message_delta`, or a message) and Chat Completions
 * (a `usage` alongside `choices`).
 */
export function foldUsage(seen: ProviderUsage | null, value: unknown): ProviderUsage | null {
  if (!isRecord(value)) return seen;
  // Responses: the final event carries the response; a non-streamed body is the response.
  const response = value.type === "response.completed" && isRecord(value.response) ? value.response
    : value.object === "response" ? value : null;
  if (response && isRecord(response.usage)) {
    const usage = response.usage;
    const cached = num(isRecord(usage.input_tokens_details) ? usage.input_tokens_details.cached_tokens : 0);
    return {
      input: Math.max(0, num(usage.input_tokens) - cached),
      output: num(usage.output_tokens),
      cacheRead: cached,
      cacheWrite: 0,
      reasoning: num(isRecord(usage.output_tokens_details) ? usage.output_tokens_details.reasoning_tokens : 0),
      ...(typeof usage.cost === "number" ? { costUsd: usage.cost } : {}),
      ...(typeof response.id === "string" ? { responseId: response.id } : {}),
      ...(typeof response.model === "string" ? { responseModel: response.model } : {}),
    };
  }
  // Anthropic: message_start has the input side; message_delta the running output count.
  const message = value.type === "message_start" && isRecord(value.message) ? value.message
    : value.type === "message" ? value : null;
  if (message && isRecord(message.usage)) {
    const usage = message.usage;
    return {
      input: num(usage.input_tokens),
      output: num(usage.output_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
      cacheWrite: num(usage.cache_creation_input_tokens),
      reasoning: 0,
      ...(typeof message.id === "string" ? { responseId: message.id } : {}),
      ...(typeof message.model === "string" ? { responseModel: message.model } : {}),
    };
  }
  if (value.type === "message_delta" && isRecord(value.usage)) {
    const usage = value.usage;
    const base = seen ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
    return {
      ...base,
      output: num(usage.output_tokens) || base.output,
      ...(typeof usage.input_tokens === "number" ? { input: usage.input_tokens } : {}),
      ...(typeof usage.cache_read_input_tokens === "number" ? { cacheRead: usage.cache_read_input_tokens } : {}),
      ...(typeof usage.cache_creation_input_tokens === "number" ? { cacheWrite: usage.cache_creation_input_tokens } : {}),
    };
  }
  // Chat Completions: the last chunk (or the body) has usage.
  if (isRecord(value.usage) && ("choices" in value || value.object === "chat.completion")) {
    const usage = value.usage;
    const cached = num(isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details.cached_tokens : 0);
    const written = num(isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details.cache_write_tokens : 0);
    return {
      input: Math.max(0, num(usage.prompt_tokens) - cached - written),
      output: num(usage.completion_tokens),
      cacheRead: cached,
      cacheWrite: written,
      reasoning: num(isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details.reasoning_tokens : 0),
      ...(typeof usage.cost === "number" ? { costUsd: usage.cost } : {}),
      ...(typeof value.id === "string" ? { responseId: value.id } : {}),
      ...(typeof value.model === "string" ? { responseModel: value.model } : {}),
    };
  }
  return seen;
}

/**
 * Reads a provider response body (SSE or JSON) for its usage. Runs on a tee of
 * the stream the runtime gets, so it never changes or delays it.
 */
export async function readUsage(body: ReadableStream<Uint8Array>, contentType: string): Promise<ProviderUsage | null> {
  const text = body.pipeThrough(new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>);
  let seen: ProviderUsage | null = null;
  if (!contentType.includes("text/event-stream")) {
    let whole = "";
    for await (const chunk of text) whole += chunk;
    try {
      return foldUsage(null, JSON.parse(whole));
    } catch {
      return null;
    }
  }
  let buffer = "";
  const flush = (line: string) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    try {
      seen = foldUsage(seen, JSON.parse(data));
    } catch {
      // A partial or non-JSON line carries no usage.
    }
  };
  for await (const chunk of text) {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf("\n")) !== -1) {
      flush(buffer.slice(0, end).replace(/\r$/, ""));
      buffer = buffer.slice(end + 1);
    }
  }
  flush(buffer);
  return seen;
}
