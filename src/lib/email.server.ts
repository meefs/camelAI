import type { CloudflareEnv } from './cloudflare.server';
import { render, toPlainText } from '@react-email/render';
import { createElement } from 'react';
import { OrgInvitationEmailTemplate } from './email/templates/org-invitation-email';
import { EmailVerificationEmailTemplate } from './email/templates/email-verification-email';
import { sendEmail, getGmailConfig, isGmailConfigured } from './gmail.server';

export type EmailDeliveryStatus = 'sent' | 'skipped' | 'failed';

export interface EmailDeliveryResult {
  status: EmailDeliveryStatus;
  reason?: string;
}

type EmailEnvBindings = Pick<
  CloudflareEnv,
  | 'EMAIL'
  | 'EMAIL_FROM_ADDRESS'
  | 'GMAIL_SERVICE_ACCOUNT_EMAIL'
  | 'GMAIL_SERVICE_ACCOUNT_PRIVATE_KEY'
  | 'GMAIL_SENDER_EMAIL'
>;

interface OrgInvitationEmailArgs {
  env: EmailEnvBindings;
  to: string;
  orgName: string;
  inviterName: string | null;
  role: string;
  invitationUrl: string;
  expiresAt: number;
}

interface EmailVerificationEmailArgs {
  env: EmailEnvBindings;
  to: string;
  verificationUrl: string;
  expiresAt: number;
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function roleLabel(role: string): string {
  const normalized = role.trim().toLowerCase();
  if (normalized === 'admin') return 'Admin';
  if (normalized === 'member') return 'Member';
  if (normalized === 'viewer') return 'Viewer';
  return role;
}

export function resolveAppBaseUrl(
  env: Pick<CloudflareEnv, 'WORKER_BASE_URL'>,
  requestUrl: URL
): string {
  const configured = env.WORKER_BASE_URL?.trim();
  if (!configured) {
    return requestUrl.origin;
  }

  try {
    return normalizeBaseUrl(new URL(configured).toString());
  } catch {
    return requestUrl.origin;
  }
}

export function buildInvitationUrl(baseUrl: string, orgId: string, invitationId: string): string {
  return new URL(`/invitations/${orgId}/${invitationId}`, normalizeBaseUrl(baseUrl)).toString();
}

function formatExpiration(expiresAt: number): string {
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) {
    return 'soon';
  }
  return date.toUTCString();
}

async function deliverEmail({
  env,
  to,
  subject,
  htmlBody,
  textBody,
}: {
  env: EmailEnvBindings;
  to: string;
  subject: string;
  htmlBody: string;
  textBody: string;
}): Promise<EmailDeliveryResult> {
  // Try Gmail API first (preferred for sending to external recipients)
  if (isGmailConfigured(env)) {
    const gmailConfig = getGmailConfig(env)!;
    const result = await sendEmail(gmailConfig, {
      to,
      subject,
      textBody,
      htmlBody,
    });

    if (result.success) {
      return { status: 'sent' };
    }
    return { status: 'failed', reason: result.error };
  }

  // Fall back to Cloudflare email binding (only works for verified addresses)
  if (!env.EMAIL) {
    return {
      status: 'skipped',
      reason: 'No email provider configured (Gmail API or Cloudflare EMAIL binding)',
    };
  }

  const from = env.EMAIL_FROM_ADDRESS?.trim();
  if (!from) {
    return {
      status: 'skipped',
      reason: 'EMAIL_FROM_ADDRESS is not configured',
    };
  }

  try {
    const messageId = crypto.randomUUID();
    const boundary = `chiridion_${messageId.replaceAll('-', '')}`;
    const rawMessage = [
      `From: Chiridion <${sanitizeHeaderValue(from)}>`,
      `To: ${sanitizeHeaderValue(to)}`,
      `Subject: ${subject}`,
      `Message-ID: <${messageId}@chiridion.ai>`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      textBody,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      htmlBody,
      '',
      `--${boundary}--`,
      '',
    ].join('\r\n');

    const cloudflareEmailModule = 'cloudflare:email';
    const { EmailMessage } = await import(
      /* @vite-ignore */
      cloudflareEmailModule
    );
    const message = new EmailMessage(from, to, rawMessage);
    await env.EMAIL.send(message);
    return { status: 'sent' };
  } catch (error) {
    const reason =
      error instanceof Error && error.message
        ? error.message
        : 'Unknown email delivery error';
    return { status: 'failed', reason };
  }
}

export async function sendOrgInvitationEmail({
  env,
  to,
  orgName,
  inviterName,
  role,
  invitationUrl,
  expiresAt,
}: OrgInvitationEmailArgs): Promise<EmailDeliveryResult> {
  const normalizedTo = to.trim().toLowerCase();
  const inviter = inviterName?.trim() || 'A team member';
  const subject = sanitizeHeaderValue(`You're invited to join ${orgName} on Chiridion`);
  const expiration = formatExpiration(expiresAt);
  const displayRole = roleLabel(role);

  // Render email content
  const htmlBody = await render(
    createElement(OrgInvitationEmailTemplate, {
      orgName,
      inviterName: inviter,
      role: displayRole,
      invitationUrl,
      expirationLabel: expiration,
    })
  );
  const textBody = toPlainText(htmlBody);

  return deliverEmail({
    env,
    to: normalizedTo,
    subject,
    htmlBody,
    textBody,
  });
}

export async function sendEmailVerificationEmail({
  env,
  to,
  verificationUrl,
  expiresAt,
}: EmailVerificationEmailArgs): Promise<EmailDeliveryResult> {
  const normalizedTo = to.trim().toLowerCase();
  const subject = sanitizeHeaderValue('Verify your email for Chiridion');
  const expiration = formatExpiration(expiresAt);

  const htmlBody = await render(
    createElement(EmailVerificationEmailTemplate, {
      verificationUrl,
      expirationLabel: expiration,
    })
  );
  const textBody = toPlainText(htmlBody);

  return deliverEmail({
    env,
    to: normalizedTo,
    subject,
    htmlBody,
    textBody,
  });
}
