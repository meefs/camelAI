import type { RouteContext } from "../types.js";
import { workspaceIdFromGlobalProjectId } from "../project-vm-protocol.js";
import { WorkspaceFilesystemClient } from "../workspace-filesystem-do.js";

const INTERNAL_ARTIFACTS_PREFIX = "/api/internal/project-runtime/artifacts";

export async function handleProjectRuntimeArtifactsProxy({
  req,
  env,
}: RouteContext): Promise<Response> {
  const secret = env.PROJECT_RUNTIME_PROXY_SECRET?.trim() || env.SANDBOX_PROXY_SECRET?.trim();
  if (!secret) {
    return new Response("Project runtime proxy secret is not configured", { status: 500 });
  }
  if (req.headers.get("X-Project-Runtime-Secret") !== secret) {
    return new Response("Forbidden", { status: 403 });
  }

  const requestUrl = new URL(req.url);
  const parsed = parseArtifactsProxyPath(requestUrl.pathname);
  if (!parsed) {
    return new Response("Not found", { status: 404 });
  }

  if (req.headers.get("X-Project-Runtime-Project") !== parsed.projectId) {
    return new Response("Project runtime caller does not match requested project", {
      status: 403,
    });
  }

  const workspaceId = workspaceIdFromGlobalProjectId(parsed.projectId);
  if (!workspaceId) {
    return new Response("Invalid project id", { status: 403 });
  }

  const workspace = new WorkspaceFilesystemClient(env, workspaceId);
  const scope = isGitReceivePackRequest(requestUrl) ? "write" : "read";
  let artifactAccess: Awaited<ReturnType<WorkspaceFilesystemClient["mintProjectArtifactToken"]>>;
  try {
    artifactAccess = await workspace.mintProjectArtifactToken(parsed.projectId, scope, 600);
  } catch (error) {
    console.error("[project-runtime-artifacts] failed to mint Artifacts token", {
      projectId: parsed.projectId,
      remoteProjectId: parsed.remoteProjectId,
      error: error instanceof Error ? error.message : String(error),
    });
    return new Response("Project is not backed by Artifacts", { status: 403 });
  }

  if (parsed.remoteProjectId !== artifactAccess.artifactRemoteProjectId) {
    return new Response("Artifacts repository is not allowed for this project", {
      status: 403,
    });
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
  projectId: string;
  remoteProjectId: string;
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
  if (parts.length < 3 || parts[1] !== "git" || !parts[2].endsWith(".git")) {
    return null;
  }
  return {
    projectId: parts[0],
    remoteProjectId: parts[2].slice(0, -4),
    gitSuffix: `/${parts.slice(1).join("/")}`,
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
