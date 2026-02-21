const DEV_EMAIL_OUTBOX_ENTRY_PREFIX = 'dev_email_outbox:entry:';
const DEV_EMAIL_OUTBOX_ID_PREFIX = 'dev_email_outbox:id:';
const DEV_EMAIL_OUTBOX_MAX_TIMESTAMP = 9_999_999_999_999;
const DEV_EMAIL_OUTBOX_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days
const DEV_EMAIL_OUTBOX_DEFAULT_LIMIT = 20;
const DEV_EMAIL_OUTBOX_MAX_LIMIT = 100;

export type DevEmailOutboxStatus = 'sent' | 'skipped' | 'failed';
export type DevEmailOutboxTransport = 'resend' | 'none';

export interface DevEmailOutboxEntry {
  id: string;
  createdAt: string;
  to: string;
  cc?: string;
  replyTo?: string;
  subject: string;
  textBody: string;
  htmlBody: string;
  status: DevEmailOutboxStatus;
  reason?: string;
  transport: DevEmailOutboxTransport;
}

interface DevEmailOutboxEnv {
  NEXTJS_ENV?: string;
  APP_KV?: KVNamespace;
}

interface RecordDevEmailOutboxEntryArgs {
  to: string;
  cc?: string;
  replyTo?: string;
  subject: string;
  textBody: string;
  htmlBody: string;
  status: DevEmailOutboxStatus;
  reason?: string;
  transport: DevEmailOutboxTransport;
}

function clampLimit(limit: number | null | undefined): number {
  if (!Number.isFinite(limit)) return DEV_EMAIL_OUTBOX_DEFAULT_LIMIT;
  const rounded = Math.trunc(limit!);
  if (rounded < 1) return 1;
  return Math.min(rounded, DEV_EMAIL_OUTBOX_MAX_LIMIT);
}

function reverseTimestampKeyPart(date: Date): string {
  const reverse = DEV_EMAIL_OUTBOX_MAX_TIMESTAMP - date.getTime();
  return `${Math.max(0, reverse)}`.padStart(13, '0');
}

function buildEntryKey(id: string, createdAt: Date): string {
  return `${DEV_EMAIL_OUTBOX_ENTRY_PREFIX}${reverseTimestampKeyPart(createdAt)}:${id}`;
}

function buildIdLookupKey(id: string): string {
  return `${DEV_EMAIL_OUTBOX_ID_PREFIX}${id}`;
}

function parseEntry(raw: string): DevEmailOutboxEntry | null {
  try {
    const parsed = JSON.parse(raw) as Partial<DevEmailOutboxEntry>;
    if (
      typeof parsed.id !== 'string' ||
      typeof parsed.createdAt !== 'string' ||
      typeof parsed.to !== 'string' ||
      typeof parsed.subject !== 'string' ||
      typeof parsed.textBody !== 'string' ||
      typeof parsed.htmlBody !== 'string' ||
      typeof parsed.status !== 'string' ||
      typeof parsed.transport !== 'string'
    ) {
      return null;
    }

    return {
      id: parsed.id,
      createdAt: parsed.createdAt,
      to: parsed.to,
      cc: parsed.cc,
      replyTo: parsed.replyTo,
      subject: parsed.subject,
      textBody: parsed.textBody,
      htmlBody: parsed.htmlBody,
      status: parsed.status as DevEmailOutboxStatus,
      reason: parsed.reason,
      transport: parsed.transport as DevEmailOutboxTransport,
    };
  } catch {
    return null;
  }
}

export function isDevEmailOutboxEnabled(env: DevEmailOutboxEnv): env is DevEmailOutboxEnv & {
  APP_KV: KVNamespace;
} {
  return env.NEXTJS_ENV === 'development' && Boolean(env.APP_KV);
}

export async function recordDevEmailOutboxEntry(
  env: DevEmailOutboxEnv,
  args: RecordDevEmailOutboxEntryArgs
): Promise<string | null> {
  if (!isDevEmailOutboxEnabled(env)) return null;

  const createdAtDate = new Date();
  const id = crypto.randomUUID();
  const entry: DevEmailOutboxEntry = {
    id,
    createdAt: createdAtDate.toISOString(),
    to: args.to,
    cc: args.cc,
    replyTo: args.replyTo,
    subject: args.subject,
    textBody: args.textBody,
    htmlBody: args.htmlBody,
    status: args.status,
    reason: args.reason,
    transport: args.transport,
  };

  const entryKey = buildEntryKey(id, createdAtDate);
  const idLookupKey = buildIdLookupKey(id);

  try {
    await Promise.all([
      env.APP_KV.put(entryKey, JSON.stringify(entry), {
        expirationTtl: DEV_EMAIL_OUTBOX_TTL_SECONDS,
      }),
      env.APP_KV.put(idLookupKey, entryKey, {
        expirationTtl: DEV_EMAIL_OUTBOX_TTL_SECONDS,
      }),
    ]);
    return id;
  } catch (error) {
    console.error('Failed to record dev email outbox entry:', error);
    return null;
  }
}

export async function getDevEmailOutboxEntryById(
  env: DevEmailOutboxEnv,
  id: string
): Promise<DevEmailOutboxEntry | null> {
  if (!isDevEmailOutboxEnabled(env)) return null;
  const trimmedId = id.trim();
  if (!trimmedId) return null;

  const entryKey = await env.APP_KV.get(buildIdLookupKey(trimmedId));
  if (!entryKey) return null;

  const raw = await env.APP_KV.get(entryKey);
  if (!raw) return null;

  return parseEntry(raw);
}

export async function listDevEmailOutboxEntries(
  env: DevEmailOutboxEnv,
  opts?: { limit?: number; cursor?: string }
): Promise<{ entries: DevEmailOutboxEntry[]; cursor?: string; listComplete: boolean }> {
  if (!isDevEmailOutboxEnabled(env)) {
    return { entries: [], listComplete: true };
  }

  const limit = clampLimit(opts?.limit);
  const listResult = await env.APP_KV.list({
    prefix: DEV_EMAIL_OUTBOX_ENTRY_PREFIX,
    limit,
    cursor: opts?.cursor,
  });

  const rawEntries = await Promise.all(
    listResult.keys.map(async (key) => {
      const raw = await env.APP_KV.get(key.name);
      if (!raw) return null;
      return parseEntry(raw);
    })
  );

  const entries = rawEntries.filter((entry): entry is DevEmailOutboxEntry => Boolean(entry));
  const nextCursor =
    !listResult.list_complete && 'cursor' in listResult ? listResult.cursor : undefined;

  return {
    entries,
    cursor: nextCursor,
    listComplete: listResult.list_complete,
  };
}
