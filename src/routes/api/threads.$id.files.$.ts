import type { LoaderFunctionArgs } from "react-router";
import { requestWorkspaceId, requireRuntimeThread } from "@/lib/runtime-threads.server";
import { getMimeType, shouldDisplayInline } from "@/lib/file-content-headers";
import { scratchVolumePath } from "@/lib/agent-runtime-shared";
import { fetchScratchFile, threadScratchVolume } from "../../../workers/main/src/agent-runtime/thread-runtime";

/**
 * The sandbox a scratch file's HTML runs in when opened on its own: what the
 * chat's preview iframe allows, and never the app's origin.
 */
const HTML_SANDBOX_CSP = "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads";

/**
 * GET /api/threads/:id/files/workspace/<path>: a file of a runtime thread's
 * scratch space (/workspace/<path> as the agent sees it), for anyone who may
 * see the thread. The Worker reads it from the runtime with chiridion's
 * token and serves it from chiridion's origin as workspace files are served
 * (type by extension, inline or attachment), so previews treat both alike;
 * HTML is additionally sandboxed by CSP when opened directly.
 */
export async function loader({ request, context, params }: LoaderFunctionArgs) {
  const { env, context: threadContext, row } = await requireRuntimeThread(
    request,
    context,
    params.id,
    requestWorkspaceId(request),
  );
  const shown = `/${(params["*"] ?? "").split("/").map((segment) => decodeURIComponent(segment)).join("/")}`;
  const volumePath = scratchVolumePath(shown);
  if (!volumePath) return Response.json({ error: "Not a scratch file" }, { status: 400 });
  const volumeId = await threadScratchVolume(env, threadContext, row);
  if (!volumeId) return Response.json({ error: "File not found" }, { status: 404 });
  const upstream = await fetchScratchFile(env, volumeId, volumePath, request.headers.get("range"));
  if (upstream.status === 404 || upstream.status === 400) {
    await upstream.body?.cancel();
    return Response.json({ error: "File not found" }, { status: 404 });
  }
  if (!upstream.ok) {
    await upstream.body?.cancel();
    return Response.json({ error: "Could not read the file" }, { status: 502 });
  }
  const filename = volumePath.split("/").pop() || "file";
  const contentType = getMimeType(filename);
  const download = new URL(request.url).searchParams.get("download") === "1";
  const inline = !download && shouldDisplayInline(contentType);
  const headers = new Headers({
    "Content-Type": contentType,
    "Cache-Control": "private, no-store",
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${filename.replace(/["\\\r\n]/g, "_")}"`,
    "X-Content-Type-Options": "nosniff",
  });
  if (contentType.startsWith("text/html") || contentType.startsWith("image/svg")) headers.set("Content-Security-Policy", HTML_SANDBOX_CSP);
  for (const name of ["Content-Length", "Content-Range", "Accept-Ranges", "ETag"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}
