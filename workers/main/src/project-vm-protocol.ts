export const PROJECT_RUNTIME_PROVIDER = "project-runtime-service";
export const PROJECT_VM_CHECKOUT_PATH = "/workspace";
export const PROJECT_RUNTIME_ARTIFACTS_PROXY_CAPABILITY = "camelai-artifacts";
export const PROJECT_RUNTIME_CLOUDFLARE_API_PROXY_CAPABILITY = "camelai-cloudflare-api";

export interface ProjectVmEnv {
  PROJECT_RUNTIME_HOST?: Fetcher;
  PROJECT_RUNTIME_SERVICE_URL?: string;
  PROJECT_RUNTIME_SERVICE_BEARER_TOKEN?: string;
  PROJECT_RUNTIME_DOCKER_PROXY_BASE_URL?: string;
  PROJECT_RUNTIME_ARTIFACTS_PROXY_BASE?: string;
  PROJECT_RUNTIME_PROXY_SECRET?: string;
}

export interface VmExecArgs {
  command?: unknown;
  cwd?: unknown;
  timeoutMs?: unknown;
  timeoutSeconds?: unknown;
  env?: unknown;
  location?: unknown;
  project?: unknown;
  projectId?: unknown;
}

export interface VmPushArgs {
  paths?: unknown;
  vmRoot?: unknown;
  clean?: unknown;
  location?: unknown;
  project?: unknown;
  projectId?: unknown;
}

export interface VmPullArgs {
  paths?: unknown;
  vmRoot?: unknown;
  workspaceRoot?: unknown;
  files?: unknown;
  location?: unknown;
  project?: unknown;
  projectId?: unknown;
}

export interface VmFileArgs {
  path?: unknown;
  content?: unknown;
  edits?: unknown;
  pattern?: unknown;
  glob?: unknown;
  ignoreCase?: unknown;
  literal?: unknown;
  context?: unknown;
  limit?: unknown;
  offset?: unknown;
  recursive?: unknown;
  includeHidden?: unknown;
  location?: unknown;
  project?: unknown;
  projectId?: unknown;
}

export interface VmCloneProjectArgs {
  sourceProject?: unknown;
  sourceProjectId?: unknown;
  id?: unknown;
  name?: unknown;
  description?: unknown;
}

export function normalizeGlobalProjectId(projectId: string): string {
  return projectId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

export function workspaceIdFromGlobalProjectId(projectId: string): string | null {
  const match = normalizeGlobalProjectId(projectId).match(/^ca-([0-9a-f]{32})-/);
  const compact = match?.[1];
  if (!compact) return null;
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

export function runtimeArtifactsProxyRemote(
  base: string | undefined,
  dockerProxyBase: string | undefined,
): string {
  const cleanBase = (
    base?.trim() ||
    `${projectRuntimeDockerProxyBaseUrl(dockerProxyBase)}/p/${PROJECT_RUNTIME_ARTIFACTS_PROXY_CAPABILITY}`
  ).replace(/\/+$/, "");
  return `${cleanBase}/git/origin.git`;
}

export function projectRuntimeDockerProxyBaseUrl(value: string | undefined): string {
  return (value?.trim() || "http://host.docker.internal:8089").replace(/\/+$/, "");
}

export function projectRuntimeDeployProxyUrl(value: string | undefined): string {
  const base = projectRuntimeDockerProxyBaseUrl(value);
  const proxyPath = `/p/${PROJECT_RUNTIME_CLOUDFLARE_API_PROXY_CAPABILITY}/client/v4`;
  return base.endsWith("/client/v4") ? base : `${base}${proxyPath}`;
}
