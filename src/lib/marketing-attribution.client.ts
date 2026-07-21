const ATTRIBUTION_STORAGE_KEY = "camelai_marketing_attribution_v1";
const TRACKED_EVENT_PREFIX = "camelai_marketing_event_v1:";

const ATTRIBUTION_QUERY_KEYS = [
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

type AttributionKey = (typeof ATTRIBUTION_QUERY_KEYS)[number];
export type MarketingAttribution = Partial<Record<AttributionKey, string>>;

declare global {
  interface Window {
    zaraz?: { track: (event: string, properties?: Record<string, unknown>) => void };
    gtag?: (...args: unknown[]) => void;
  }
}

function readStoredAttribution(): MarketingAttribution {
  try {
    return JSON.parse(localStorage.getItem(ATTRIBUTION_STORAGE_KEY) ?? "{}") as MarketingAttribution;
  } catch {
    return {};
  }
}

export function captureMarketingAttribution(search = window.location.search): MarketingAttribution {
  const params = new URLSearchParams(search);
  const current = Object.fromEntries(
    ATTRIBUTION_QUERY_KEYS.flatMap((key) => {
      const value = params.get(key)?.trim();
      return value ? [[key, value]] : [];
    }),
  ) as MarketingAttribution;
  const combined = { ...readStoredAttribution(), ...current };
  if (Object.keys(combined).length > 0) {
    localStorage.setItem(ATTRIBUTION_STORAGE_KEY, JSON.stringify(combined));
  }
  return combined;
}

export function trackMarketingEvent(
  event: string,
  properties: Record<string, unknown> = {},
): boolean {
  const payload = { ...captureMarketingAttribution(), ...properties };
  if (window.zaraz?.track) {
    window.zaraz.track(event, payload);
    return true;
  }
  if (window.gtag) {
    window.gtag("event", event, payload);
    return true;
  }
  return false;
}

export function trackMarketingEventOnce(
  event: string,
  dedupeId: string,
  properties: Record<string, unknown> = {},
) {
  const key = `${TRACKED_EVENT_PREFIX}${event}:${dedupeId}`;
  if (localStorage.getItem(key)) return;
  if (trackMarketingEvent(event, properties)) {
    localStorage.setItem(key, new Date().toISOString());
  }
}
