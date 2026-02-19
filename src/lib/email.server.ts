import type { CloudflareEnv } from './cloudflare.server';
import { render, toPlainText } from '@react-email/render';
import { createElement } from 'react';
import { OrgInvitationEmailTemplate } from './email/templates/org-invitation-email';
import { EmailVerificationEmailTemplate } from './email/templates/email-verification-email';
import { HelpConfirmationEmailTemplate } from './email/templates/help-confirmation-email';
import { HelpSupportEmailTemplate } from './email/templates/help-support-email';
import { sendEmail, getGmailConfig, isGmailConfigured } from './gmail.server';
import {
  recordDevEmailOutboxEntry,
  type DevEmailOutboxStatus,
  type DevEmailOutboxTransport,
} from './dev-email-outbox';

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
> &
  Partial<Pick<CloudflareEnv, 'APP_KV' | 'NEXTJS_ENV'>>;

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

interface HelpConfirmationEmailArgs {
  env: EmailEnvBindings;
  to: string;
  firstName: string;
  userEmail: string;
  category: string;
  severity: string;
  subject: string;
  description: string;
  cc?: string;
  replyTo?: string;
}

interface HelpSupportEmailArgs {
  env: EmailEnvBindings;
  to: string;
  userName: string | null;
  userEmail: string;
  userId: string;
  orgName: string;
  orgSlug: string;
  orgId: string;
  billingStatus: string;
  workspaceName: string | null;
  workspaceId: string | null;
  pageUrl: string | null;
  category: string;
  severity: string;
  subject: string;
  description: string;
  submittedAt: string;
  userAgent: string | null;
  screenSize: string | null;
  referer: string | null;
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

function truncateWithEllipsis(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function normalizeOptionalEmail(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function supportCategoryTag(category: string): string {
  const normalized = category.trim().toLowerCase();
  if (normalized.startsWith('bug')) return 'Bug';
  if (normalized.startsWith('feature')) return 'Feature';
  if (normalized.includes('billing')) return 'Billing';
  if (normalized.startsWith('question')) return 'Question';
  return 'Other';
}

function supportSeverityTag(severity: string): string {
  const normalized = severity.trim().toLowerCase();
  if (normalized === 'high') return 'High';
  if (normalized === 'medium') return 'Medium';
  return 'Low';
}

function buildEnvelopeRecipients(to: string, cc?: string): string[] {
  const recipients = [to, cc].filter((value): value is string => Boolean(value));
  return Array.from(
    new Set(
      recipients.map((value) => value.trim().toLowerCase()).filter((value) => value.length > 0)
    )
  );
}

async function finalizeEmailDelivery(
  env: EmailEnvBindings,
  email: {
    to: string;
    cc?: string;
    replyTo?: string;
    subject: string;
    textBody: string;
    htmlBody: string;
  },
  result: { status: DevEmailOutboxStatus; reason?: string },
  transport: DevEmailOutboxTransport
): Promise<EmailDeliveryResult> {
  await recordDevEmailOutboxEntry(env, {
    to: email.to,
    cc: email.cc,
    replyTo: email.replyTo,
    subject: email.subject,
    textBody: email.textBody,
    htmlBody: email.htmlBody,
    status: result.status,
    reason: result.reason,
    transport,
  });
  return result;
}

async function deliverEmail({
  env,
  to,
  cc,
  replyTo,
  subject,
  htmlBody,
  textBody,
}: {
  env: EmailEnvBindings;
  to: string;
  cc?: string;
  replyTo?: string;
  subject: string;
  htmlBody: string;
  textBody: string;
}): Promise<EmailDeliveryResult> {
  const normalizedCc = normalizeOptionalEmail(cc);
  const normalizedReplyTo = normalizeOptionalEmail(replyTo);
  const emailContent = {
    to,
    cc: normalizedCc,
    replyTo: normalizedReplyTo,
    subject,
    textBody,
    htmlBody,
  };

  // Try Gmail API first (preferred for sending to external recipients)
  if (isGmailConfigured(env)) {
    const gmailConfig = getGmailConfig(env)!;
    const result = await sendEmail(gmailConfig, {
      to,
      cc: normalizedCc,
      replyTo: normalizedReplyTo,
      subject,
      textBody,
      htmlBody,
    });

    if (result.success) {
      return finalizeEmailDelivery(env, emailContent, { status: 'sent' }, 'gmail');
    }
    return finalizeEmailDelivery(
      env,
      emailContent,
      { status: 'failed', reason: result.error },
      'gmail'
    );
  }

  // Fall back to Cloudflare email binding (only works for verified addresses)
  if (!env.EMAIL) {
    return finalizeEmailDelivery(
      env,
      emailContent,
      {
        status: 'skipped',
        reason: 'No email provider configured (Gmail API or Cloudflare EMAIL binding)',
      },
      'none'
    );
  }

  const from = env.EMAIL_FROM_ADDRESS?.trim();
  if (!from) {
    return finalizeEmailDelivery(
      env,
      emailContent,
      {
        status: 'skipped',
        reason: 'EMAIL_FROM_ADDRESS is not configured',
      },
      'cloudflare'
    );
  }

  try {
    const messageId = crypto.randomUUID();
    const boundary = `chiridion_${messageId.replaceAll('-', '')}`;
    const rawMessage = [
      `From: camelAI <${sanitizeHeaderValue(from)}>`,
      `To: ${sanitizeHeaderValue(to)}`,
      ...(normalizedCc ? [`Cc: ${sanitizeHeaderValue(normalizedCc)}`] : []),
      ...(normalizedReplyTo
        ? [`Reply-To: ${sanitizeHeaderValue(normalizedReplyTo)}`]
        : []),
      `Subject: ${subject}`,
      `Message-ID: <${messageId}@camelai.com>`,
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
    const envelopeRecipients = buildEnvelopeRecipients(to, normalizedCc);
    await Promise.all(
      envelopeRecipients.map((recipient) => {
        const message = new EmailMessage(from, recipient, rawMessage);
        return env.EMAIL!.send(message);
      })
    );
    return finalizeEmailDelivery(env, emailContent, { status: 'sent' }, 'cloudflare');
  } catch (error) {
    const reason =
      error instanceof Error && error.message
        ? error.message
        : 'Unknown email delivery error';
    return finalizeEmailDelivery(
      env,
      emailContent,
      { status: 'failed', reason },
      'cloudflare'
    );
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
  const subject = sanitizeHeaderValue(`You're invited to join ${orgName} on camelAI`);
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
  const subject = sanitizeHeaderValue('Verify your email for camelAI');
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

export async function sendHelpConfirmationEmail({
  env,
  to,
  firstName,
  userEmail,
  category,
  severity,
  subject,
  description,
  cc,
  replyTo,
}: HelpConfirmationEmailArgs): Promise<EmailDeliveryResult> {
  const normalizedTo = to.trim().toLowerCase();
  const normalizedFirstName = firstName.trim() || 'there';
  const normalizedSubjectText = subject.trim() || category;
  const emailSubject = sanitizeHeaderValue(
    `We received your request - ${normalizedSubjectText}`
  );
  const normalizedDescription = truncateWithEllipsis(description.trim(), 500);

  const htmlBody = await render(
    createElement(HelpConfirmationEmailTemplate, {
      firstName: normalizedFirstName,
      userEmail,
      category,
      severity,
      description: normalizedDescription,
    })
  );
  const textBody = toPlainText(htmlBody);

  return deliverEmail({
    env,
    to: normalizedTo,
    cc,
    replyTo,
    subject: emailSubject,
    htmlBody,
    textBody,
  });
}

export async function sendHelpSupportEmail({
  env,
  to,
  userName,
  userEmail,
  userId,
  orgName,
  orgSlug,
  orgId,
  billingStatus,
  workspaceName,
  workspaceId,
  pageUrl,
  category,
  severity,
  subject,
  description,
  submittedAt,
  userAgent,
  screenSize,
  referer,
}: HelpSupportEmailArgs): Promise<EmailDeliveryResult> {
  const normalizedTo = to.trim().toLowerCase();
  const userDisplayName = userName?.trim() || userEmail;
  const severityTag = supportSeverityTag(severity);
  const categoryTag = supportCategoryTag(category);
  const normalizedSubjectText = subject.trim() || category;
  const emailSubject = sanitizeHeaderValue(
    `[${severityTag}] [${categoryTag}] ${normalizedSubjectText} - ${userDisplayName} (${orgSlug})`
  );

  const htmlBody = await render(
    createElement(HelpSupportEmailTemplate, {
      userName,
      userEmail,
      userId,
      orgName,
      orgSlug,
      orgId,
      billingStatus,
      workspaceName,
      workspaceId,
      pageUrl,
      category,
      severity: severityTag,
      subject: normalizedSubjectText,
      description,
      submittedAt,
      userAgent,
      screenSize,
      referer,
    })
  );
  const textBody = toPlainText(htmlBody);

  return deliverEmail({
    env,
    to: normalizedTo,
    subject: emailSubject,
    htmlBody,
    textBody,
  });
}
