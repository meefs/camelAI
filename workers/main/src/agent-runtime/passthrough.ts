/**
 * The model-call forwarder for the hosted agent runtime (the AI Gateway
 * pattern): the runtime's own Pi client speaks a provider's native protocol to
 * `<base>/<provider>/…`; chiridion checks the call against the thread's
 * resolved route, swaps the runtime's credentials for the route's real ones,
 * forwards the body untouched and streams the answer back untouched, reading
 * the provider's usage out of it on the way for metering.
 *
 * Supported routes: the hosted AI Gateway's openrouter/anthropic/openai
 * providers; BYOK OpenRouter, Anthropic and OpenAI keys; BYOK Bedrock (Claude,
 * with the org's Bedrock API key). The Codex subscription, custom endpoints,
 * self-host providers, Bedrock OpenAI models and the gateway's `compat`
 * dynamic routes are not (their threads stay on the in-DO loop).
 */
import type { PiResolvedModelConfig } from "../chat-thread/pi-model-config";

/** A provider id the runtime's Pi client knows, and the model id it must send. */
export interface PassthroughRoute {
  /** Pi provider id: the path segment after the forwarder's base, and the runtime model's provider. */
  provider: "openrouter" | "anthropic" | "openai" | "amazon-bedrock";
  /** The upstream model id, exactly as the provider takes it (and the runtime sends it). */
  modelId: string;
  /**
   * Where the runtime's `<rest>` goes. `direct`: the provider's own API at the
   * base the runtime's client assumes. `gateway`: the AI Gateway's URL for the
   * provider (OpenRouter's gateway prefix is its `/api/v1`). `bedrock`: the
   * regional bedrock-runtime endpoint, `<rest>` starting with the region.
   */
  kind: "direct" | "gateway" | "bedrock";
  upstreamBase: string;
  /** The route's secret: an API key, the gateway token, or a Bedrock API key. */
  credential: string;
  /** Extra headers the route sends (gateway metadata, OpenRouter attribution). */
  headers: Record<string, string>;
  /** Bedrock: the org's region. */
  region?: string;
}

/** The provider base URLs the runtime's clients assume under `<endpoint>/<provider>`. */
export const DIRECT_BASES = {
  openrouter: "https://openrouter.ai/api",
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
} as const;

function isGatewayProvider(value: unknown): value is keyof typeof DIRECT_BASES {
  return value === "openrouter" || value === "anthropic" || value === "openai";
}

function presentHeaders(headers: Record<string, string | null | undefined> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (typeof value === "string" && value.length > 0 && !/^(authorization|x-api-key)$/i.test(name)) out[name] = value;
  }
  return out;
}

/** The runtime model id for a route: `chiridion/<provider>/<model id>`. */
export function runtimeModelFor(endpoint: string, route: Pick<PassthroughRoute, "provider" | "modelId">): string {
  return `${endpoint}/${route.provider}/${route.modelId}`;
}

/**
 * The pass-through route for a thread's resolved model, or null when it has
 * none: the Codex subscription (skipped: its client derives account headers
 * from the OAuth token itself), custom endpoints, self-host providers, Bedrock
 * OpenAI models and the gateway's `compat` dynamic routes.
 */
export function passthroughRoute(config: PiResolvedModelConfig): PassthroughRoute | null {
  const { model } = config;
  const extra = presentHeaders(model.headers as Record<string, string | null> | undefined);
  if (model.provider === "cloudflare-ai-gateway") {
    // The gateway holds the provider keys; it takes its own token.
    if (!isGatewayProvider(config.usageProvider)) return null;
    return {
      provider: config.usageProvider,
      modelId: model.id,
      kind: "gateway",
      upstreamBase: model.baseUrl.replace(/\/+$/, ""),
      credential: config.apiKey,
      headers: extra,
    };
  }
  if (config.billingSource !== "byok" || !config.apiKey) return null;
  if (config.usageProvider === "bedrock") {
    // Bedrock Claude (chiridion's own loop uses the Anthropic-compatible
    // bedrock-mantle endpoint; the runtime uses Converse on bedrock-runtime).
    const region = /^https:\/\/bedrock-mantle\.([a-z0-9-]+)\.api\.aws\/anthropic\/?$/.exec(model.baseUrl)?.[1];
    if (!region || model.api !== "anthropic-messages") return null;
    return {
      provider: "amazon-bedrock",
      modelId: model.id,
      kind: "bedrock",
      upstreamBase: `https://bedrock-runtime.${region}.amazonaws.com`,
      credential: config.apiKey,
      headers: {},
      region,
    };
  }
  const provider = config.usageProvider;
  if (!isGatewayProvider(provider)) return null;
  // Only a provider's own endpoint (Codex and custom routes have their own).
  if (provider !== "openrouter" && model.provider !== provider) return null;
  if (provider === "openrouter" && !/^https:\/\/openrouter\.ai\/api(\/v1)?\/?$/.test(model.baseUrl)) return null;
  return {
    provider,
    modelId: model.id,
    kind: "direct",
    upstreamBase: DIRECT_BASES[provider],
    credential: config.apiKey,
    headers: extra,
  };
}

export type UpstreamCall =
  | { url: string; headers: Headers }
  | { error: string };

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

/**
 * Where a call to `<endpoint>/<route.provider>/<rest>` goes and with which
 * headers, or why it is refused: its model (the body's `model`, or for
 * Bedrock the one in the path) must be the route's. The runtime's key goes in
 * the header its client used (`x-api-key` or `Authorization`); the real
 * credential replaces it there, or goes in the gateway's own header.
 */
export function upstreamCall(
  route: PassthroughRoute,
  rest: string,
  search: string,
  incoming: Iterable<[string, string]>,
  body: string,
): UpstreamCall {
  const headers = new Headers();
  let keyHeader: "x-api-key" | "authorization" | null = null;
  for (const [name, value] of incoming) {
    const lower = name.toLowerCase();
    if (FORWARDED_REQUEST_HEADERS.has(lower)) headers.set(name, value);
    if (lower === "x-api-key") keyHeader = "x-api-key";
    if (lower === "authorization" && !keyHeader) keyHeader = "authorization";
  }
  for (const [name, value] of Object.entries(route.headers)) headers.set(name, value);

  if (route.kind === "bedrock") {
    const match = /^([a-z0-9-]+)\/model\/([^/]+)\/(converse|converse-stream|invoke|invoke-with-response-stream)$/.exec(rest);
    if (!match) return { error: `Not a Bedrock model call: ${rest}` };
    const [, region, encodedModel, action] = match;
    if (region !== route.region) return { error: `This thread's Bedrock region is ${route.region}, not ${region}` };
    const modelId = decodeURIComponent(encodedModel);
    if (modelId !== route.modelId) return { error: `This thread's model is ${route.modelId}, not ${modelId}` };
    // chiridion's Bedrock credential is a Bedrock API key, which bedrock-runtime takes as a bearer token.
    headers.set("Authorization", `Bearer ${route.credential}`);
    return { url: `${route.upstreamBase}/model/${encodeURIComponent(modelId)}/${action}${search}`, headers };
  }

  let model: unknown;
  try {
    model = body ? (JSON.parse(body) as { model?: unknown }).model : undefined;
  } catch {
    return { error: "The body must be JSON" };
  }
  if (model !== route.modelId) return { error: `This thread's model is ${route.modelId}, not ${String(model)}` };

  if (route.kind === "gateway") {
    headers.set("cf-aig-authorization", `Bearer ${route.credential}`);
    // OpenRouter's gateway prefix is its /api/v1; the runtime's paths start below /api.
    const path = route.provider === "openrouter" ? rest.replace(/^v1\//, "") : rest;
    return { url: `${route.upstreamBase}/${path}${search}`, headers };
  }
  if (keyHeader === "x-api-key" || (!keyHeader && route.provider === "anthropic")) {
    headers.set("x-api-key", route.credential);
  } else {
    headers.set("Authorization", `Bearer ${route.credential}`);
  }
  return { url: `${route.upstreamBase}/${rest}${search}`, headers };
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
  // Bedrock Converse: the stream's `metadata` event (and a whole Converse body) has usage.
  if (isRecord(value.usage) && typeof value.usage.inputTokens === "number") {
    const usage = value.usage;
    return {
      input: num(usage.inputTokens),
      output: num(usage.outputTokens),
      cacheRead: num(usage.cacheReadInputTokens),
      cacheWrite: num(usage.cacheWriteInputTokens),
      reasoning: 0,
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
  if (contentType.includes("application/vnd.amazon.eventstream")) return readEventStreamUsage(body);
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

/**
 * AWS event-stream framing (Bedrock's converse-stream): each message is a
 * 12-byte prelude (total length, headers length, CRC), headers, a JSON
 * payload and a 4-byte CRC. Only the payloads matter here.
 */
export function eventStreamPayloads(bytes: Uint8Array): { payloads: unknown[]; rest: Uint8Array } {
  const payloads: unknown[] = [];
  let offset = 0;
  while (bytes.length - offset >= 12) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
    const total = view.getUint32(0);
    const headersLength = view.getUint32(4);
    if (total < 16 || bytes.length - offset < total) break;
    const payload = bytes.subarray(offset + 12 + headersLength, offset + total - 4);
    try {
      payloads.push(JSON.parse(new TextDecoder().decode(payload)));
    } catch {
      // Not JSON (or empty): no usage in it.
    }
    offset += total;
  }
  return { payloads, rest: bytes.subarray(offset) };
}

async function readEventStreamUsage(body: ReadableStream<Uint8Array>): Promise<ProviderUsage | null> {
  let seen: ProviderUsage | null = null;
  let pending: Uint8Array = new Uint8Array(0);
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    const joined = new Uint8Array(pending.length + chunk.length);
    joined.set(pending);
    joined.set(chunk, pending.length);
    const { payloads, rest } = eventStreamPayloads(joined);
    for (const payload of payloads) seen = foldUsage(seen, payload);
    pending = rest.slice();
  }
  return seen;
}
