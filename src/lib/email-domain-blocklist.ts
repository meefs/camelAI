export const EMAIL_DOMAIN_BLOCKED_ERROR = 'email_domain_blocked';

function normalizeListedDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^@+/, '').replace(/\.+$/, '');
}

export function getEmailDomain(email: string): string | null {
  const normalizedEmail = email.trim().toLowerCase();
  const atIndex = normalizedEmail.lastIndexOf('@');

  if (atIndex <= 0 || atIndex === normalizedEmail.length - 1) {
    return null;
  }

  const domain = normalizeListedDomain(normalizedEmail.slice(atIndex + 1));
  return domain || null;
}

export function parseEmailDomainBlocklist(
  rawBlocklist: string | null | undefined,
): string[] {
  if (!rawBlocklist) {
    return [];
  }

  const uniqueDomains = new Set<string>();

  for (const entry of rawBlocklist.split(/[\s,;]+/)) {
    const normalizedDomain = normalizeListedDomain(entry);
    if (normalizedDomain) {
      uniqueDomains.add(normalizedDomain);
    }
  }

  return [...uniqueDomains];
}

export function findBlockedEmailDomain(
  email: string,
  rawBlocklist: string | null | undefined,
): string | null {
  const emailDomain = getEmailDomain(email);
  if (!emailDomain) {
    return null;
  }

  for (const blockedDomain of parseEmailDomainBlocklist(rawBlocklist)) {
    if (
      emailDomain === blockedDomain ||
      emailDomain.endsWith(`.${blockedDomain}`)
    ) {
      return blockedDomain;
    }
  }

  return null;
}

export function isEmailDomainBlocked(
  email: string,
  rawBlocklist: string | null | undefined,
): boolean {
  return findBlockedEmailDomain(email, rawBlocklist) !== null;
}

export function assertEmailDomainAllowed(
  email: string,
  rawBlocklist: string | null | undefined,
): void {
  if (findBlockedEmailDomain(email, rawBlocklist)) {
    throw new Error(EMAIL_DOMAIN_BLOCKED_ERROR);
  }
}

export function isEmailDomainBlockedError(error: unknown): boolean {
  return (
    error instanceof Error && error.message === EMAIL_DOMAIN_BLOCKED_ERROR
  );
}

// ---------------------------------------------------------------------------
// KV-backed blocklist helpers
// ---------------------------------------------------------------------------

const EMAIL_DOMAIN_BLOCKLIST_KV_KEY = 'email_domain_blocklist';

export async function getBlocklistFromKV(
  kv: KVNamespace,
): Promise<string> {
  try {
    const raw = await kv.get(EMAIL_DOMAIN_BLOCKLIST_KV_KEY);
    if (raw) return (JSON.parse(raw) as string[]).join(',');
  } catch {}
  return '';
}

export async function setBlocklistInKV(
  kv: KVNamespace,
  domains: string[],
): Promise<string[]> {
  const normalized = domains
    .map((d) => d.trim().toLowerCase().replace(/^@+/, '').replace(/\.+$/, ''))
    .filter(Boolean);
  const unique = [...new Set(normalized)];
  await kv.put(EMAIL_DOMAIN_BLOCKLIST_KV_KEY, JSON.stringify(unique));
  return unique;
}

export async function getBlocklistDomainsFromKV(
  kv: KVNamespace,
): Promise<string[]> {
  try {
    const raw = await kv.get(EMAIL_DOMAIN_BLOCKLIST_KV_KEY);
    if (raw) return JSON.parse(raw) as string[];
  } catch {}
  return [];
}
