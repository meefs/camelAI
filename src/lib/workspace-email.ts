const DEFAULT_WORKSPACE_EMAIL_LOCAL_PART = 'chat';

export interface ParsedMailboxAddress {
  local: string;
  domain: string;
}

export interface ParsedWorkspaceInboxAddress {
  workspaceId: string;
  domain: string;
}

export interface WorkspaceEmailRoutingConfig {
  localPart: string;
  domain: string;
}

function isValidDomain(value: string): boolean {
  return /^[a-z0-9.-]+$/i.test(value) && value.includes('.');
}

function isValidLocalPart(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,62}$/i.test(value);
}

function normalizeMailboxAddress(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const angleMatch = trimmed.match(/<([^>]+)>/);
  const candidate = (angleMatch ? angleMatch[1] : trimmed)
    .replace(/^mailto:/i, '')
    .trim()
    .toLowerCase();

  const atIndex = candidate.lastIndexOf('@');
  if (atIndex <= 0 || atIndex === candidate.length - 1) {
    return null;
  }

  return candidate;
}

export function parseMailboxAddress(raw: string): ParsedMailboxAddress | null {
  const normalized = normalizeMailboxAddress(raw);
  if (!normalized) return null;

  const atIndex = normalized.lastIndexOf('@');
  const local = normalized.slice(0, atIndex);
  const domain = normalized.slice(atIndex + 1);

  if (!local || !domain || !isValidDomain(domain)) {
    return null;
  }

  return { local, domain };
}

export function getWorkspaceEmailDomain(env: {
  WORKSPACE_EMAIL_DOMAIN?: string;
  EMAIL_FROM_ADDRESS?: string;
}): string | null {
  const fromExplicit = env.WORKSPACE_EMAIL_DOMAIN?.trim().toLowerCase();
  if (fromExplicit && isValidDomain(fromExplicit)) {
    return fromExplicit;
  }

  const fromAddress = env.EMAIL_FROM_ADDRESS ? parseMailboxAddress(env.EMAIL_FROM_ADDRESS) : null;
  return fromAddress?.domain ?? null;
}

export function getWorkspaceEmailLocalPart(env: {
  WORKSPACE_EMAIL_LOCAL_PART?: string;
  EMAIL_FROM_ADDRESS?: string;
}): string {
  const fromExplicit = env.WORKSPACE_EMAIL_LOCAL_PART?.trim().toLowerCase();
  if (fromExplicit && isValidLocalPart(fromExplicit)) {
    return fromExplicit;
  }

  const fromAddress = env.EMAIL_FROM_ADDRESS ? parseMailboxAddress(env.EMAIL_FROM_ADDRESS) : null;
  if (fromAddress?.local && isValidLocalPart(fromAddress.local)) {
    return fromAddress.local;
  }

  return DEFAULT_WORKSPACE_EMAIL_LOCAL_PART;
}

export function getWorkspaceEmailRoutingConfig(env: {
  WORKSPACE_EMAIL_DOMAIN?: string;
  WORKSPACE_EMAIL_LOCAL_PART?: string;
  EMAIL_FROM_ADDRESS?: string;
}): WorkspaceEmailRoutingConfig | null {
  const domain = getWorkspaceEmailDomain(env);
  if (!domain) return null;

  return {
    localPart: getWorkspaceEmailLocalPart(env),
    domain,
  };
}

export function buildWorkspaceInboxAddress(
  workspaceId: string,
  domain: string,
  opts?: { localPart?: string }
): string {
  const safeWorkspaceId = workspaceId.trim();
  const safeDomain = domain.trim().toLowerCase();
  const localPart = opts?.localPart?.trim().toLowerCase() || DEFAULT_WORKSPACE_EMAIL_LOCAL_PART;
  return `${localPart}+${safeWorkspaceId}@${safeDomain}`;
}

export function parseWorkspaceInboxAddress(
  rawAddress: string,
  opts?: { expectedDomain?: string | null; expectedLocalPart?: string | null }
): ParsedWorkspaceInboxAddress | null {
  const mailbox = parseMailboxAddress(rawAddress);
  if (!mailbox) return null;

  const expectedDomain = opts?.expectedDomain?.trim().toLowerCase();
  if (expectedDomain && mailbox.domain !== expectedDomain) {
    return null;
  }

  const expectedLocalPart = opts?.expectedLocalPart?.trim().toLowerCase() || null;

  const plusSegments = mailbox.local.split('+').map((segment) => segment.trim());
  if (plusSegments.length >= 2) {
    if (plusSegments.length !== 2) {
      return null;
    }
    const localPart = plusSegments[0]?.toLowerCase() || '';
    if ((!expectedLocalPart || localPart === expectedLocalPart) && plusSegments[1]) {
      const workspaceId = plusSegments[1];
      if (!/^[a-z0-9][a-z0-9-]{1,127}$/i.test(workspaceId)) {
        return null;
      }

      return {
        workspaceId,
        domain: mailbox.domain,
      };
    }
  }

  return null;
}
