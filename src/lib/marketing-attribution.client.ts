export type MarketingAttribution = Partial<
  Record<
    | "gclid"
    | "gbraid"
    | "wbraid"
    | "gad_source"
    | "_gl"
    | "utm_source"
    | "utm_medium"
    | "utm_campaign"
    | "utm_term"
    | "utm_content",
    string
  >
>;

type AttributionEnvelope = {
  id: string | null;
  attribution: MarketingAttribution;
};

declare global {
  interface Window {
    zaraz?: { track: (event: string, properties?: Record<string, unknown>) => void };
    gtag?: (...args: unknown[]) => void;
  }
}

let attributionRequest: Promise<AttributionEnvelope> | null = null;
let attributionEnvelope: AttributionEnvelope = { id: null, attribution: {} };
const trackedEvents = new Set<string>();

export function initializeMarketingAttribution(
  search = window.location.search,
): Promise<AttributionEnvelope> {
  if (attributionRequest) return attributionRequest;
  const attributionId = new URLSearchParams(search).get("attribution_id");
  attributionRequest = fetch("/api/marketing-attribution", {
    method: attributionId ? "POST" : "GET",
    headers: attributionId ? { "Content-Type": "application/json" } : undefined,
    body: attributionId
      ? JSON.stringify({ attributionId, search: window.location.search })
      : undefined,
  })
    .then((response) => {
      if (!response.ok) throw new Error("Failed to initialize attribution");
      return response.json() as Promise<AttributionEnvelope>;
    })
    .then((envelope) => {
      attributionEnvelope = envelope;
      return envelope;
    })
    .catch(() => attributionEnvelope);
  return attributionRequest;
}

export async function trackMarketingEvent(
  event: string,
  properties: Record<string, unknown> = {},
): Promise<boolean> {
  const envelope = await initializeMarketingAttribution();
  const payload = {
    ...envelope.attribution,
    attribution_id: envelope.id,
    ...properties,
  };
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

export async function trackMarketingEventOnce(
  event: string,
  dedupeId: string,
  properties: Record<string, unknown> = {},
): Promise<void> {
  const key = `${event}:${dedupeId}`;
  if (trackedEvents.has(key)) return;
  if (await trackMarketingEvent(event, { event_id: key, ...properties })) {
    trackedEvents.add(key);
  }
}
