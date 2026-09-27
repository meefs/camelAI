/**
 * The hosted agent runtime's usage webhook: one POST per model response of
 * chiridion's runtime agents (Standard Webhooks, signed with
 * AGENT_RUNTIME_WEBHOOK_SECRET, delivered at least once from the runtime's
 * outbox). Each becomes a usage_log row of the org in the agent's `context`,
 * as the acting user (actor, else subject), idempotent by the event `id`.
 * Billing follows the key scope: `hosted` is camelAI's (credit-chargeable
 * unless the org is enterprise or it is the free tier's model), an org scope
 * or the Codex forwarder is the org's own (BYOK).
 */
import type { Env, RouteContext } from "../types.js";
import { FREE_TIER_RUNTIME_MODEL, RUNTIME_MODEL_ENDPOINT } from "../agent-runtime/model-routes.js";
import { HOSTED_KEY_SCOPE } from "../agent-runtime/key-scopes.js";

const TOLERANCE_SECONDS = 5 * 60;

export interface RuntimeUsageEvent {
  id: string;
  agent: string;
  requestId?: string;
  tenant: string;
  subject?: string;
  actor?: string;
  context?: Record<string, unknown>;
  keyScope?: string | null;
  provider: string;
  model: string;
  kind?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  cost?: { usd?: number; source?: "provider" | "catalog" };
  at?: number;
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Standard Webhooks: `v1,<base64 HMAC-SHA256("<id>.<timestamp>.<body>")>` under the `whsec_` secret. */
export async function verifyStandardWebhook(
  secret: string,
  headers: Headers,
  body: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signatures = headers.get("webhook-signature");
  if (!id || !timestamp || !signatures || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > TOLERANCE_SECONDS) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    base64ToBytes(secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = bytesToBase64(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`))));
  return signatures.split(" ").some((entry) => {
    const [version, signature] = entry.split(",", 2);
    if (version !== "v1" || !signature || signature.length !== expected.length) return false;
    let diff = 0;
    for (let index = 0; index < expected.length; index++) diff |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
    return diff === 0;
  });
}

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

/** The usage_log row an event becomes (the provider and model as chiridion names them). */
export function usageRowFor(event: RuntimeUsageEvent, org: { billing_status?: unknown } | null) {
  const hosted = event.keyScope === HOSTED_KEY_SCOPE;
  let provider = text(event.provider);
  let model = text(event.model);
  // The Codex forwarder is a tenant endpoint: `chiridion/openai-codex/<model>`.
  if (provider === RUNTIME_MODEL_ENDPOINT && model.startsWith("openai-codex/")) {
    provider = "openai";
    model = model.slice("openai-codex/".length);
  }
  // chiridion's usage and pricing name Bedrock `bedrock`.
  if (provider === "amazon-bedrock") provider = "bedrock";
  const freeTier = `${provider}/${model}` === FREE_TIER_RUNTIME_MODEL;
  const context = event.context ?? {};
  return {
    workspace_id: text(context.workspace),
    // The runtime reports the agent itself as subject when it has none.
    user_id: text(event.actor) || (text(event.subject) !== text(event.agent) ? text(event.subject) : ""),
    thread_id: text(context.thread),
    model: model || "unknown",
    provider: provider || "unknown",
    billing_source: hosted ? "hosted" : "byok",
    credit_chargeable: hosted && !freeTier && org?.billing_status !== "enterprise",
    usage_kind: "llm",
    usage_surface: event.kind === "compaction" ? "compaction" : "agent",
    input_tokens: count(event.input),
    output_tokens: count(event.output),
    cache_creation_input_tokens: count(event.cacheWrite),
    cache_read_input_tokens: count(event.cacheRead),
    ...(typeof event.cost?.usd === "number" && event.cost.usd > 0
      ? event.cost.source === "provider"
        ? { reported_cost_usd: event.cost.usd }
        : { estimated_cost_usd: event.cost.usd }
      : {}),
    duration_ms: 0,
    created_at_ms: typeof event.at === "number" ? event.at : Date.now(),
    source: "agent_runtime",
    source_id: text(event.id),
  };
}

export async function handleAgentRuntimeUsageRequest(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
  const secret = env.AGENT_RUNTIME_WEBHOOK_SECRET?.trim();
  if (!secret) return Response.json({ error: "Usage webhook is not configured" }, { status: 503 });
  const body = await req.text();
  if (!await verifyStandardWebhook(secret, req.headers, body)) {
    return Response.json({ error: "Invalid webhook signature" }, { status: 401 });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const events = (Array.isArray(parsed) ? parsed : [parsed]) as RuntimeUsageEvent[];
  const expectedTenant = env.AGENT_RUNTIME_TENANT?.trim();
  for (const event of events) {
    const orgId = text(event?.context?.org);
    // Nothing chiridion can bill: acknowledge so the runtime stops retrying, and say why.
    if (!event || !text(event.id) || !orgId || (expectedTenant && event.tenant !== expectedTenant)) {
      console.warn("[agent-runtime-usage] ignored usage event", { id: event?.id, tenant: event?.tenant, orgId });
      continue;
    }
    const org = env.ORG.get(env.ORG.idFromName(orgId));
    const info = await org.getInfo();
    // Idempotent by (source, source_id): a redelivery finds the row and inserts nothing.
    await org.recordUsage(usageRowFor(event, info));
  }
  return new Response(null, { status: 204 });
}

export async function handleAgentRuntimeUsage({ req, env }: RouteContext): Promise<Response> {
  return handleAgentRuntimeUsageRequest(req, env);
}
