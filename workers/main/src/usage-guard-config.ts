export const USAGE_GUARD_TRACE_SAMPLING_RATE = 1;

export function normalizeDispatchScriptVersion(value: string): string {
  const trimmed = value.trim();
  return /^[0-9a-f-]{32,36}$/i.test(trimmed) ? trimmed.replaceAll("-", "").toLowerCase() : trimmed;
}

type WorkerObservability = Record<string, unknown> & {
  traces?: Record<string, unknown>;
};

/**
 * Durable Object row counters only exist in persisted automatic traces. This
 * policy is platform-owned: projects may keep their log preferences, but may
 * not disable or sample the traces used by the usage guard.
 */
export function withUsageGuardTracing<T extends Record<string, unknown>>(metadata: T): T {
  const observability = metadata.observability && typeof metadata.observability === "object" && !Array.isArray(metadata.observability)
    ? metadata.observability as WorkerObservability
    : {};
  const traces = observability.traces && typeof observability.traces === "object" && !Array.isArray(observability.traces)
    ? observability.traces
    : {};

  return {
    ...metadata,
    observability: {
      ...observability,
      enabled: true,
      traces: {
        ...traces,
        enabled: true,
        persist: true,
        head_sampling_rate: USAGE_GUARD_TRACE_SAMPLING_RATE,
      },
    },
  };
}

export function dispatchScriptVersionFromApiBody(body: unknown, dispatchScriptName?: string): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const outer = body as Record<string, unknown>;
  const result = outer.result && typeof outer.result === "object" && !Array.isArray(outer.result)
    ? outer.result as Record<string, unknown>
    : outer;
  const script = result.script && typeof result.script === "object" && !Array.isArray(result.script)
    ? result.script as Record<string, unknown>
    : undefined;
  for (const value of [
    script?.version_id,
    result.version_id,
    script?.deployment_id,
    result.deployment_id,
    script?.id,
    result.id,
  ]) {
    if (
      typeof value === "string" &&
      value.trim() &&
      (!dispatchScriptName || value.trim() !== dispatchScriptName)
    ) return normalizeDispatchScriptVersion(value);
  }
  return undefined;
}

export async function fetchDispatchScriptVersion(input: {
  accountId: string;
  dispatchNamespace: string;
  dispatchScriptName: string;
  apiToken: string;
  fetcher?: typeof fetch;
}): Promise<string> {
  const response = await (input.fetcher ?? fetch)(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(input.accountId)}` +
      `/workers/dispatch/namespaces/${encodeURIComponent(input.dispatchNamespace)}` +
      `/scripts/${encodeURIComponent(input.dispatchScriptName)}`,
    { headers: { Authorization: `Bearer ${input.apiToken}` } },
  );
  const body = await response.json<unknown>();
  if (!response.ok) throw new Error(`Failed to read deployed script version: HTTP ${response.status}`);
  const version = dispatchScriptVersionFromApiBody(body, input.dispatchScriptName);
  if (!version) throw new Error("Cloudflare script details returned no version id");
  return version;
}

export async function resolveUploadedDispatchScriptVersion(input: {
  uploadBody: unknown;
  accountId: string;
  dispatchNamespace: string;
  dispatchScriptName: string;
  apiToken: string;
  fetcher?: typeof fetch;
}): Promise<string> {
  const uploadedVersion = dispatchScriptVersionFromApiBody(input.uploadBody, input.dispatchScriptName);
  if (uploadedVersion) return uploadedVersion;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fetchDispatchScriptVersion(input);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Could not determine deployed script version");
}
