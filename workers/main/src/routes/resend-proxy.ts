/**
 * Resend Email Proxy for sandbox containers.
 *
 * - Trusted only when forwarded through sandbox-host (x-sandbox-secret auth)
 * - Rate-limited per workspace (hourly + daily sliding windows via WorkspaceDO)
 * - Recipients must be workspace members (email whitelist)
 */

import type { RouteContext } from '../types.js';
import { validateSandboxProxy } from '../sandbox-auth.js';
import { getWorkspaceStub, getUserStub } from '../helpers/stubs.js';

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

interface ResendProxyRequest {
  from: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  reply_to?: string | string[];
  subject: string;
  text?: string;
  html?: string;
}

function normalizeRecipients(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') return [value.toLowerCase()];
  if (
    Array.isArray(value) &&
    value.every((e): e is string => typeof e === 'string')
  ) {
    return value.map((e) => e.toLowerCase());
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

  const emails = await Promise.all(
    activeMembers.map(async (member) => {
      try {
        const userStub = getUserStub(env, member.user_id);
        const profile = await userStub.getProfile();
        return profile?.email?.toLowerCase() ?? null;
      } catch {
        return null;
      }
    })
  );

  return new Set(emails.filter((e): e is string => e !== null));
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * POST /api/resend/emails
 */
export async function handleResendProxy({ req, env }: RouteContext): Promise<Response> {
  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405);
  }

  // 1. Sandbox proxy auth
  const proxyAuth = validateSandboxProxy(req, env);
  if (!proxyAuth.valid) {
    return errorResponse('Unauthorized: sandbox proxy auth required', 401);
  }

  const { orgId, workspaceId } = proxyAuth;

  // 2. Require Resend API key
  if (!env.RESEND_API_KEY) {
    return errorResponse('Resend API key not configured', 503);
  }

  // 3. Parse request body
  let payload: ResendProxyRequest;
  try {
    payload = (await req.json()) as ResendProxyRequest;
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
  const allRecipients = [...toEmails, ...ccEmails, ...bccEmails];

  if (allRecipients.length === 0) {
    return errorResponse('No recipients specified', 400);
  }

  // 5. Validate recipients against workspace member whitelist
  const allowedEmails = await getWorkspaceMemberEmails(env, workspaceId);
  const disallowed = allRecipients.filter((email) => !allowedEmails.has(email));
  if (disallowed.length > 0) {
    return errorResponse(
      `Recipients not in workspace: ${disallowed.join(', ')}. Only workspace members can be emailed.`,
      403
    );
  }

  // 6. Rate limit check (atomic inside WorkspaceDO)
  const workspaceStub = getWorkspaceStub(env, workspaceId);
  const rateCheck = await workspaceStub.checkAndRecordResendRateLimit(
    allRecipients.length,
    RATE_LIMIT_HOURLY,
    RATE_LIMIT_DAILY
  );
  if (!rateCheck.allowed) {
    return errorResponse(rateCheck.reason!, 429);
  }

  // 7. Forward to Resend API
  try {
    const resendResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: payload.from,
        to: payload.to,
        ...(payload.cc ? { cc: payload.cc } : {}),
        ...(payload.bcc ? { bcc: payload.bcc } : {}),
        ...(payload.reply_to ? { reply_to: payload.reply_to } : {}),
        subject: payload.subject,
        ...(payload.text ? { text: payload.text } : {}),
        ...(payload.html ? { html: payload.html } : {}),
      }),
    });

    const body = await resendResponse.text();
    return new Response(body, {
      status: resendResponse.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[resend-proxy] upstream error', {
      error: error instanceof Error ? error.message : String(error),
      orgId,
      workspaceId,
    });
    return errorResponse('Failed to send email', 502);
  }
}
