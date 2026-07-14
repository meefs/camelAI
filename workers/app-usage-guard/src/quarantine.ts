import {
  dispatchScriptVersionFromApiBody,
  withUsageGuardTracing,
} from "../../main/src/usage-guard-config.js";

type ScriptSettings = {
  bindings?: Array<Record<string, unknown>>;
  compatibility_date?: string;
  compatibility_flags?: string[];
  tail_consumers?: Array<Record<string, unknown>>;
};

const QUARANTINE_MARKER = "CAMELAI_USAGE_GUARD_QUARANTINE";

function cloudflareResult<T>(body: unknown): T {
  if (!body || typeof body !== "object" || Array.isArray(body) || !("result" in body)) {
    throw new Error("Cloudflare API returned an invalid response");
  }
  return (body as { result: T }).result;
}

function isIdentifier(value: string): boolean {
  return /^[$A-Z_a-z][$\w]*$/.test(value);
}

export function quarantineModule(classNames: string[]): string {
  for (const className of classNames) {
    if (!isIdentifier(className)) throw new Error(`Unsafe Durable Object class name: ${className}`);
  }
  const exports = classNames.map((className) => `export { QuarantinedDurableObject as ${className} };`).join("\n");
  return `import { DurableObject } from "cloudflare:workers";

const NOTICE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>App temporarily paused</title><style>body{margin:0;background:#fafafa;color:#18181b;font:16px/1.55 system-ui,sans-serif}.card{max-width:600px;margin:12vh auto;padding:32px;border:1px solid #e4e4e7;border-radius:16px;background:#fff;box-shadow:0 12px 32px #0000000d}h1{margin:0 0 12px;font-size:28px}p{margin:8px 0;color:#52525b}.label{font-size:12px;font-weight:700;letter-spacing:.12em;color:#b45309}</style></head><body><main class="card"><div class="label">APP TEMPORARILY PAUSED</div><h1>This app needs an update</h1><p>camelAI paused this app after unusually high database usage.</p><p>The app data has been preserved. Its owner can restore service by deploying a version that uses fewer database reads and writes.</p></main></body></html>';

function suspendedResponse() {
  return new Response(NOTICE, {
    status: 503,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Retry-After": "300",
      "X-CamelAI-App-Status": "suspended",
    },
  });
}

class QuarantinedDurableObject extends DurableObject {
  async alarm() {}
  async fetch() {
    return suspendedResponse();
  }
}

${exports}

export default {
  async fetch() {
    return suspendedResponse();
  },
  async scheduled() {},
  async queue() {},
};
`;
}

export async function quarantineDispatchScript(input: {
  accountId: string;
  dispatchNamespace: string;
  scriptName: string;
  apiToken: string;
  expectedVersion: string;
  fetcher?: typeof fetch;
}): Promise<string> {
  const fetcher = input.fetcher ?? fetch;
  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(input.accountId)}` +
    `/workers/dispatch/namespaces/${encodeURIComponent(input.dispatchNamespace)}` +
    `/scripts/${encodeURIComponent(input.scriptName)}`;
  const settingsResponse = await fetcher(`${baseUrl}/settings`, {
    headers: { Authorization: `Bearer ${input.apiToken}` },
  });
  const settingsBody = await settingsResponse.json<unknown>();
  if (!settingsResponse.ok) throw new Error(`Failed to read script settings: HTTP ${settingsResponse.status}`);
  const settings = cloudflareResult<ScriptSettings>(settingsBody);
  const bindings = settings.bindings ?? [];
  const marker = bindings.find((binding) => binding.name === QUARANTINE_MARKER && binding.type === "plain_text");
  if (marker?.text === input.expectedVersion) return `quarantine:${input.expectedVersion}`;
  const detailsResponse = await fetcher(baseUrl, {
    headers: { Authorization: `Bearer ${input.apiToken}` },
  });
  const detailsBody = await detailsResponse.json<unknown>();
  if (!detailsResponse.ok) throw new Error(`Failed to read live script version: HTTP ${detailsResponse.status}`);
  const liveVersion = dispatchScriptVersionFromApiBody(detailsBody, input.scriptName);
  if (liveVersion !== input.expectedVersion) {
    throw new Error(`Refusing to quarantine stale deployment ${input.expectedVersion}; live version is ${liveVersion ?? "unknown"}`);
  }
  const classNames = bindings.flatMap((binding) => {
    if (binding.type !== "durable_object_namespace" || typeof binding.class_name !== "string" || binding.script_name) return [];
    return [binding.class_name];
  });
  const uploadableBindings = bindings.flatMap((binding) => {
    if (binding.type === "secret_text" || binding.type === "secret_key" || binding.name === QUARANTINE_MARKER) return [];
    if (binding.type === "durable_object_namespace" && typeof binding.class_name === "string" && !binding.script_name) {
      return [binding];
    }
    return typeof binding.name === "string" ? [{ type: "inherit", name: binding.name }] : [];
  });
  uploadableBindings.push({ type: "plain_text", name: QUARANTINE_MARKER, text: input.expectedVersion });
  const metadata = withUsageGuardTracing({
    main_module: "usage-guard-quarantine.js",
    compatibility_date: settings.compatibility_date ?? "2026-07-13",
    ...(settings.compatibility_flags ? { compatibility_flags: settings.compatibility_flags } : {}),
    bindings: uploadableBindings,
    keep_bindings: ["secret_text", "secret_key"],
    keep_assets: true,
    ...(settings.tail_consumers ? { tail_consumers: settings.tail_consumers } : {}),
  });
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append(
    "usage-guard-quarantine.js",
    new Blob([quarantineModule([...new Set(classNames)])], { type: "application/javascript+module" }),
    "usage-guard-quarantine.js",
  );
  const uploadResponse = await fetcher(baseUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${input.apiToken}` },
    body: form,
  });
  const uploadBody = await uploadResponse.json<unknown>();
  if (!uploadResponse.ok) throw new Error(`Failed to upload quarantine: HTTP ${uploadResponse.status}`);
  return dispatchScriptVersionFromApiBody(uploadBody, input.scriptName) ?? `quarantine:${input.expectedVersion}`;
}
