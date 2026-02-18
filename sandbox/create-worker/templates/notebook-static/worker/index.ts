export default {
  async fetch(request, env) {
    const assetResponse = await env.ASSETS.fetch(request);

    if (assetResponse.status !== 404) {
      return assetResponse;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return assetResponse;
    }

    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return assetResponse;
    }

    return env.ASSETS.fetch(new Request(new URL("/index.html", url), request));
  },
} satisfies ExportedHandler<Env>;
