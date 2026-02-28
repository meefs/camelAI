import { EmailMessage } from 'cloudflare:email';
import PostalMime from 'postal-mime';
import type { Env } from './types.js';
import type { ExternalTurnResult } from './durable-objects.js';
import { runExternalMessageTurn } from './helpers/external-turn.js';
import { getOrgStub, getUserStub, getWorkspaceStub } from './helpers/stubs.js';
import {
  buildWorkspaceInboxAddress,
  getWorkspaceEmailRoutingConfig,
  parseMailboxAddress,
  parseWorkspaceInboxAddress,
} from '../../../src/lib/workspace-email.js';

interface AuthorizedSender {
  userId: string;
  userName: string;
  userEmail: string;
  workspaceId: string;
  orgId: string;
}

interface EmailThreadResolution {
  threadId: string;
  title: string;
}

const EMAIL_EVENT_DEDUPE_PREFIX = 'email_event:';
const EMAIL_EVENT_DEDUPE_TTL_SECONDS = 10 * 60;
const EMAIL_EVENT_DEDUPE_PROCESSING_TTL_SECONDS = 5 * 60;
const EMAIL_EVENT_DEDUPE_PROCESSING_MAX_AGE_MS = EMAIL_EVENT_DEDUPE_PROCESSING_TTL_SECONDS * 1000;
const EMAIL_EVENT_DEDUPE_DONE_VALUE = 'done';
const EMAIL_EVENT_DEDUPE_LEGACY_DONE_VALUE = '1';
const EMAIL_REPLY_REFERENCE_PREFIX = 'email_reply_ref:';
const EMAIL_REPLY_REFERENCE_TTL_SECONDS = 180 * 24 * 60 * 60;
const DEFAULT_EXTERNAL_TURN_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_EMAIL_RAW_SIZE_BYTES = 2 * 1024 * 1024;

function sanitizeHeaderValue(value: string, maxLength = 200): string {
  return value.replace(/[\r\n]+/g, ' ').trim().slice(0, maxLength);
}

function normalizeMessageId(rawValue: string | null): string | null {
  if (!rawValue) return null;
  const sanitized = sanitizeHeaderValue(rawValue, 512).replace(/^<|>$/g, '').trim().toLowerCase();
  return sanitized || null;
}

function normalizeMessageIdForHeader(rawValue: string | null): string | null {
  const normalized = normalizeMessageId(rawValue);
  if (!normalized) return null;
  const safe = normalized.replace(/[<>\s]/g, '');
  return safe ? `<${safe}>` : null;
}

function toDedupeFragment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 160);
}

function getEmailDedupeKey(workspaceId: string, messageId: string): string {
  const workspacePart = toDedupeFragment(workspaceId) || 'ws';
  const messagePart = toDedupeFragment(messageId) || 'msg';
  return `${EMAIL_EVENT_DEDUPE_PREFIX}${workspacePart}:${messagePart}`;
}

function buildEmailProcessingDedupeValue(token: string, startedAt: number): string {
  return `processing:${token}:${startedAt}`;
}

function parseEmailDedupeValue(rawValue: string | null): {
  state: 'done' | 'processing';
  token?: string;
  startedAt?: number;
} | null {
  if (!rawValue) return null;
  if (rawValue === EMAIL_EVENT_DEDUPE_DONE_VALUE || rawValue === EMAIL_EVENT_DEDUPE_LEGACY_DONE_VALUE) {
    return { state: 'done' };
  }

  if (!rawValue.startsWith('processing:')) {
    return null;
  }

  const parts = rawValue.split(':');
  if (parts.length !== 3) return null;
  const token = parts[1]?.trim();
  const startedAt = Number(parts[2]);
  if (!token || !Number.isFinite(startedAt) || startedAt <= 0) {
    return null;
  }

  return {
    state: 'processing',
    token,
    startedAt,
  };
}

function getEmailReplyReferenceKey(workspaceId: string, messageId: string): string {
  const safeMessageId = messageId.toLowerCase().replace(/[^a-z0-9@._-]/g, '_').slice(0, 400);
  return `${EMAIL_REPLY_REFERENCE_PREFIX}${workspaceId}:${safeMessageId}`;
}

function stripSubjectPrefixes(subject: string): string {
  return subject.replace(/^(\s*(re|fw|fwd)\s*:\s*)+/i, '').trim();
}

function titleFromEmail(subject: string, body: string): string {
  const subjectTitle = stripSubjectPrefixes(subject);
  if (subjectTitle) return subjectTitle.slice(0, 100);

  const firstLine = body.split('\n').map((line) => line.trim()).find(Boolean) || 'Email conversation';
  return firstLine.slice(0, 100);
}

function stripHtmlTags(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .trim();
}

async function extractEmailText(message: ForwardableEmailMessage): Promise<string> {
  const rawBytes = await new Response(message.raw).arrayBuffer();

  try {
    const parser = new PostalMime();
    const parsed = await parser.parse(rawBytes) as {
      text?: string | null;
      html?: string | null;
    };

    const text = parsed.text?.trim() || '';
    if (text) return text;

    const html = parsed.html?.trim() || '';
    return html ? stripHtmlTags(html) : '';
  } catch {
    // Fallback for malformed MIME: take bytes after header separator.
    const raw = new TextDecoder().decode(rawBytes);
    const normalized = raw.replace(/\r\n/g, '\n');
    const splitIndex = normalized.indexOf('\n\n');
    return (splitIndex >= 0 ? normalized.slice(splitIndex + 2) : normalized).trim();
  }
}

function stripQuotedReplyContent(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return '';

  const lines = normalized.split('\n');
  const kept: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^on\s.+wrote:\s*$/i.test(trimmed)) break;
    if (/^[-_]{2,}\s*original message\s*[-_]{2,}$/i.test(trimmed)) break;
    if (/^from:\s.+@.+$/i.test(trimmed) && kept.length > 0) break;
    if (trimmed.startsWith('>') && kept.length > 0) break;
    kept.push(line);
  }

  return kept.join('\n').trim();
}

async function resolveAuthorizedSender(
  env: Env,
  workspaceId: string,
  senderEmail: string
): Promise<AuthorizedSender | null> {
  const userId = await env.EMAIL_TO_USER.get(`email:${senderEmail}`);
  if (!userId) return null;

  const wsStub = getWorkspaceStub(env, workspaceId);
  const workspaceInfo = await wsStub.getInfo();
  if (!workspaceInfo || workspaceInfo.archived) return null;

  const orgStub = getOrgStub(env, workspaceInfo.org_id);
  const [isOrgMember, memberAccess, profile] = await Promise.all([
    orgStub.isMember(userId),
    wsStub.getMemberAccess(userId),
    getUserStub(env, userId).getProfile(),
  ]);

  if (!isOrgMember) return null;
  if ((memberAccess?.access_level ?? 'full') !== 'full') return null;

  return {
    userId,
    userName: profile?.name?.trim() || senderEmail,
    userEmail: senderEmail,
    workspaceId,
    orgId: workspaceInfo.org_id,
  };
}

function extractMessageIdsFromHeaderValue(rawValue: string | null): string[] {
  if (!rawValue) return [];

  const normalized = sanitizeHeaderValue(rawValue, 1200);
  if (!normalized) return [];

  const extracted = Array.from(normalized.matchAll(/<([^>]+)>/g))
    .map((match) => normalizeMessageId(match[1] || ''))
    .filter((value): value is string => Boolean(value));

  if (extracted.length > 0) return extracted;
  const fallback = normalizeMessageId(normalized);
  return fallback ? [fallback] : [];
}

function getReplyReferenceCandidates(headers: Headers): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  const inReplyTo = extractMessageIdsFromHeaderValue(headers.get('in-reply-to'));
  const references = extractMessageIdsFromHeaderValue(headers.get('references')).reverse();

  for (const value of [...inReplyTo, ...references]) {
    if (seen.has(value)) continue;
    seen.add(value);
    candidates.push(value);
  }

  return candidates;
}

async function resolveThreadFromReplyHeaders(
  env: Env,
  args: {
    workspaceId: string;
    orgId: string;
    headers: Headers;
  }
): Promise<EmailThreadResolution | null> {
  const references = getReplyReferenceCandidates(args.headers);
  if (references.length === 0) return null;

  const orgStub = getOrgStub(env, args.orgId);
  for (const messageId of references) {
    const key = getEmailReplyReferenceKey(args.workspaceId, messageId);
    const mappedThreadId = await env.APP_KV.get(key);
    if (!mappedThreadId) continue;

    const thread = await orgStub.getThread(mappedThreadId);
    if (thread && thread.workspace_id === args.workspaceId) {
      return {
        threadId: thread.id,
        title: thread.title || 'Email conversation',
      };
    }

    await env.APP_KV.delete(key);
  }

  return null;
}

async function resolveThreadForEmail(
  env: Env,
  args: {
    workspaceId: string;
    orgId: string;
    headers: Headers;
    subject: string;
    message: string;
    userId: string;
  }
): Promise<EmailThreadResolution> {
  const fromReplyHeaders = await resolveThreadFromReplyHeaders(env, {
    workspaceId: args.workspaceId,
    orgId: args.orgId,
    headers: args.headers,
  });
  if (fromReplyHeaders) return fromReplyHeaders;

  const orgStub = getOrgStub(env, args.orgId);
  const title = titleFromEmail(args.subject, args.message);
  const created = await orgStub.createThread(
    args.workspaceId,
    title,
    args.userId,
    args.message.slice(0, 500)
  );

  return {
    threadId: created.id,
    title: created.title,
  };
}

function formatReplySubject(inboundSubject: string, fallback: string): string {
  const cleanInbound = sanitizeHeaderValue(inboundSubject, 180);
  if (cleanInbound) {
    return /^re:/i.test(cleanInbound) ? cleanInbound : `Re: ${cleanInbound}`;
  }

  const cleanFallback = sanitizeHeaderValue(fallback, 160) || 'camelAI conversation';
  return `Re: ${cleanFallback}`;
}

function createReplyMessageId(threadId: string, domain: string): string {
  const safeThreadId = threadId.replace(/[^a-z0-9-]/gi, '').slice(0, 64) || 'thread';
  const safeDomain = domain.toLowerCase().replace(/[^a-z0-9.-]/g, '');
  return `camelai.${safeThreadId}.${crypto.randomUUID()}@${safeDomain}`;
}

async function sendReply(
  inbound: ForwardableEmailMessage,
  args: {
    fromAddress: string;
    toAddress: string;
    replyToAddress: string;
    subject: string;
    body: string;
    messageId: string;
  }
): Promise<string | null> {
  const subject = sanitizeHeaderValue(args.subject, 240) || 'Re: camelAI';
  const fromAddress = sanitizeHeaderValue(args.fromAddress, 320);
  const toAddress = sanitizeHeaderValue(args.toAddress, 320);
  const replyToAddress = sanitizeHeaderValue(args.replyToAddress, 320);
  const body = args.body.replace(/\r\n/g, '\n').trim().slice(0, 50_000);

  const headers: string[] = [
    `From: camelAI <${fromAddress}>`,
    `To: ${toAddress}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    `Reply-To: ${replyToAddress}`,
  ];

  const replyMessageIdHeader = normalizeMessageIdForHeader(args.messageId);
  if (replyMessageIdHeader) {
    headers.push(`Message-ID: ${replyMessageIdHeader}`);
  }

  const inReplyTo = normalizeMessageIdForHeader(inbound.headers.get('message-id'));
  if (inReplyTo) {
    headers.push(`In-Reply-To: ${inReplyTo}`);

    const references = sanitizeHeaderValue(inbound.headers.get('references') || '', 600);
    const merged = references ? `${references} ${inReplyTo}`.trim() : inReplyTo;
    headers.push(`References: ${merged}`);
  }

  const raw = `${headers.join('\r\n')}\r\n\r\n${body}\r\n`;
  await inbound.reply(new EmailMessage(fromAddress, toAddress, raw));
  return normalizeMessageId(args.messageId);
}

function outcomeToReplyText(result: ExternalTurnResult): string {
  if (result.status === 'result') return result.reply?.trim() || 'Done.';
  if (result.status === 'busy') {
    return 'camelAI is still processing the previous email for this thread. Please try again in a moment.';
  }
  if (result.status === 'error') return result.error || 'I could not process that email right now.';
  return 'I could not process that email right now.';
}

export async function handleWorkspaceEmailIngress(message: ForwardableEmailMessage, env: Env): Promise<void> {
  if (message.rawSize > MAX_EMAIL_RAW_SIZE_BYTES) {
    message.setReject('Email is too large. Maximum size is 2 MiB.');
    return;
  }

  const routingConfig = getWorkspaceEmailRoutingConfig(env);
  const recipient = parseWorkspaceInboxAddress(message.to, {
    expectedDomain: routingConfig?.domain,
    expectedLocalPart: routingConfig?.localPart,
  });
  if (!recipient) {
    message.setReject('Unknown workspace email address.');
    return;
  }

  const sender = parseMailboxAddress(message.from);
  if (!sender) {
    message.setReject('Invalid sender address.');
    return;
  }

  const senderEmail = `${sender.local}@${sender.domain}`;
  const authorizedSender = await resolveAuthorizedSender(env, recipient.workspaceId, senderEmail);
  if (!authorizedSender) {
    message.setReject('Sender is not allowed for this workspace inbox.');
    return;
  }

  const normalizedMessageId = normalizeMessageId(message.headers.get('message-id'));
  const dedupeKey = normalizedMessageId
    ? getEmailDedupeKey(recipient.workspaceId, normalizedMessageId)
    : null;
  let dedupeProcessingValue: string | null = null;
  let dedupeHandled = false;
  if (dedupeKey) {
    const existing = parseEmailDedupeValue(await env.APP_KV.get(dedupeKey));
    if (existing?.state === 'done') return;
    if (
      existing?.state === 'processing' &&
      typeof existing.startedAt === 'number' &&
      Date.now() - existing.startedAt < EMAIL_EVENT_DEDUPE_PROCESSING_MAX_AGE_MS
    ) {
      return;
    }

    dedupeProcessingValue = buildEmailProcessingDedupeValue(crypto.randomUUID(), Date.now());
    await env.APP_KV.put(dedupeKey, dedupeProcessingValue, {
      expirationTtl: EMAIL_EVENT_DEDUPE_PROCESSING_TTL_SECONDS,
    });

    const reservedValue = await env.APP_KV.get(dedupeKey);
    if (reservedValue !== dedupeProcessingValue) {
      return;
    }
  }

  try {
    const subject = sanitizeHeaderValue(message.headers.get('subject') || '', 240);
    const messageBody = stripQuotedReplyContent(await extractEmailText(message));
    const userMessage = (messageBody || subject).trim();

    if (!userMessage) {
      message.setReject('Email message is empty.');
      dedupeHandled = true;
      return;
    }

    const thread = await resolveThreadForEmail(env, {
      workspaceId: recipient.workspaceId,
      orgId: authorizedSender.orgId,
      headers: message.headers,
      subject,
      message: userMessage,
      userId: authorizedSender.userId,
    });

    const turnResult = await runExternalMessageTurn(env, {
      threadId: thread.threadId,
      workspaceId: authorizedSender.workspaceId,
      orgId: authorizedSender.orgId,
      userName: authorizedSender.userName,
      userEmail: authorizedSender.userEmail,
      message: userMessage,
      timeoutMs: DEFAULT_EXTERNAL_TURN_TIMEOUT_MS,
    });

    const replyText = outcomeToReplyText(turnResult);
    const replyDomain = routingConfig?.domain || recipient.domain;
    const fromAddress = buildWorkspaceInboxAddress(recipient.workspaceId, replyDomain, {
      localPart: routingConfig?.localPart,
    });
    const outboundMessageId = createReplyMessageId(thread.threadId, replyDomain);

    const sentMessageId = await sendReply(message, {
      fromAddress,
      toAddress: senderEmail,
      replyToAddress: fromAddress,
      subject: formatReplySubject(subject, thread.title),
      body: replyText,
      messageId: outboundMessageId,
    });

    if (sentMessageId) {
      await env.APP_KV.put(
        getEmailReplyReferenceKey(recipient.workspaceId, sentMessageId),
        thread.threadId,
        { expirationTtl: EMAIL_REPLY_REFERENCE_TTL_SECONDS }
      );
    }

    dedupeHandled = true;
  } finally {
    if (!dedupeKey || !dedupeProcessingValue) {
      return;
    }

    if (dedupeHandled) {
      await env.APP_KV.put(dedupeKey, EMAIL_EVENT_DEDUPE_DONE_VALUE, {
        expirationTtl: EMAIL_EVENT_DEDUPE_TTL_SECONDS,
      });
      return;
    }

    const currentValue = await env.APP_KV.get(dedupeKey);
    if (currentValue === dedupeProcessingValue) {
      await env.APP_KV.delete(dedupeKey);
    }
  }
}
