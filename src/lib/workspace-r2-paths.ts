/**
 * Build workspace-scoped R2 prefixes/keys.
 *
 * Prefix format is always `{orgId}/{workspaceId}`.
 */
export function getWorkspaceR2Prefix(orgId: string, workspaceId: string): string {
  return `${orgId}/${workspaceId}`;
}

function normalizeRelativePath(path: string): string {
  return path.replace(/^\/+/, '');
}

export function buildWorkspaceScopedR2Key(
  orgId: string,
  workspaceId: string,
  relativePath: string
): string {
  const prefix = getWorkspaceR2Prefix(orgId, workspaceId);
  return `${prefix}/${normalizeRelativePath(relativePath)}`;
}
