/**
 * Public viewer for Playwright E2E reports stored in R2.
 *
 * The E2E workflow (.github/workflows/e2e.yml) PUTs each run's merged
 * `playwright-report/` files to this worker's authenticated upload endpoint,
 * which writes them to R2 via the binding under `e2e-reports/<runId>/`. The
 * worker then serves those static files (HTML report + embedded videos/traces)
 * and an index that lists runs. Reads are public (reports aren't sensitive);
 * writes require UPLOAD_TOKEN, so CI needs no Cloudflare API token — just one
 * shared secret scoped to "write a report object through this worker".
 */

interface Env {
  REPORTS_BUCKET: R2Bucket;
  // Shared bearer secret for the upload endpoint (wrangler secret put UPLOAD_TOKEN).
  UPLOAD_TOKEN?: string;
}

const PREFIX = "e2e-reports/";

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  webm: "video/webm",
  mp4: "video/mp4",
  zip: "application/zip",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  txt: "text/plain; charset=utf-8",
};

function contentTypeFor(key: string): string {
  const ext = key.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c] as string,
  );
}

async function listRuns(env: Env): Promise<string[]> {
  const runs: string[] = [];
  let cursor: string | undefined;
  do {
    const res = await env.REPORTS_BUCKET.list({
      prefix: PREFIX,
      delimiter: "/",
      cursor,
    });
    for (const p of res.delimitedPrefixes) {
      const id = p.slice(PREFIX.length).replace(/\/$/, "");
      if (id) runs.push(id);
    }
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor);
  // GitHub run ids are monotonically increasing integers, so numeric desc puts
  // the newest run first; fall back to string compare for any non-numeric ids.
  runs.sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return nb - na;
    return a < b ? 1 : a > b ? -1 : 0;
  });
  return runs;
}

function indexPage(runs: string[]): string {
  const rows = runs
    .map(
      (id) =>
        `<li><a href="/r/${encodeURIComponent(id)}/">Run ${escapeHtml(id)}</a></li>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>E2E reports</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 48rem; margin: 3rem auto; padding: 0 1rem; color: #18181b; }
  h1 { font-size: 1.25rem; }
  ul { list-style: none; padding: 0; }
  li { padding: .4rem 0; border-bottom: 1px solid #e4e4e7; }
  a { color: #2563eb; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .empty { color: #71717a; }
</style>
</head>
<body>
<h1>Playwright E2E reports</h1>
${runs.length ? `<ul>\n${rows}\n</ul>` : `<p class="empty">No reports yet.</p>`}
</body>
</html>`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);

    // Authenticated upload: PUT /upload/<runId>/<path...> -> R2 via the binding.
    // CI uses this instead of a Cloudflare API token; the secret only grants
    // writing report objects under this prefix, through this worker.
    if (path.startsWith("/upload/")) {
      if (request.method !== "PUT") {
        return new Response("Method not allowed", { status: 405 });
      }
      const token = (request.headers.get("authorization") ?? "").replace(
        /^Bearer\s+/i,
        "",
      );
      if (!env.UPLOAD_TOKEN || token !== env.UPLOAD_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }
      const rel = path.slice("/upload/".length);
      // Guard against path traversal / empty keys.
      if (!rel || rel.includes("..") || rel.endsWith("/")) {
        return new Response("Bad request", { status: 400 });
      }
      const body = await request.arrayBuffer();
      await env.REPORTS_BUCKET.put(`${PREFIX}${rel}`, body, {
        httpMetadata: { contentType: contentTypeFor(rel) },
      });
      return new Response(null, { status: 204 });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }

    // Index: list available runs.
    if (path === "/" || path === "/index.html") {
      const runs = await listRuns(env);
      return new Response(request.method === "HEAD" ? null : indexPage(runs), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    // Report assets: /r/<runId>/<path...>
    const match = path.match(/^\/r\/([^/]+)(\/.*)?$/);
    if (match) {
      const runId = match[1];
      const rest = match[2];
      // Redirect /r/<id> -> /r/<id>/ so the report's relative asset links
      // (data/*.webm, trace/*, etc.) resolve under the run prefix.
      if (rest === undefined || rest === "") {
        return Response.redirect(`${url.origin}/r/${runId}/`, 308);
      }
      const assetPath = rest.endsWith("/") ? `${rest}index.html` : rest;
      const key = `${PREFIX}${runId}${assetPath}`;
      const object = await env.REPORTS_BUCKET.get(key);
      if (!object) return new Response("Not found", { status: 404 });

      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("content-type", contentTypeFor(key));
      headers.set("etag", object.httpEtag);
      // Report assets are immutable per run id; the index itself is no-store.
      headers.set("cache-control", "public, max-age=31536000, immutable");
      return new Response(request.method === "HEAD" ? null : object.body, {
        headers,
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
