import { Sandbox } from "@cloudflare/sandbox";
import type { OutboundHandler } from "@cloudflare/containers";

import {
  listEvalDeployAppsForContainer,
  listEvalDeployRequests,
  logEvalDeployRequest,
  recordEvalDeployApp,
} from "./eval-deploy-registry.js";
import {
  EVAL_CLOUDFLARE_API_BASE_URL,
  EVAL_CLOUDFLARE_API_HOST,
} from "./project-vm-protocol.js";
import type { Env } from "./types.js";

export { EVAL_CLOUDFLARE_API_BASE_URL, EVAL_CLOUDFLARE_API_HOST };

function envelope(result: unknown = {}, success = true): unknown {
  return { success, errors: [], messages: [], result };
}

function fakeJwt(): string {
  return "eyJhbGciOiJub25lIn0.eyJleHAiIjo0MTAyNDQ0ODAwfQ.";
}

function responseFor(method: string, path: string): unknown {
  if (path === "/__health") return { ok: true, service: "eval-cloudflare-api-mock" };
  if (/\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+\/assets-upload-session$/.test(path)) {
    return envelope({ jwt: fakeJwt(), buckets: [] });
  }
  if (path.endsWith("/workers/assets/upload")) return envelope({ jwt: fakeJwt() });
  if (/\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+\/(content|settings|bindings|tags|secrets)$/.test(path)) {
    return envelope({
      id: "eval-script",
      etag: "eval-etag",
      created_on: "2026-06-09T00:00:00Z",
      modified_on: "2026-06-09T00:00:00Z",
    });
  }
  if (/\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+\/deployments$/.test(path)) {
    return method === "GET"
      ? envelope({ deployments: [] })
      : envelope({ id: "eval-deployment", source: "eval", strategy: "percentage" });
  }
  const scriptMatch = path.match(/\/workers\/dispatch\/namespaces\/([^/]+)\/scripts\/([^/]+)$/);
  if (scriptMatch) {
    const script = decodeURIComponent(scriptMatch[2]);
    return envelope({
      id: script,
      script,
      etag: "eval-etag",
      handlers: ["fetch"],
      created_on: "2026-06-09T00:00:00Z",
      modified_on: "2026-06-09T00:00:00Z",
    });
  }
  const nsMatch = path.match(/\/workers\/dispatch\/namespaces\/([^/]+)$/);
  if (nsMatch) {
    return envelope({
      namespace: decodeURIComponent(nsMatch[1]),
      created_on: "2026-06-09T00:00:00Z",
    });
  }
  if (/\/r2\/buckets\/[^/]+$/.test(path)) {
    return envelope({
      name: decodeURIComponent(path.split("/").pop() ?? "eval-bucket"),
      creation_date: "2026-06-09T00:00:00Z",
    });
  }
  if (/\/accounts\/[^/]+$/.test(path)) {
    return envelope({ id: "eval-account", name: "Eval Account" });
  }
  return envelope({ id: "eval", path, method });
}

function parseDispatchScriptPath(path: string): {
  accountId: string;
  dispatchNamespace: string;
  scriptName: string;
} | null {
  const match = path.match(
    /^\/client\/v4\/accounts\/([^/]+)\/workers\/dispatch\/namespaces\/([^/]+)\/scripts\/([^/]+)$/,
  );
  if (!match) return null;
  return {
    accountId: decodeURIComponent(match[1]),
    dispatchNamespace: decodeURIComponent(match[2]),
    scriptName: decodeURIComponent(match[3]),
  };
}

function validateDeployUpload(request: Request, url: URL): Response | null {
  if (request.method !== "PUT") return null;
  const upload = parseDispatchScriptPath(url.pathname);
  if (!upload) return null;
  if (upload.dispatchNamespace !== "chiridion") {
    return Response.json(envelope({}, false), { status: 400 });
  }
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(upload.scriptName)) {
    return Response.json(envelope({}, false), { status: 400 });
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    return Response.json(envelope({}, false), { status: 400 });
  }
  if (url.searchParams.get("bindings_inherit") !== "strict") {
    return Response.json(envelope({}, false), { status: 400 });
  }
  return null;
}

const handleEvalCloudflareApi: OutboundHandler<Env> = async (request, env, ctx) => {
  const url = new URL(request.url);
  if (url.pathname === "/__eval/requests") {
    const requests = await listEvalDeployRequests(env.APP_DB, ctx.containerId);
    return new Response(requests.map((entry) => JSON.stringify(entry)).join("\n"), {
      headers: { "Content-Type": "application/x-ndjson" },
    });
  }
  if (url.pathname === "/__eval/deploys") {
    const apps = await listEvalDeployAppsForContainer(env.APP_DB, ctx.containerId);
    return Response.json({ apps });
  }

  const validationError = validateDeployUpload(request, url);
  if (validationError) return validationError;

  await logEvalDeployRequest(env.APP_DB, ctx.containerId, request, url);

  const upload = parseDispatchScriptPath(url.pathname);
  if (request.method === "PUT" && upload) {
    await recordEvalDeployApp(env.APP_DB, {
      containerId: ctx.containerId,
      accountId: upload.accountId,
      dispatchNamespace: upload.dispatchNamespace,
      scriptName: upload.scriptName,
      query: url.search.slice(1),
      contentType: request.headers.get("content-type"),
      contentLength: request.headers.get("content-length"),
    });
  }

  return Response.json(responseFor(request.method, url.pathname));
};

export class EvalSandbox extends Sandbox<Env> {}

EvalSandbox.outboundByHost = {
  [EVAL_CLOUDFLARE_API_HOST]: handleEvalCloudflareApi,
};
