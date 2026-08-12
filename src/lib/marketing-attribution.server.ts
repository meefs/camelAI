import { getCookie } from "@/lib/cookies.server";
import type { MarketingAttribution } from "@/lib/marketing-attribution.client";

const COOKIE_NAME = "camel_attribution_id";
const KV_PREFIX = "marketing_attribution:";
const USER_PREFIX = "user_marketing_attribution:";
const ACTIVATION_PREFIX = "new_camel_activation:";
const PURCHASE_PREFIX = "stream_purchase:";
const TTL_SECONDS = 60 * 60 * 24 * 90;
const ATTRIBUTION_KEYS = [
  "gclid",
  "gbraid",
  "wbraid",
  "gad_source",
  "_gl",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
] as const;

export type MarketingFirstTouch = {
  landingPage: string;
  landingPath: string;
  pageType: string;
  referrerHost: string | null;
  source: string;
  medium: string;
  capturedAt: string;
};

type AttributionRecord = {
  schemaVersion?: number;
  attribution: MarketingAttribution;
  landingPage?: string;
  firstTouch?: MarketingFirstTouch;
  firstCapturedAt: string;
  lastUpdatedAt: string;
};

export type UserMarketingAttribution = {
  attributionId: string;
  associatedAt: string;
  firstTouch: MarketingFirstTouch | null;
  campaign: MarketingAttribution;
};

export type NewCamelActivationRecord = {
  eventId: string;
  eventName: "new_camel_activation";
  userId: string;
  activatedAt: string;
  completionBasis: "first_message_accepted";
  attributionId: string | null;
  firstTouch: MarketingFirstTouch | null;
  campaign: MarketingAttribution;
};

export type StreamPurchaseRecord = {
  eventId: string;
  eventName: "purchase";
  orgId: string;
  purchasedAt: string;
  billingStatus: "active" | "trialing";
  subscriptionId: string | null;
};

function validId(value: string | null | undefined): value is string {
  return Boolean(
    value &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value,
      ),
  );
}

export function attributionCookie(id: string): string {
  return `${COOKIE_NAME}=${id}; Path=/; Max-Age=${TTL_SECONDS}; Secure; HttpOnly; SameSite=Lax`;
}

export function attributionFromSearch(search: string): MarketingAttribution {
  const params = new URLSearchParams(search);
  return Object.fromEntries(
    ATTRIBUTION_KEYS.flatMap((key) => {
      const value = params.get(key)?.trim();
      return value ? [[key, value]] : [];
    }),
  );
}

export async function getMarketingAttribution(
  request: Request,
  kv: KVNamespace,
  requestedId?: string | null,
  fallbackAttribution: MarketingAttribution = {},
): Promise<{
  id: string | null;
  attribution: MarketingAttribution;
  firstTouch: MarketingFirstTouch | null;
}> {
  const id = validId(requestedId)
    ? requestedId
    : getCookie(request, COOKIE_NAME);
  if (!validId(id)) {
    return { id: null, attribution: {}, firstTouch: null };
  }
  let record = await kv.get<AttributionRecord>(`${KV_PREFIX}${id}`, "json");
  if (!record && Object.keys(fallbackAttribution).length > 0) {
    const now = new Date().toISOString();
    record = {
      attribution: fallbackAttribution,
      landingPage: "cross-domain-fallback",
      firstCapturedAt: now,
      lastUpdatedAt: now,
    };
    await kv.put(`${KV_PREFIX}${id}`, JSON.stringify(record), {
      expirationTtl: TTL_SECONDS,
    });
  }
  return record
    ? {
        id,
        attribution: record.attribution,
        firstTouch: record.firstTouch ?? null,
      }
    : { id: null, attribution: {}, firstTouch: null };
}

export async function associateAttributionWithUser(
  request: Request,
  kv: KVNamespace,
  userId: string,
): Promise<void> {
  const key = `${USER_PREFIX}${userId}`;
  const existing = await kv.get<UserMarketingAttribution>(key, "json");
  if (existing) return;

  const envelope = await getMarketingAttribution(request, kv);
  if (!envelope.id) return;
  await kv.put(
    key,
    JSON.stringify({
      attributionId: envelope.id,
      associatedAt: new Date().toISOString(),
      firstTouch: envelope.firstTouch,
      campaign: envelope.attribution,
    } satisfies UserMarketingAttribution),
  );
}

export async function recordNewCamelActivation(
  kv: KVNamespace,
  input: {
    userId: string;
    eventId: string;
    activatedAt: number;
  },
): Promise<NewCamelActivationRecord> {
  const key = `${ACTIVATION_PREFIX}${input.userId}`;
  const existing = await kv.get<NewCamelActivationRecord>(key, "json");
  if (existing) return existing;

  const userAttribution = await kv.get<UserMarketingAttribution>(
    `${USER_PREFIX}${input.userId}`,
    "json",
  );
  const record = {
    eventId: input.eventId,
    eventName: "new_camel_activation",
    userId: input.userId,
    activatedAt: new Date(input.activatedAt).toISOString(),
    completionBasis: "first_message_accepted",
    attributionId: userAttribution?.attributionId ?? null,
    firstTouch: userAttribution?.firstTouch ?? null,
    campaign: userAttribution?.campaign ?? {},
  } satisfies NewCamelActivationRecord;
  await kv.put(key, JSON.stringify(record));
  return record;
}

export async function recordStreamPurchase(
  kv: KVNamespace,
  input: {
    orgId: string;
    purchasedAt: number;
    billingStatus: "active" | "trialing";
    subscriptionId: string | null;
  },
): Promise<{ record: StreamPurchaseRecord; isFirst: boolean }> {
  const key = `${PURCHASE_PREFIX}${input.orgId}`;
  const existing = await kv.get<StreamPurchaseRecord>(key, "json");
  if (existing) {
    return { record: existing, isFirst: false };
  }

  const record = {
    eventId: crypto.randomUUID(),
    eventName: "purchase",
    orgId: input.orgId,
    purchasedAt: new Date(input.purchasedAt).toISOString(),
    billingStatus: input.billingStatus,
    subscriptionId: input.subscriptionId,
  } satisfies StreamPurchaseRecord;
  await kv.put(key, JSON.stringify(record));
  return { record, isFirst: true };
}
