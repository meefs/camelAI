import { getSandbox } from "@cloudflare/sandbox";

import type { ProjectBuildSandboxNamespaceEnv } from "./project-build-contracts.js";
import type { ProjectBuildSandboxLike } from "./project-worker-bundle.js";

const DEFAULT_PREWARM_TIMEOUT_MS = 25_000;
const MAX_PROJECT_BUILD_SANDBOX_KEY_LENGTH = 63;

export function projectBuildSandboxKey(orgId: string): string {
  const org = orgId.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!org) throw new Error("orgId is required");
  const readable = `org-${org}`;
  if (readable.length <= MAX_PROJECT_BUILD_SANDBOX_KEY_LENGTH) return readable;
  const hash = stableHexHash(org);
  const prefixLength = MAX_PROJECT_BUILD_SANDBOX_KEY_LENGTH - hash.length - 1;
  const prefix = readable.slice(0, prefixLength).replace(/-+$/g, "");
  return `${prefix}-${hash}`;
}

export async function prewarmProjectBuildSandbox(input: {
  env: ProjectBuildSandboxNamespaceEnv;
  orgId: string;
  timeoutMs?: number;
}): Promise<boolean> {
  const namespace = input.env.PROJECT_BUILD_SANDBOX;
  if (!namespace) return false;
  const orgId = input.orgId?.trim();
  if (!orgId) return false;
  let key: string;
  try {
    key = projectBuildSandboxKey(orgId);
  } catch {
    return false;
  }
  const timeoutMs = Math.max(1_000, Math.floor(input.timeoutMs ?? DEFAULT_PREWARM_TIMEOUT_MS));
  const startedAt = Date.now();
  try {
    const sandbox = getSandbox(namespace, key, {
      normalizeId: true,
      transport: "rpc",
    }) as unknown as ProjectBuildSandboxLike;
    await sandbox.exec("true", { timeout: timeoutMs });
    return true;
  } catch (error) {
    console.warn("[project-build] prewarm failed", {
      operation: "prewarm",
      orgId,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function prewarmWorkspaceBuildSandboxes(
  env: ProjectBuildSandboxNamespaceEnv,
  orgId: string,
  _workspaceId: string,
  options: { timeoutMs?: number; maxTargets?: number } = {},
): Promise<number> {
  if (env.DISABLE_PROJECT_BUILD_SANDBOX_PREWARM === "1") return 0;
  if (!env.PROJECT_BUILD_SANDBOX) return 0;
  if (!orgId?.trim()) return 0;
  const warmed = await prewarmProjectBuildSandbox({ env, orgId, timeoutMs: options.timeoutMs });
  return warmed ? 1 : 0;
}

function stableHexHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
