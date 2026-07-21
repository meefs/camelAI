import {
  captureMarketingAttribution,
  trackMarketingEventOnce,
} from "@/lib/marketing-attribution.client";

describe("marketing attribution", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
      key: (index: number) => Array.from(values.keys())[index] ?? null,
      get length() {
        return values.size;
      },
    } satisfies Storage;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: storage,
    });
    delete window.zaraz;
    delete window.gtag;
  });

  it("captures Google click IDs and UTM parameters", () => {
    expect(
      captureMarketingAttribution(
        "?gclid=test-click&utm_source=google&utm_campaign=brand&ignored=nope",
      ),
    ).toEqual({
      gclid: "test-click",
      utm_source: "google",
      utm_campaign: "brand",
    });
  });

  it("retains the first click ID when later pages have no attribution query", () => {
    captureMarketingAttribution("?gclid=test-click&utm_source=google");
    expect(captureMarketingAttribution("?page=chat")).toEqual({
      gclid: "test-click",
      utm_source: "google",
    });
  });

  it("sends conversion events once through Zaraz", () => {
    const track = vi.fn();
    window.zaraz = { track };

    trackMarketingEventOnce("sign_up", "attempt-1", { method: "email" });
    trackMarketingEventOnce("sign_up", "attempt-1", { method: "email" });

    expect(track).toHaveBeenCalledOnce();
    expect(track).toHaveBeenCalledWith("sign_up", { method: "email" });
  });

  it("does not mark an event sent before an analytics provider is ready", () => {
    trackMarketingEventOnce("sign_up", "attempt-1");
    const track = vi.fn();
    window.zaraz = { track };
    trackMarketingEventOnce("sign_up", "attempt-1");

    expect(track).toHaveBeenCalledOnce();
  });
});
