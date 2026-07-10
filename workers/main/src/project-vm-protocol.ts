// Residual constants/helpers left over from the retired Azure project VM
// runtime. The VM bridge and its protocol are gone; only these two
// VM-independent pieces still have consumers:
//   - normalizeGlobalProjectId: derives the stable global project id used as the
//     WorkspaceFilesystemDO registry key (workspace-filesystem-do.ts).
//   - EVAL_CLOUDFLARE_API_HOST / EVAL_CLOUDFLARE_API_BASE_URL: the intercepted
//     Cloudflare API host used by the eval sandbox (eval-sandbox.ts).
// Kept here (rather than renamed) to avoid churning those import sites.

export const EVAL_CLOUDFLARE_API_HOST = "camelai-eval-cloudflare-api.internal";
export const EVAL_CLOUDFLARE_API_BASE_URL = `http://${EVAL_CLOUDFLARE_API_HOST}/client/v4`;

export function normalizeGlobalProjectId(projectId: string): string {
  return projectId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}
