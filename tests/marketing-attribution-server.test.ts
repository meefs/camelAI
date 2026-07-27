import { describe, expect, it, vi } from "vitest";
import {
  associateAttributionWithUser,
  recordNewCamelActivation,
} from "@/lib/marketing-attribution.server";

function createKv(initial: Record<string, unknown> = {}) {
  const values = new Map(
    Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]),
  );
  return {
    values,
    kv: {
      get: vi.fn(async (key: string) => {
        const value = values.get(key);
        return value ? JSON.parse(value) : null;
      }),
      put: vi.fn(async (key: string, value: string) => {
        values.set(key, value);
      }),
    } as unknown as KVNamespace,
  };
}

const firstTouch = {
  landingPage: "https://camelai.com/guides/stripe-revenue-dashboard",
  landingPath: "/guides/stripe-revenue-dashboard",
  pageType: "template",
  referrerHost: "www.google.com",
  source: "google",
  medium: "organic",
  capturedAt: "2026-07-27T12:00:00.000Z",
};

describe("server marketing attribution", () => {
  it("associates the immutable first-touch snapshot with a user", async () => {
    const firstId = "11111111-1111-4111-8111-111111111111";
    const secondId = "22222222-2222-4222-8222-222222222222";
    const { kv, values } = createKv({
      [`marketing_attribution:${firstId}`]: {
        schemaVersion: 2,
        attribution: { utm_source: "google", utm_medium: "organic" },
        firstTouch,
        firstCapturedAt: firstTouch.capturedAt,
        lastUpdatedAt: firstTouch.capturedAt,
      },
      [`marketing_attribution:${secondId}`]: {
        schemaVersion: 2,
        attribution: { utm_source: "youtube", utm_medium: "creator" },
        firstTouch: { ...firstTouch, source: "youtube", medium: "creator" },
        firstCapturedAt: firstTouch.capturedAt,
        lastUpdatedAt: firstTouch.capturedAt,
      },
    });

    await associateAttributionWithUser(
      new Request("https://camelai.dev/chat", {
        headers: { Cookie: `camel_attribution_id=${firstId}` },
      }),
      kv,
      "user-1",
    );
    await associateAttributionWithUser(
      new Request("https://camelai.dev/chat", {
        headers: { Cookie: `camel_attribution_id=${secondId}` },
      }),
      kv,
      "user-1",
    );

    const stored = JSON.parse(
      values.get("user_marketing_attribution:user-1") ?? "{}",
    );
    expect(stored).toMatchObject({
      attributionId: firstId,
      firstTouch,
      campaign: { utm_source: "google", utm_medium: "organic" },
    });
  });

  it("stores one self-contained activation record without message content", async () => {
    const { kv, values } = createKv({
      "user_marketing_attribution:user-1": {
        attributionId: "11111111-1111-4111-8111-111111111111",
        associatedAt: "2026-07-27T12:05:00.000Z",
        firstTouch,
        campaign: { utm_source: "google", utm_medium: "organic" },
      },
    });

    const first = await recordNewCamelActivation(kv, {
      userId: "user-1",
      eventId: "event-1",
      activatedAt: Date.parse("2026-07-27T12:10:00.000Z"),
    });
    const repeated = await recordNewCamelActivation(kv, {
      userId: "user-1",
      eventId: "event-2",
      activatedAt: Date.parse("2026-07-27T12:20:00.000Z"),
    });

    expect(first).toEqual(repeated);
    expect(first).toMatchObject({
      eventId: "event-1",
      eventName: "new_camel_activation",
      completionBasis: "first_message_accepted",
      attributionId: "11111111-1111-4111-8111-111111111111",
      firstTouch,
    });
    const stored = JSON.parse(
      values.get("new_camel_activation:user-1") ?? "{}",
    );
    expect(stored).not.toHaveProperty("message");
    expect(stored).not.toHaveProperty("messageContent");
  });
});
