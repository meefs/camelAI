/**
 * The one model route chiridion still forwards: the org's ChatGPT (Codex)
 * subscription, whose OAuth token only chiridion holds and refreshes. The
 * runtime's Pi Codex client posts `<endpoint>/openai-codex/codex/responses`
 * (SSE, the body zstd-compressed) with its identity token and a placeholder
 * account id; chiridion swaps in the subscription's token and account and
 * sends the bytes on to the Codex backend (or chiridion's Codex proxy).
 * Usage comes back from the runtime by webhook, like every other route's.
 */
import type { PiResolvedModelConfig } from "../chat-thread/pi-model-config";

export interface CodexRoute {
  /** The model id the runtime's agent has (and a plain body names). */
  modelId: string;
  /** The Codex backend root (`https://chatgpt.com/backend-api`) or the proxy's. */
  upstreamBase: string;
  /** The subscription's access token, freshly refreshed by the resolver. */
  credential: string;
  /** The ChatGPT account the token belongs to. */
  accountId: string;
  /** Extra headers (chiridion's Codex proxy token). */
  headers: Record<string, string>;
}

/** The ChatGPT account id in a Codex access token (the claim Codex clients read). */
export function codexAccountId(accessToken: string): string | null {
  try {
    const [, payload] = accessToken.split(".");
    if (!payload) return null;
    const claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
    const auth = claims["https://api.openai.com/auth"];
    const accountId = auth && typeof auth === "object" ? (auth as Record<string, unknown>).chatgpt_account_id : undefined;
    return typeof accountId === "string" && accountId ? accountId : null;
  } catch {
    return null;
  }
}

/** The Codex route for a thread resolved to the org's ChatGPT subscription, else null. */
export function codexRoute(config: PiResolvedModelConfig): CodexRoute | null {
  const { model } = config;
  if (model.provider !== "openai-codex" || config.billingSource !== "byok" || !config.apiKey) return null;
  const accountId = codexAccountId(config.apiKey);
  if (!accountId) return null;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries((model.headers ?? {}) as Record<string, string | null>)) {
    if (typeof value === "string" && value && !/^(authorization|x-api-key)$/i.test(name)) headers[name] = value;
  }
  return {
    modelId: model.id,
    upstreamBase: model.baseUrl.replace(/\/+$/, "").replace(/\/codex$/, ""),
    credential: config.apiKey,
    accountId,
    headers,
  };
}

/** Request headers the Codex backend gets from the runtime's request; the runtime's auth is dropped. */
const FORWARDED_REQUEST_HEADERS = new Set([
  "content-type",
  "content-encoding",
  "accept",
  "openai-beta",
  "originator",
  "session-id",
  "x-client-request-id",
  "user-agent",
]);

export type UpstreamCall = { url: string; headers: Headers } | { error: string };

/**
 * Where a call to `<endpoint>/openai-codex/<rest>` goes and with which headers,
 * or why it is refused. A compressed body (the runtime sends zstd, which
 * Workers cannot read) is not checked for its model; the agent's model is one
 * only chiridion configures. A plain body must name the route's model.
 */
export function codexUpstreamCall(
  route: CodexRoute,
  rest: string,
  search: string,
  incoming: Iterable<[string, string]>,
  body: Uint8Array,
): UpstreamCall {
  const headers = new Headers();
  let encoded = false;
  for (const [name, value] of incoming) {
    const lower = name.toLowerCase();
    if (FORWARDED_REQUEST_HEADERS.has(lower)) headers.set(name, value);
    if (lower === "content-encoding" && value.trim() && value.trim().toLowerCase() !== "identity") encoded = true;
  }
  if (!/^codex\/responses$/.test(rest)) return { error: `Not a Codex call: ${rest}` };
  if (!encoded) {
    let model: unknown;
    try {
      const text = new TextDecoder().decode(body);
      model = text ? (JSON.parse(text) as { model?: unknown }).model : undefined;
    } catch {
      return { error: "The body must be JSON" };
    }
    if (model !== route.modelId) return { error: `This thread's model is ${route.modelId}, not ${String(model)}` };
  }
  for (const [name, value] of Object.entries(route.headers)) headers.set(name, value);
  headers.set("Authorization", `Bearer ${route.credential}`);
  headers.set("chatgpt-account-id", route.accountId);
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

/** A refusal in OpenAI's error shape, which the runtime's Codex client reads. */
export function codexError(status: number, message: string, code: string): Response {
  return Response.json({ error: { message, type: code, code } }, { status });
}
