import { EmailMessage } from "cloudflare:email";
import PostalMime from "postal-mime";
import type { Env } from "./types.js";
import type { ExternalTurnResult } from "./durable-objects.js";
import { runExternalMessageTurn } from "./helpers/external-turn.js";
import { getOrgStub, getUserStub, getWorkspaceStub } from "./helpers/stubs.js";
import { buildWorkspaceScopedR2Key } from "../../../src/lib/workspace-r2-paths.js";
import {
  getWorkspaceEmailRoutingConfig,
  parseMailboxAddress,
  parseWorkspaceEmailAddress,
} from "../../../src/lib/workspace-email.js";
import {
  getDefaultLlmModel,
  getDefaultThreadProvider,
} from "../../../src/lib/llm-provider-config.js";
import type { Attachment as PostalMimeAttachment } from "postal-mime";
import { isOrgBanned } from "./ban-list.js";

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

interface ParsedEmailContent {
  text: string;
  attachments: PostalMimeAttachment[];
}

const EMAIL_EVENT_DEDUPE_PREFIX = "email_event:";
const EMAIL_EVENT_DEDUPE_TTL_SECONDS = 10 * 60;
const EMAIL_EVENT_DEDUPE_PROCESSING_TTL_SECONDS = 5 * 60;
const EMAIL_EVENT_DEDUPE_PROCESSING_MAX_AGE_MS =
  EMAIL_EVENT_DEDUPE_PROCESSING_TTL_SECONDS * 1000;
const EMAIL_EVENT_DEDUPE_DONE_VALUE = "done";
const EMAIL_EVENT_DEDUPE_LEGACY_DONE_VALUE = "1";
const EMAIL_REPLY_REFERENCE_PREFIX = "email_reply_ref:";
const EMAIL_REPLY_REFERENCE_TTL_SECONDS = 180 * 24 * 60 * 60;
const MAX_EMAIL_RAW_SIZE_BYTES = 2 * 1024 * 1024;
const MAX_EMAIL_REPLY_BODY_CHARS = 50_000;
const STRICT_MESSAGE_ID_PATTERN = /^[^\s<>@]+@(?:[^\s<>@]+|\[[^\]\r\n]+\])$/;
const DEFAULT_ATTACHMENT_BASENAME = "attachment";
const DEFAULT_ATTACHMENT_CONTENT_TYPE = "application/octet-stream";
const MIME_EXTENSION_MAP: Record<string, string> = {
  "application/json": ".json",
  "application/pdf": ".pdf",
  "application/xml": ".xml",
  "application/zip": ".zip",
  "application/x-tar": ".tar",
  "application/gzip": ".gz",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    ".docx",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    ".pptx",
  "text/plain": ".txt",
  "text/csv": ".csv",
  "text/html": ".html",
  "text/markdown": ".md",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
};

function sanitizeHeaderValue(value: string, maxLength = 200): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isNonRetriableReplyError(error: unknown): boolean {
  const normalized = getErrorMessage(error).toLowerCase();
  return (
    normalized.includes("original email is not repliable") ||
    normalized.includes("exceeds reply limit")
  );
}

function extractAuthResultStatus(
  authResultsHeader: string,
  label: "spf" | "dkim" | "dmarc",
): string | null {
  const match = authResultsHeader.match(
    new RegExp(`(?:^|\\s|;)${label}=([a-z_+-]+)`, "i"),
  );
  return match?.[1]?.toLowerCase() || null;
}

function summarizeAuthResults(headers: Headers): {
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
  header: string | null;
} {
  const authResultsHeader = sanitizeHeaderValue(
    headers.get("authentication-results") || "",
    500,
  );
  if (!authResultsHeader) {
    return {
      spf: null,
      dkim: null,
      dmarc: null,
      header: null,
    };
  }

  return {
    spf: extractAuthResultStatus(authResultsHeader, "spf"),
    dkim: extractAuthResultStatus(authResultsHeader, "dkim"),
    dmarc: extractAuthResultStatus(authResultsHeader, "dmarc"),
    header: authResultsHeader,
  };
}

function normalizeMessageId(rawValue: string | null): string | null {
  if (!rawValue) return null;
  const sanitized = sanitizeHeaderValue(rawValue, 512)
    .replace(/^<|>$/g, "")
    .trim()
    .toLowerCase();
  return sanitized || null;
}

function normalizeMessageIdForHeader(rawValue: string | null): string | null {
  const normalized = normalizeMessageId(rawValue);
  if (!normalized) return null;
  const safe = normalized.replace(/[<>\s]/g, "");
  if (!safe || !STRICT_MESSAGE_ID_PATTERN.test(safe)) return null;
  return `<${safe}>`;
}

function toDedupeFragment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 160);
}

function getEmailDedupeKey(workspaceId: string, messageId: string): string {
  const workspacePart = toDedupeFragment(workspaceId) || "ws";
  const messagePart = toDedupeFragment(messageId) || "msg";
  return `${EMAIL_EVENT_DEDUPE_PREFIX}${workspacePart}:${messagePart}`;
}

function buildEmailProcessingDedupeValue(
  token: string,
  startedAt: number,
): string {
  return `processing:${token}:${startedAt}`;
}

function parseEmailDedupeValue(rawValue: string | null): {
  state: "done" | "processing";
  token?: string;
  startedAt?: number;
} | null {
  if (!rawValue) return null;
  if (
    rawValue === EMAIL_EVENT_DEDUPE_DONE_VALUE ||
    rawValue === EMAIL_EVENT_DEDUPE_LEGACY_DONE_VALUE
  ) {
    return { state: "done" };
  }

  if (!rawValue.startsWith("processing:")) {
    return null;
  }

  const parts = rawValue.split(":");
  if (parts.length !== 3) return null;
  const token = parts[1]?.trim();
  const startedAt = Number(parts[2]);
  if (!token || !Number.isFinite(startedAt) || startedAt <= 0) {
    return null;
  }

  return {
    state: "processing",
    token,
    startedAt,
  };
}

function getEmailReplyReferenceKey(
  workspaceId: string,
  messageId: string,
): string {
  const safeMessageId = messageId
    .toLowerCase()
    .replace(/[^a-z0-9@._-]/g, "_")
    .slice(0, 400);
  return `${EMAIL_REPLY_REFERENCE_PREFIX}${workspaceId}:${safeMessageId}`;
}

function stripSubjectPrefixes(subject: string): string {
  return subject.replace(/^(\s*(re|fw|fwd)\s*:\s*)+/i, "").trim();
}

function titleFromEmail(subject: string, body: string): string {
  const subjectTitle = stripSubjectPrefixes(subject);
  if (subjectTitle) return subjectTitle.slice(0, 100);

  const firstLine =
    body
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) || "Email conversation";
  return firstLine.slice(0, 100);
}

function stripHtmlTags(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function buildUploadKey(
  orgId: string,
  workspaceId: string,
  filename: string,
): string {
  return buildWorkspaceScopedR2Key(
    orgId,
    workspaceId,
    `user-uploads/${filename}`,
  );
}

function toUploadMountPath(filename: string): string {
  return `/mnt/user-uploads/${filename}`;
}

function generateUniqueFilename(originalName: string): string {
  const timestamp = Date.now();
  const randomPart = Math.random().toString(36).substring(2, 8);
  const ext = originalName.includes(".")
    ? originalName
        .slice(originalName.lastIndexOf("."))
        .replace(/[^a-zA-Z0-9.]/g, "_")
        .substring(0, 20)
    : "";
  const baseName = originalName.includes(".")
    ? originalName.slice(0, originalName.lastIndexOf("."))
    : originalName;
  const sanitized = baseName.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 50);
  return `${sanitized || DEFAULT_ATTACHMENT_BASENAME}-${timestamp}-${randomPart}${ext}`;
}

function normalizeAttachmentName(
  attachment: PostalMimeAttachment,
  index: number,
): string {
  const fromFilename =
    typeof attachment.filename === "string" ? attachment.filename.trim() : "";
  if (fromFilename) return fromFilename.slice(0, 255);

  const fallbackBase = `${DEFAULT_ATTACHMENT_BASENAME}-${index + 1}`;
  const extension =
    MIME_EXTENSION_MAP[(attachment.mimeType || "").toLowerCase()] || "";
  return `${fallbackBase}${extension}`.slice(0, 255);
}

function decodeBase64Content(content: string): Uint8Array | null {
  try {
    const compact = content.replace(/\s+/g, "");
    const binary = atob(compact);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

function toAttachmentPayload(
  attachment: PostalMimeAttachment,
): { body: ArrayBuffer | Uint8Array; size: number } | null {
  if (attachment.content instanceof ArrayBuffer) {
    return { body: attachment.content, size: attachment.content.byteLength };
  }

  if (typeof attachment.content !== "string") return null;

  if (attachment.encoding === "base64") {
    const decoded = decodeBase64Content(attachment.content);
    if (!decoded) return null;
    return { body: decoded, size: decoded.byteLength };
  }

  const encoded = new TextEncoder().encode(attachment.content);
  return { body: encoded, size: encoded.byteLength };
}

function shouldUploadAttachment(attachment: PostalMimeAttachment): boolean {
  if (attachment.related) return false;
  if (!attachment.content) return false;
  if (attachment.disposition === "inline" && !attachment.filename) return false;
  return true;
}

function appendUploadRefsToMessage(
  content: string,
  uploadPaths: string[],
): string {
  if (uploadPaths.length === 0) return content.trim();
  const refs = uploadPaths
    .map((path) => `(user uploaded file to ${path})`)
    .join("\n");
  const trimmed = content.trim();
  return trimmed ? `${trimmed}\n\n${refs}` : refs;
}

async function parseEmailContent(
  message: ForwardableEmailMessage,
): Promise<ParsedEmailContent> {
  const rawBytes = await new Response(message.raw).arrayBuffer();

  try {
    const parser = new PostalMime();
    const parsed = (await parser.parse(rawBytes)) as {
      text?: string | null;
      html?: string | null;
      attachments?: PostalMimeAttachment[] | null;
    };

    const text = parsed.text?.trim() || "";
    if (text) {
      return {
        text,
        attachments: Array.isArray(parsed.attachments)
          ? parsed.attachments
          : [],
      };
    }

    const html = parsed.html?.trim() || "";
    return {
      text: html ? stripHtmlTags(html) : "",
      attachments: Array.isArray(parsed.attachments) ? parsed.attachments : [],
    };
  } catch {
    const raw = new TextDecoder().decode(rawBytes);
    const normalized = raw.replace(/\r\n/g, "\n");
    const splitIndex = normalized.indexOf("\n\n");
    return {
      text: (splitIndex >= 0
        ? normalized.slice(splitIndex + 2)
        : normalized
      ).trim(),
      attachments: [],
    };
  }
}

async function uploadEmailAttachments(
  env: Env,
  args: {
    orgId: string;
    workspaceId: string;
    attachments: PostalMimeAttachment[];
  },
): Promise<string[]> {
  const uploadedPaths: string[] = [];

  for (const [index, attachment] of args.attachments.entries()) {
    if (!shouldUploadAttachment(attachment)) continue;

    const payload = toAttachmentPayload(attachment);
    if (!payload || payload.size === 0) continue;

    const originalName = normalizeAttachmentName(attachment, index);
    const storedFilename = generateUniqueFilename(originalName);
    const contentType =
      (attachment.mimeType || "").trim() || DEFAULT_ATTACHMENT_CONTENT_TYPE;
    const r2Key = buildUploadKey(args.orgId, args.workspaceId, storedFilename);

    try {
      await env.R2_BUCKET.put(r2Key, payload.body, {
        httpMetadata: { contentType },
        customMetadata: {
          originalName,
          uploadedAt: new Date().toISOString(),
          source: "email-ingress",
        },
      });
      uploadedPaths.push(toUploadMountPath(storedFilename));
    } catch (error) {
      console.error("[email-ingress] failed to upload attachment", {
        workspaceId: args.workspaceId,
        orgId: args.orgId,
        filename: attachment.filename || null,
        mimeType: attachment.mimeType || null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return uploadedPaths;
}

function stripQuotedReplyContent(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return "";

  const lines = normalized.split("\n");
  const kept: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^on\s.+wrote:\s*$/i.test(trimmed)) break;
    if (/^[-_]{2,}\s*original message\s*[-_]{2,}$/i.test(trimmed)) break;
    if (/^from:\s.+@.+$/i.test(trimmed) && kept.length > 0) break;
    if (trimmed.startsWith(">") && kept.length > 0) break;
    kept.push(line);
  }

  return kept.join("\n").trim();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function renderMarkdownEmailHtml(markdown: string): Promise<string> {
  const content = markdown.trim() || "Done.";

  try {
    const [{ createElement }, { renderToStaticMarkup }, { default: ReactMarkdown }, { default: remarkGfm }] =
      await Promise.all([
        import("react"),
        import("react-dom/server"),
        import("react-markdown"),
        import("remark-gfm"),
      ]);
    const renderedMarkdown = renderToStaticMarkup(
      createElement(
        "div",
        { className: "markdown-body" },
        createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, content),
      ),
    );

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body {
        margin: 0;
        padding: 0;
        background: #f4f4f5;
        color: #18181b;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      }
      .container {
        max-width: 680px;
        margin: 0 auto;
        background: #ffffff;
        padding: 24px;
      }
      .markdown-body {
        font-size: 15px;
        line-height: 1.6;
      }
      .markdown-body p { margin: 0 0 14px; }
      .markdown-body h1,
      .markdown-body h2,
      .markdown-body h3,
      .markdown-body h4 { margin: 20px 0 12px; line-height: 1.3; }
      .markdown-body ul,
      .markdown-body ol { margin: 0 0 14px 20px; padding: 0; }
      .markdown-body li { margin: 0 0 6px; }
      .markdown-body code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        background: #f4f4f5;
        border-radius: 4px;
        padding: 0.15em 0.3em;
      }
      .markdown-body pre {
        margin: 0 0 14px;
        padding: 12px;
        border-radius: 8px;
        overflow-x: auto;
        background: #f4f4f5;
      }
      .markdown-body pre code {
        background: transparent;
        padding: 0;
      }
      .markdown-body a { color: #0f766e; text-decoration: underline; }
      .markdown-body blockquote {
        margin: 0 0 14px;
        padding: 0 0 0 12px;
        border-left: 3px solid #d4d4d8;
        color: #52525b;
      }
      .markdown-body table {
        border-collapse: collapse;
        margin: 0 0 14px;
      }
      .markdown-body th,
      .markdown-body td {
        border: 1px solid #e4e4e7;
        padding: 8px;
      }
    </style>
  </head>
  <body>
    <div class="container">${renderedMarkdown}</div>
  </body>
</html>`;
  } catch (error) {
    console.error(
      "[email-ingress] Failed to render markdown email body",
      error,
    );
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
  </head>
  <body style="margin:0;padding:24px;background:#ffffff;color:#18181b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <pre style="white-space:pre-wrap;font-size:15px;line-height:1.5;margin:0;">${escapeHtml(content)}</pre>
  </body>
</html>`;
  }
}

async function resolveWorkspaceFromEmailHandle(
  env: Env,
  emailHandle: string,
): Promise<{ orgId: string; workspaceId: string } | null> {
  if (!env.EMAIL_HANDLE) return null;
  const stub = env.EMAIL_HANDLE.get(env.EMAIL_HANDLE.idFromName(emailHandle));
  const workspaceId = await stub.getOwner();
  if (!workspaceId) return null;

  const wsStub = getWorkspaceStub(env, workspaceId);
  const info = await wsStub.getInfo();
  if (!info || info.archived) return null;

  return { orgId: info.org_id, workspaceId };
}

async function resolveAuthorizedSender(
  env: Env,
  workspaceId: string,
  orgId: string,
  senderEmail: string,
): Promise<AuthorizedSender | null> {
  const userId = await env.EMAIL_TO_USER.get(`email:${senderEmail}`);
  if (!userId) return null;

  const wsStub = getWorkspaceStub(env, workspaceId);
  const workspaceInfo = await wsStub.getInfo();
  if (!workspaceInfo || workspaceInfo.archived) return null;

  const orgStub = getOrgStub(env, orgId);
  const [isOrgMember, memberAccess, profile] = await Promise.all([
    orgStub.isMember(userId),
    wsStub.getMemberAccess(userId),
    getUserStub(env, userId).getProfile(),
  ]);

  if (!isOrgMember) return null;
  if ((memberAccess?.access_level ?? "full") !== "full") return null;

  return {
    userId,
    userName: profile?.name?.trim() || senderEmail,
    userEmail: senderEmail,
    workspaceId,
    orgId,
  };
}

function extractMessageIdsFromHeaderValue(rawValue: string | null): string[] {
  if (!rawValue) return [];

  const normalized = sanitizeHeaderValue(rawValue, 1200);
  if (!normalized) return [];

  const extracted = Array.from(normalized.matchAll(/<([^>]+)>/g))
    .map((match) => normalizeMessageId(match[1] || ""))
    .filter((value): value is string => Boolean(value));

  if (extracted.length > 0) return extracted;
  const fallback = normalizeMessageId(normalized);
  return fallback ? [fallback] : [];
}

function getReplyReferenceCandidates(headers: Headers): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  const inReplyTo = extractMessageIdsFromHeaderValue(
    headers.get("in-reply-to"),
  );
  const references = extractMessageIdsFromHeaderValue(
    headers.get("references"),
  ).reverse();

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
  },
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
        title: thread.title || "Email conversation",
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
  },
): Promise<EmailThreadResolution> {
  const fromReplyHeaders = await resolveThreadFromReplyHeaders(env, {
    workspaceId: args.workspaceId,
    orgId: args.orgId,
    headers: args.headers,
  });
  if (fromReplyHeaders) return fromReplyHeaders;

  const orgStub = getOrgStub(env, args.orgId);
  const title = titleFromEmail(args.subject, args.message);
  const [llmProviderConfig, experimentalSettings] = await Promise.all([
    orgStub.getLlmProviderConfig(),
    orgStub.getExperimentalSettings(),
  ]);
  const provider = getDefaultThreadProvider(llmProviderConfig?.provider, experimentalSettings);
  const created = await orgStub.createThread(
    args.workspaceId,
    title,
    args.userId,
    args.message.slice(0, 500),
    getDefaultLlmModel(provider),
    provider,
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

  const cleanFallback =
    sanitizeHeaderValue(fallback, 160) || "camelAI conversation";
  return `Re: ${cleanFallback}`;
}

function createReplyMessageId(threadId: string, domain: string): string {
  const safeThreadId =
    threadId.replace(/[^a-z0-9-]/gi, "").slice(0, 64) || "thread";
  const safeDomain = domain.toLowerCase().replace(/[^a-z0-9.-]/g, "");
  return `chiridion.${safeThreadId}.${crypto.randomUUID()}@${safeDomain}`;
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
  },
): Promise<string | null> {
  const subject = sanitizeHeaderValue(args.subject, 240) || "Re: camelAI";
  const fromAddress = sanitizeHeaderValue(args.fromAddress, 320);
  const toAddress = sanitizeHeaderValue(args.toAddress, 320);
  const replyToAddress = sanitizeHeaderValue(args.replyToAddress, 320);
  const bodyText = args.body
    .replace(/\r\n/g, "\n")
    .trim()
    .slice(0, MAX_EMAIL_REPLY_BODY_CHARS);
  const bodyHtml = await renderMarkdownEmailHtml(bodyText);
  const boundary = `chiridion-${crypto.randomUUID()}`;

  const headers: string[] = [
    `From: camelAI <${fromAddress}>`,
    `To: ${toAddress}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    `Reply-To: ${replyToAddress}`,
  ];

  const replyMessageIdHeader = normalizeMessageIdForHeader(args.messageId);
  if (replyMessageIdHeader) {
    headers.push(`Message-ID: ${replyMessageIdHeader}`);
  }

  const inReplyTo = normalizeMessageIdForHeader(
    inbound.headers.get("message-id"),
  );
  if (inReplyTo) {
    headers.push(`In-Reply-To: ${inReplyTo}`);
  }

  const multipartBody = [
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    bodyText || "Done.",
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    bodyHtml,
    `--${boundary}--`,
    "",
  ].join("\r\n");

  const raw = `${headers.join("\r\n")}\r\n\r\n${multipartBody}`;
  await inbound.reply(new EmailMessage(fromAddress, toAddress, raw));
  return normalizeMessageId(args.messageId);
}

function outcomeToReplyText(result: ExternalTurnResult): string {
  if (result.status === "result") return result.reply?.trim() || "Done.";
  if (result.status === "busy") {
    return "camelAI is still processing the previous email for this thread. Please try again in a moment.";
  }
  if (result.status === "error")
    return result.error || "I could not process that email right now.";
  return "I could not process that email right now.";
}

export async function handleWorkspaceEmailIngress(
  message: ForwardableEmailMessage,
  env: Env,
): Promise<void> {
  if (message.rawSize > MAX_EMAIL_RAW_SIZE_BYTES) {
    message.setReject("Email is too large. Maximum size is 2 MiB.");
    return;
  }

  const routingConfig = getWorkspaceEmailRoutingConfig(env);
  if (!routingConfig) {
    message.setReject("Workspace email routing is not configured.");
    return;
  }

  const parsed = parseWorkspaceEmailAddress(message.to, {
    expectedDomain: routingConfig.domain,
  });
  if (!parsed) {
    message.setReject("Unknown workspace email address.");
    return;
  }

  const resolved = await resolveWorkspaceFromEmailHandle(
    env,
    parsed.emailHandle,
  );
  if (!resolved) {
    message.setReject("Unknown workspace email address.");
    return;
  }

  const recipientMailbox = parseMailboxAddress(message.to);
  if (!recipientMailbox) {
    message.setReject("Unknown workspace email address.");
    return;
  }
  const recipientAddress = `${recipientMailbox.local}@${recipientMailbox.domain}`;

  const sender = parseMailboxAddress(message.from);
  if (!sender) {
    message.setReject("Invalid sender address.");
    return;
  }

  const senderEmail = `${sender.local}@${sender.domain}`;
  const authorizedSender = await resolveAuthorizedSender(
    env,
    resolved.workspaceId,
    resolved.orgId,
    senderEmail,
  );
  if (!authorizedSender) {
    message.setReject("Sender is not allowed for this workspace inbox.");
    return;
  }

  const orgBan = await isOrgBanned(env.APP_KV, {
    orgId: authorizedSender.orgId,
  });
  if (orgBan) {
    message.setReject("This workspace is blocked.");
    return;
  }

  const normalizedMessageId = normalizeMessageId(
    message.headers.get("message-id"),
  );
  const dedupeKey = normalizedMessageId
    ? getEmailDedupeKey(resolved.workspaceId, normalizedMessageId)
    : null;
  let dedupeProcessingValue: string | null = null;
  let dedupeHandled = false;
  if (dedupeKey) {
    const existing = parseEmailDedupeValue(await env.APP_KV.get(dedupeKey));
    if (existing?.state === "done") return;
    if (
      existing?.state === "processing" &&
      typeof existing.startedAt === "number" &&
      Date.now() - existing.startedAt < EMAIL_EVENT_DEDUPE_PROCESSING_MAX_AGE_MS
    ) {
      return;
    }

    dedupeProcessingValue = buildEmailProcessingDedupeValue(
      crypto.randomUUID(),
      Date.now(),
    );
    await env.APP_KV.put(dedupeKey, dedupeProcessingValue, {
      expirationTtl: EMAIL_EVENT_DEDUPE_PROCESSING_TTL_SECONDS,
    });

    const reservedValue = await env.APP_KV.get(dedupeKey);
    if (reservedValue !== dedupeProcessingValue) {
      return;
    }
  }

  try {
    const subject = sanitizeHeaderValue(
      message.headers.get("subject") || "",
      240,
    );
    const parsedContent = await parseEmailContent(message);
    const messageBody = stripQuotedReplyContent(parsedContent.text);
    const uploadedAttachmentPaths = await uploadEmailAttachments(env, {
      orgId: authorizedSender.orgId,
      workspaceId: authorizedSender.workspaceId,
      attachments: parsedContent.attachments,
    });
    const userMessage = appendUploadRefsToMessage(
      (messageBody || subject).trim(),
      uploadedAttachmentPaths,
    );

    if (!userMessage) {
      message.setReject("Email message is empty.");
      dedupeHandled = true;
      return;
    }

    const thread = await resolveThreadForEmail(env, {
      workspaceId: resolved.workspaceId,
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
      userId: authorizedSender.userId,
      userName: authorizedSender.userName,
      userEmail: authorizedSender.userEmail,
      message: userMessage,
    });

    const replyText = outcomeToReplyText(turnResult);
    const replyDomain = recipientMailbox.domain;
    const outboundMessageId = createReplyMessageId(
      thread.threadId,
      replyDomain,
    );
    try {
      const sentMessageId = await sendReply(message, {
        fromAddress: recipientAddress,
        toAddress: senderEmail,
        replyToAddress: recipientAddress,
        subject: formatReplySubject(subject, thread.title),
        body: replyText,
        messageId: outboundMessageId,
      });

      if (sentMessageId) {
        await env.APP_KV.put(
          getEmailReplyReferenceKey(resolved.workspaceId, sentMessageId),
          thread.threadId,
          { expirationTtl: EMAIL_REPLY_REFERENCE_TTL_SECONDS },
        );
      }
    } catch (error) {
      if (!isNonRetriableReplyError(error)) {
        throw error;
      }

      const authResults = summarizeAuthResults(message.headers);
      console.warn("[email-ingress] reply skipped by Cloudflare", {
        workspaceId: resolved.workspaceId,
        orgId: resolved.orgId,
        threadId: thread.threadId,
        senderEmail,
        recipientAddress,
        inboundMessageId: normalizeMessageId(message.headers.get("message-id")),
        outboundMessageId,
        referencesCount: extractMessageIdsFromHeaderValue(
          message.headers.get("references"),
        ).length,
        hasInReplyTo: Boolean(message.headers.get("in-reply-to")),
        authResults,
        error: getErrorMessage(error),
      });
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
