import { beforeEach, describe, expect, it, vi } from "vitest";

describe("marketing attribution", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    delete window.zaraz;
    delete window.gtag;
  });

  it("exchanges an opaque attribution ID for the KV-backed record", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        id: "11111111-1111-1111-1111-111111111111",
        attribution: { gclid: "test-click", utm_source: "google" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { initializeMarketingAttribution } = await import(
      "@/lib/marketing-attribution.client"
    );

    await expect(
      initializeMarketingAttribution(
        "?attribution_id=11111111-1111-1111-1111-111111111111",
      ),
    ).resolves.toMatchObject({ attribution: { gclid: "test-click" } });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/marketing-attribution",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("recovers attribution from the first-party dev cookie", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ id: "journey", attribution: { gclid: "test-click" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { initializeMarketingAttribution } = await import(
      "@/lib/marketing-attribution.client"
    );

    await initializeMarketingAttribution("");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/marketing-attribution",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("sends KV-enriched conversion events once through Zaraz", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({ id: "journey", attribution: { gclid: "test-click" } }),
      ),
    );
    const track = vi.fn();
    window.zaraz = { track };
    const { trackMarketingEventOnce } = await import(
      "@/lib/marketing-attribution.client"
    );

    await trackMarketingEventOnce("sign_up", "attempt-1", { method: "email" });
    await trackMarketingEventOnce("sign_up", "attempt-1", { method: "email" });

    expect(track).toHaveBeenCalledOnce();
    expect(track).toHaveBeenCalledWith(
      "sign_up",
      expect.objectContaining({
        gclid: "test-click",
        attribution_id: "journey",
        method: "email",
      }),
    );
  });

  it("does not mark an event sent before an analytics provider is ready", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ id: null, attribution: {} })),
    );
    const { trackMarketingEventOnce } = await import(
      "@/lib/marketing-attribution.client"
    );
    await trackMarketingEventOnce("sign_up", "attempt-1");
    const track = vi.fn();
    window.zaraz = { track };
    await trackMarketingEventOnce("sign_up", "attempt-1");

    expect(track).toHaveBeenCalledOnce();
  });

  it("tracks a durable new-camel activation only after message acceptance", async () => {
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/marketing-attribution/activate") {
        return Promise.resolve(
          Response.json({
            activated: true,
            eventId: "activation-event-1",
            completionBasis: "first_message_accepted",
          }),
        );
      }
      if (url === "/api/marketing-attribution") {
        return Promise.resolve(
          Response.json({
            id: "11111111-1111-4111-8111-111111111111",
            attribution: { utm_source: "google", utm_medium: "organic" },
          }),
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const track = vi.fn();
    window.zaraz = { track };
    const { trackNewCamelActivationAfterAcceptedMessage } = await import(
      "@/lib/marketing-attribution.client"
    );

    await trackNewCamelActivationAfterAcceptedMessage();
    await trackNewCamelActivationAfterAcceptedMessage();

    expect(
      fetchMock.mock.calls.filter(
        ([input]) => String(input) === "/api/marketing-attribution/activate",
      ),
    ).toHaveLength(1);
    expect(track).toHaveBeenCalledOnce();
    expect(track).toHaveBeenCalledWith(
      "new_camel_activation",
      expect.objectContaining({
        attribution_id: "11111111-1111-4111-8111-111111111111",
        completion_basis: "first_message_accepted",
        event_id: "new_camel_activation:activation-event-1",
      }),
    );
  });
});
