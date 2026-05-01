import { z } from "zod";

export const MAX_INVITE_EMAILS = 100;

export const inviteEmailSchema = z
  .string()
  .trim()
  .email("Please enter a valid email address")
  .transform((value) => value.toLowerCase());

export interface ParsedInviteEmails {
  emails: string[];
  rejectedTokens: string[];
}

export function tokenizeInviteEmails(raw: string): string[] {
  return raw
    .split(/[\s,;]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function stripHarmlessWrapping(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("<") && trimmed.endsWith(">") && trimmed.length > 2) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function normalizeInviteEmail(value: string): string | null {
  const parsed = inviteEmailSchema.safeParse(stripHarmlessWrapping(value));
  return parsed.success ? parsed.data : null;
}

export function parseInviteEmails(raw: string): ParsedInviteEmails {
  const emails: string[] = [];
  const rejectedTokens: string[] = [];
  const seen = new Set<string>();

  for (const token of tokenizeInviteEmails(raw)) {
    const email = normalizeInviteEmail(token);
    if (!email) {
      rejectedTokens.push(token);
      continue;
    }
    if (seen.has(email)) continue;
    seen.add(email);
    emails.push(email);
  }

  return { emails, rejectedTokens };
}

export function parseSubmittedInviteEmails(values: string[]): ParsedInviteEmails & {
  duplicateEmails: string[];
} {
  const emails: string[] = [];
  const duplicateEmails: string[] = [];
  const rejectedTokens: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    for (const token of tokenizeInviteEmails(value)) {
      const email = normalizeInviteEmail(token);
      if (!email) {
        rejectedTokens.push(token);
        continue;
      }
      if (seen.has(email)) {
        duplicateEmails.push(email);
        continue;
      }
      seen.add(email);
      emails.push(email);
    }
  }

  return { emails, duplicateEmails, rejectedTokens };
}
