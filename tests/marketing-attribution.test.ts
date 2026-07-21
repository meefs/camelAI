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
});
