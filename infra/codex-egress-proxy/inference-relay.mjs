const MAX_BODY_BYTES = 32 * 1024 * 1024;
const UPSTREAM_URL = "https://chatgpt.com/backend-api/codex/responses";

export function copyHeaders(source, names) {
  const headers = new Headers();
  for (const name of names) {
    const value = source.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

export async function handleInferenceRequest(request, fetchImpl = fetch) {
  const url = new URL(request.url);
  if (url.pathname === "/healthz") return new Response("ok");
  if (request.method !== "POST" || url.pathname !== "/backend-api/codex/responses") {
    return new Response("Not Found", { status: 404 });
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return new Response("Payload Too Large", { status: 413 });
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) {
    return new Response("Payload Too Large", { status: 413 });
  }

  const headers = copyHeaders(request, [
    "authorization",
    "chatgpt-account-id",
    "content-encoding",
    "content-type",
    "openai-beta",
    "session-id",
    "x-client-request-id",
  ]);
  headers.set("accept", "text/event-stream");
  headers.set("originator", "camelai");
  headers.set("user-agent", "camelAI/1.0");

  const upstream = await fetchImpl(UPSTREAM_URL, {
    method: "POST",
    headers,
    body,
    redirect: "manual",
    signal: request.signal,
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: copyHeaders(upstream, [
      "cache-control",
      "content-type",
      "openai-processing-ms",
      "retry-after",
      "x-request-id",
    ]),
  });
}

if (import.meta.main) {
  Bun.serve({
    hostname: "0.0.0.0",
    port: Number(Bun.env.PORT ?? "8787"),
    maxRequestBodySize: MAX_BODY_BYTES,
    fetch(request, server) {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/backend-api/codex/responses") {
        // Codex responses can have long quiet periods before or between SSE
        // events. Disable Bun's default ten-second per-request idle timeout.
        server.timeout(request, 0);
      }
      return handleInferenceRequest(request);
    },
  });
}
