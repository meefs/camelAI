/**
 * Cloudflare Email Sending proxy for sandbox containers.
 *
 * - Trusted only when forwarded through sandbox-host (x-sandbox-secret auth)
 * - Rate-limited per workspace (hourly + daily sliding windows via WorkspaceDO)
 * - Recipients must be workspace members (email whitelist)
 */

import type { RouteContext } from '../types.js';
import { validateSandboxProxy } from '../sandbox-auth.js';
import { getWorkspaceStub, getUserStub, getOrgStub } from '../helpers/stubs.js';
import { buildWorkspaceEmailSenderAddress, getWorkspaceEmailDomain } from '../../../../src/lib/workspace-email.js';
import { getBillingPlanLimits } from '../../../../src/lib/billing-plans.js';

// ---------------------------------------------------------------------------
// Rate limit constants
// ---------------------------------------------------------------------------

const RATE_LIMIT_HOURLY = 50;
const RATE_LIMIT_DAILY = 200;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

interface EmailSendProxyRequest {
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  reply_to?: string;
  subject: string;
  text?: string;
  html?: string;
}

/**
 * Extract a bare email address from a potentially formatted recipient string
 * like `"Name <email@example.com>"` or just `"email@example.com"`.
 *
 * Returns null if the string contains commas or multiple angle-bracket groups,
 * which could be an attempt to smuggle extra addresses past whitelist validation.
 */
function extractEmail(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.includes(',')) return null;

  const angleBrackets = trimmed.match(/<[^>]+>/g);
  if (angleBrackets && angleBrackets.length > 1) return null;

  const match = trimmed.match(/<([^>]+)>/);
  return (match ? match[1] : trimmed).trim().toLowerCase();
}

function normalizeRecipients(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') {
    const email = extractEmail(value);
    return email ? [email] : null;
  }
  if (
    Array.isArray(value) &&
    value.every((e): e is string => typeof e === 'string')
  ) {
    const emails = value.map((e) => extractEmail(e));
    if (emails.some((e) => e === null)) return null;
    return emails as string[];
  }
  return null; // invalid type
}

// ---------------------------------------------------------------------------
// Workspace member email resolution
// ---------------------------------------------------------------------------

async function getWorkspaceMemberEmails(
  env: RouteContext['env'],
  workspaceId: string
): Promise<Set<string>> {
  const workspaceStub = getWorkspaceStub(env, workspaceId);
  const members = await workspaceStub.listMembers();
  const activeMembers = members.filter((m) => m.access_level !== 'none');

  console.log(`[EmailSendProxy] workspace=${workspaceId} members=${members.length} active=${activeMembers.length}`);

  const emails = await Promise.all(
    activeMembers.map(async (member) => {
      try {
        const userStub = getUserStub(env, member.user_id);
        const profile = await userStub.getProfile();
        const email = profile?.email?.toLowerCase() ?? null;
        if (!email) {
          console.warn(`[EmailSendProxy] user=${member.user_id} profile has no email (profile=${profile ? 'exists' : 'null'})`);
        }
        return email;
      } catch (err) {
        console.error(`[EmailSendProxy] failed to resolve email for user=${member.user_id}:`, err);
        return null;
      }
    })
  );

  const emailSet = new Set(emails.filter((e): e is string => e !== null));
  console.log(`[EmailSendProxy] allowed emails: [${[...emailSet].join(', ')}]`);
  return emailSet;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * POST /api/email/send
 */
export async function handleEmailSendProxy({ req, env }: RouteContext): Promise<Response> {
  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405);
  }

  // 1. Sandbox proxy auth
  const proxyAuth = validateSandboxProxy(req, env);
  if (!proxyAuth.valid) {
    return errorResponse('Unauthorized: sandbox proxy auth required', 401);
  }

  const { orgId, workspaceId } = proxyAuth;

  const orgInfo = await getOrgStub(env, orgId).getInfo();
  if (
    !orgInfo ||
    !getBillingPlanLimits(orgInfo.billing_plan, orgInfo.billing_status)
      .emailInbox
  ) {
    return errorResponse('Workspace email inbox requires a Starter, Pro, Team, or Enterprise plan', 403);
  }

  // 2. Require Cloudflare Email Sending binding
  if (!env.EMAIL) {
    return errorResponse('Cloudflare Email Sending binding EMAIL is not configured', 503);
  }

  // 3. Parse request body
  let payload: EmailSendProxyRequest;
  try {
    payload = (await req.json()) as EmailSendProxyRequest;
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  if (!payload.to || !payload.subject) {
    return errorResponse('Missing required fields: to, subject', 400);
  }

  // 4. Collect all recipient emails
  const toEmails = normalizeRecipients(payload.to);
  const ccEmails = normalizeRecipients(payload.cc);
  const bccEmails = normalizeRecipients(payload.bcc);
  if (toEmails === null || ccEmails === null || bccEmails === null) {
    return errorResponse('Invalid recipient field: to, cc, and bcc must be strings or arrays of strings', 400);
  }
  if (payload.reply_to !== undefined && typeof payload.reply_to !== 'string') {
    return errorResponse('Invalid reply_to field: reply_to must be a string', 400);
  }
  const allRecipients = [...toEmails, ...ccEmails, ...bccEmails];

  if (allRecipients.length === 0) {
    return errorResponse('No recipients specified', 400);
  }

  // 5. Resolve workspace from address
  const workspaceStubForInfo = getWorkspaceStub(env, workspaceId);
  const workspaceInfo = await workspaceStubForInfo.getInfo();
  const emailDomain = getWorkspaceEmailDomain(env);
  if (!workspaceInfo?.email_handle || !emailDomain) {
    return errorResponse('Workspace email not configured', 503);
  }
  const workspaceFromAddress = buildWorkspaceEmailSenderAddress(
    workspaceInfo.email_handle,
    emailDomain,
  );

  // 6. Validate recipients against workspace member whitelist
  console.log(`[EmailSendProxy] validating recipients: [${allRecipients.join(', ')}] workspace=${workspaceId}`);
  const allowedEmails = await getWorkspaceMemberEmails(env, workspaceId);
  const disallowed = allRecipients.filter((email) => !allowedEmails.has(email));
  if (disallowed.length > 0) {
    console.warn(`[EmailSendProxy] rejected recipients: [${disallowed.join(', ')}] allowed: [${[...allowedEmails].join(', ')}]`);
    return errorResponse(
      `Recipients not in workspace: ${disallowed.join(', ')}. Only workspace members can be emailed.`,
      403
    );
  }

  // 7. Rate limit check (atomic inside WorkspaceDO)
  const workspaceStub = getWorkspaceStub(env, workspaceId);
  const rateCheck = await workspaceStub.checkAndRecordEmailSendRateLimit(
    allRecipients.length,
    RATE_LIMIT_HOURLY,
    RATE_LIMIT_DAILY
  );
  if (!rateCheck.allowed) {
    return errorResponse(rateCheck.reason!, 429);
  }

  // 8. Send through Cloudflare Email Sending (always from workspace address)
  try {
    const emailResult = await env.EMAIL.send({
      from: workspaceFromAddress,
      to: toEmails,
      ...(ccEmails.length > 0 ? { cc: ccEmails } : {}),
      ...(bccEmails.length > 0 ? { bcc: bccEmails } : {}),
      ...(payload.reply_to ? { replyTo: payload.reply_to } : {}),
      subject: payload.subject,
      ...(payload.text ? { text: payload.text } : {}),
      ...(payload.html ? { html: payload.html } : {}),
    });

    return jsonResponse({ id: emailResult.messageId, from: workspaceFromAddress }, 200);
  } catch (error) {
    console.error('[email-send-proxy] upstream error', {
      error: error instanceof Error ? error.message : String(error),
      orgId,
      workspaceId,
    });
    return errorResponse('Failed to send email', 502);
  }
}
