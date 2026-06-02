export const ORG_SLUG_KV_PREFIX = "org_slug:";

export async function hashOrgSlug(orgId: string): Promise<string> {
  const data = new TextEncoder().encode(orgId);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hash);
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let slug = "";
  for (let i = 0; i < 6; i++) {
    slug += chars[bytes[i] % chars.length];
  }
  return slug;
}

export async function generateUniqueOrgSlug(
  orgId: string,
  kv: KVNamespace,
): Promise<string> {
  const baseSlug = await hashOrgSlug(orgId);
  const existing = await kv.get(`${ORG_SLUG_KV_PREFIX}${baseSlug}`);
  if (!existing || existing === orgId) return baseSlug;

  // Collision: append incrementing suffix
  for (let i = 2; i <= 99; i++) {
    const candidate = `${baseSlug}${i}`;
    const owner = await kv.get(`${ORG_SLUG_KV_PREFIX}${candidate}`);
    if (!owner || owner === orgId) return candidate;
  }
  throw new Error("slug_generation_failed");
}

export async function registerOrgSlug(
  kv: KVNamespace,
  slug: string,
  orgId: string,
): Promise<void> {
  await kv.put(`${ORG_SLUG_KV_PREFIX}${slug}`, orgId);
}
