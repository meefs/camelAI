const MAX_PROJECT_BUILD_SANDBOX_KEY_LENGTH = 63;

/**
 * Stable Durable Object name for an org's shared project-build sandbox.
 * Kept short enough for Cloudflare sandbox id limits.
 */
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

function stableHexHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
