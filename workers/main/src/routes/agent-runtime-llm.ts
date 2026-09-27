/**
 * The hosted agent runtime's model endpoint for chiridion's tenant
 * (`modelEndpoints.chiridion.baseUrl` = `https://<host>/agent-runtime/llm`).
 * The runtime's Pi client speaks a provider's native protocol to
 * `/agent-runtime/llm/<provider>/<rest>`; this verifies the runtime identity
 * token (in `X-Agent-Runtime-Identity`), authorizes the caller like the MCP
 * server, and hands the call to the thread's ChatThreadDO
 * (`runtimeProviderRequest`), which gates, checks the route, injects the real
 * credential, forwards it untouched and meters it (agent-runtime/passthrough.ts).
 */
import { RuntimeTokenError, verifyRuntimeToken } from "@camelai/agent-runtime/server";
import type { Env, RouteContext } from "../types.js";
import { authorizeRuntimeIdentity } from "./agent-mcp.js";

export const AGENT_RUNTIME_LLM_BASE_PATH = "/agent-runtime/llm";
export const AGENT_RUNTIME_IDENTITY_HEADER = "X-Agent-Runtime-Identity";
const DEFAULT_RUNTIME = "https://agents.camelai.dev";

export interface AgentRuntimeLlmOptions {
  /** Where the runtime's keys are fetched from; tests pass `testRuntime().fetch`. */
  fetch?: typeof globalThis.fetch;
}

function error(status: number, message: string, code: string): Response {
  return Response.json({ error: { message, type: code, code } }, { status });
}

/** The base URL the runtime is configured with, which its tokens name as their audience. */
function audience(env: Env, req: Request): string {
  return env.AGENT_RUNTIME_LLM_AUDIENCE || `${new URL(req.url).origin}${AGENT_RUNTIME_LLM_BASE_PATH}`;
}

export async function handleAgentRuntimeLlmRequest(
  req: Request,
  env: Env,
  options: AgentRuntimeLlmOptions = {},
): Promise<Response> {
  const url = new URL(req.url);
  const match = /^\/agent-runtime\/llm\/([a-z0-9-]+)\/(.+)$/.exec(url.pathname);
  if (!match) return error(404, "Not found", "not_found");
  const [, provider, path] = match;
  const token = req.headers.get(AGENT_RUNTIME_IDENTITY_HEADER)?.trim();
  if (!token) return error(401, `No ${AGENT_RUNTIME_IDENTITY_HEADER} token`, "invalid_token");
  let identity: Awaited<ReturnType<typeof verifyRuntimeToken>>;
  try {
    identity = await verifyRuntimeToken(token, {
      runtime: env.AGENT_RUNTIME_URL || DEFAULT_RUNTIME,
      audience: audience(env, req),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  } catch (cause) {
    if (cause instanceof RuntimeTokenError) return error(401, cause.message, "invalid_token");
    throw cause;
  }
  const props = await authorizeRuntimeIdentity(env, identity);
  if ("error" in props) return error(403, props.error, "forbidden");
  const stub = env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(props.threadId ?? "")) as unknown as {
    runtimeProviderRequest(
      request: { provider: string; path: string; search: string; method: string; headers: [string, string][]; body: string },
      caller: { orgId: string; workspaceId: string; threadId: string; userId: string },
    ): Promise<Response>;
  };
  return stub.runtimeProviderRequest(
    {
      provider,
      path,
      search: url.search,
      method: req.method,
      headers: [...req.headers],
      body: req.method === "GET" || req.method === "HEAD" ? "" : await req.text(),
    },
    {
      orgId: props.orgId,
      workspaceId: props.workspaceId,
      threadId: props.threadId ?? "",
      userId: props.userId ?? "",
    },
  );
}

export async function handleAgentRuntimeLlm({ req, env }: RouteContext): Promise<Response> {
  return handleAgentRuntimeLlmRequest(req, env);
}
