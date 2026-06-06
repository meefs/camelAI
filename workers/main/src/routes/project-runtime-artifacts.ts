import type { RouteContext } from "../types.js";
import { workspaceIdFromGlobalProjectId } from "../project-vm-protocol.js";
import { validateProjectRuntimeProxy } from "../sandbox-auth.js";
import { WorkspaceFilesystemClient } from "../workspace-filesystem-do.js";

const INTERNAL_ARTIFACTS_PREFIX = "/api/internal/project-runtime/artifacts";

export async function handleProjectRuntimeArtifactsProxy({
  req,
  env,
}: RouteContext): Promise<Response> {
  const proxyAuth = validateProjectRuntimeProxy(req, env);
  if (!proxyAuth.valid) {
    return new Response("Forbidden", { status: 403 });
  }

  const requestUrl = new URL(req.url);
  const parsed = parseArtifactsProxyPath(requestUrl.pathname);
  if (!parsed) {
    return new Response("Not found", { status: 404 });
  }

  const projectId = proxyAuth.projectId;
  const workspaceId = workspaceIdFromGlobalProjectId(projectId);
  if (!workspaceId) {
    return new Response("Invalid project id", { status: 403 });
  }

  const workspace = new WorkspaceFilesystemClient(env, workspaceId);
  const scope = isGitReceivePackRequest(requestUrl) ? "write" : "read";
  let artifactAccess: Awaited<ReturnType<WorkspaceFilesystemClient["mintProjectArtifactToken"]>>;
  try {
    artifactAccess = await workspace.mintProjectArtifactToken(projectId, scope, 600);
  } catch (error) {
    console.error("[project-runtime-artifacts] failed to mint Artifacts token", {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
    return new Response("Project is not backed by Artifacts", { status: 403 });
  }

  const remoteUrl = new URL(artifactAccess.artifactRemote);
  const targetUrl = rewriteArtifactsGitUrl(requestUrl, remoteUrl, parsed.gitSuffix);

  const headers = new Headers(req.headers);
  removeInternalProxyHeaders(headers);
  headers.set("Authorization", `Bearer ${artifactAccess.token}`);
  if (scope === "write") {
    headers.delete("Git-Protocol");
  }

  return fetch(new Request(targetUrl, {
    method: req.method,
    headers,
    body: req.body,
    redirect: req.redirect,
    cf: req.cf,
  }));
}

interface ParsedArtifactsProxyPath {
  gitSuffix: string;
}

function parseArtifactsProxyPath(pathname: string): ParsedArtifactsProxyPath | null {
  const suffix = pathname.slice(INTERNAL_ARTIFACTS_PREFIX.length);
  if (!suffix.startsWith("/")) return null;
  const parts = suffix.split("/").filter(Boolean).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return "";
    }
  });
  if (parts.length < 2 || parts[0] !== "git" || !parts[1].endsWith(".git")) {
    return null;
  }
  return {
    gitSuffix: `/${parts.join("/")}`,
  };
}

function rewriteArtifactsGitUrl(requestUrl: URL, remoteUrl: URL, gitSuffix: string): URL {
  const rewritten = new URL(remoteUrl.toString());
  const remoteBase = remoteUrl.pathname.replace(/\/+$/, "");
  const requestGitPath = gitSuffix.replace(/^\/git\/[^/]+\.git/, "");
  rewritten.pathname = `${remoteBase}${requestGitPath}`;
  rewritten.search = requestUrl.search;
  rewritten.hash = "";
  return rewritten;
}

function isGitReceivePackRequest(url: URL): boolean {
  return (
    url.pathname.endsWith("/git-receive-pack") ||
    url.searchParams.get("service") === "git-receive-pack"
  );
}

function removeInternalProxyHeaders(headers: Headers): void {
  for (const key of Array.from(headers.keys())) {
    const lower = key.toLowerCase();
    if (
      lower.startsWith("x-project-runtime-") ||
      lower.startsWith("x-chiridion-") ||
      lower === "x-sandbox-secret"
    ) {
      headers.delete(key);
    }
  }
}
