import { getCookie } from "@/lib/cookies.server";
import type { MarketingAttribution } from "@/lib/marketing-attribution.client";

const COOKIE_NAME = "camel_attribution_id";
const KV_PREFIX = "marketing_attribution:";
const USER_PREFIX = "user_marketing_attribution:";
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

type AttributionRecord = {
  attribution: MarketingAttribution;
  landingPage: string;
  firstCapturedAt: string;
  lastUpdatedAt: string;
};

function validId(value: string | null | undefined): value is string {
  return Boolean(value && /^[0-9a-f-]{36}$/i.test(value));
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
): Promise<{ id: string | null; attribution: MarketingAttribution }> {
  const id = validId(requestedId)
    ? requestedId
    : getCookie(request, COOKIE_NAME);
  if (!validId(id)) return { id: null, attribution: {} };
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
    ? { id, attribution: record.attribution }
    : { id: null, attribution: {} };
}

export async function associateAttributionWithUser(
  request: Request,
  kv: KVNamespace,
  userId: string,
): Promise<void> {
  const envelope = await getMarketingAttribution(request, kv);
  if (!envelope.id) return;
  await kv.put(
    `${USER_PREFIX}${userId}`,
    JSON.stringify({ attributionId: envelope.id, associatedAt: new Date().toISOString() }),
    { expirationTtl: TTL_SECONDS },
  );
}
