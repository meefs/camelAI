/**
 * The hosted agent runtime's tenant API, as chiridion's operator: key scopes
 * (the provider keys agents of a scope call providers with) and per-agent
 * configuration (model, key scope, spend limit).
 */
export interface RuntimeApiEnv {
  AGENT_RUNTIME_URL?: string;
  AGENT_RUNTIME_API_TOKEN?: string;
}

export class RuntimeApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "RuntimeApiError";
  }
}

export function runtimeUrl(env: RuntimeApiEnv): string {
  return (env.AGENT_RUNTIME_URL || "https://agents.camelai.dev").replace(/\/+$/, "");
}

export async function runtimeApi(
  env: RuntimeApiEnv,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
  fetcher: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
): Promise<unknown> {
  const response = await fetcher(`${runtimeUrl(env)}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.AGENT_RUNTIME_API_TOKEN ?? ""}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    const message = parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string"
      ? (parsed as { error: string }).error
      : text.slice(0, 500);
    throw new RuntimeApiError(`Agent runtime ${method} ${path.split("?")[0]}: HTTP ${response.status} ${message}`, response.status);
  }
  return parsed;
}

/**
 * A provider entry of a key scope: the key, and for a gateway its base URL
 * and sealed extra headers. A gateway that authenticates by header alone takes
 * no key (the runtime then sends no Authorization/x-api-key).
 */
export interface KeyScopeProvider {
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}

export function putKeyScopeProvider(
  env: RuntimeApiEnv,
  scope: string,
  provider: string,
  entry: KeyScopeProvider,
  fetcher?: typeof globalThis.fetch,
) {
  return runtimeApi(env, "PUT", `/v1/key-scopes/${encodeURIComponent(scope)}/providers/${encodeURIComponent(provider)}`, entry, {}, fetcher);
}

export async function deleteKeyScope(env: RuntimeApiEnv, scope: string, fetcher?: typeof globalThis.fetch) {
  try {
    await runtimeApi(env, "DELETE", `/v1/key-scopes/${encodeURIComponent(scope)}`, undefined, {}, fetcher);
  } catch (error) {
    if (!(error instanceof RuntimeApiError && error.status === 404)) throw error;
  }
}
