import { ADJECTIVES, NOUNS } from './email-handle-words';

export interface ParsedMailboxAddress {
  local: string;
  domain: string;
}

export interface WorkspaceEmailRoutingConfig {
  domain: string;
}

function isValidDomain(value: string): boolean {
  return /^[a-z0-9.-]+$/i.test(value) && value.includes('.');
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

// Keep for workspace name uniqueness checks in OrgDO (non-email use)
export function slugifyWorkspaceName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64) || 'workspace';
}

// --- Email handle generation ---

const EMAIL_HANDLE_PATTERN = /^[a-z]+-[a-z]+-[a-z]+$/;

export function isValidEmailHandle(handle: string): boolean {
  return EMAIL_HANDLE_PATTERN.test(handle);
}

function randomElement<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function generateEmailHandle(): string {
  const adj = randomElement(ADJECTIVES);
  const noun1 = randomElement(NOUNS);
  let noun2 = randomElement(NOUNS);
  while (noun2 === noun1) {
    noun2 = randomElement(NOUNS);
  }
  return `${adj}-${noun1}-${noun2}`;
}

// --- Address building / parsing ---

export function buildWorkspaceEmailAddress(emailHandle: string, domain: string): string {
  return `${emailHandle}@${domain.trim().toLowerCase()}`;
}

export function parseWorkspaceEmailAddress(
  rawAddress: string,
  opts?: { expectedDomain?: string | null }
): { emailHandle: string; domain: string } | null {
  const mailbox = parseMailboxAddress(rawAddress);
  if (!mailbox) return null;

  const expectedDomain = opts?.expectedDomain?.trim().toLowerCase();
  if (expectedDomain && mailbox.domain !== expectedDomain) {
    return null;
  }

  if (!isValidEmailHandle(mailbox.local)) {
    return null;
  }

  return { emailHandle: mailbox.local, domain: mailbox.domain };
}

// --- Routing config ---


export function getWorkspaceEmailDomain(env: {
  WORKSPACE_EMAIL_DOMAIN?: string;
}): string | null {
  const fromExplicit = env.WORKSPACE_EMAIL_DOMAIN?.trim().toLowerCase();
  if (fromExplicit && isValidDomain(fromExplicit)) {
    return fromExplicit;
  }

  return null;
}

export function getWorkspaceEmailRoutingConfig(env: {
  WORKSPACE_EMAIL_DOMAIN?: string;
}): WorkspaceEmailRoutingConfig | null {
  const domain = getWorkspaceEmailDomain(env);
  if (!domain) return null;

  return { domain };
}
