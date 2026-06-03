import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChannelLogoStack } from "@/components/chat/channel-logo";
import {
  getChannelBrand,
  orderedChannelBrands,
} from "@/lib/channel-branding";
import {
  normalizeChannelIndicatorKind,
  parseChannelIndicatorKindsJson,
} from "@/lib/channel-kinds";

describe("channel indicator helpers", () => {
  it("normalizes only supported external channel kinds", () => {
    expect(normalizeChannelIndicatorKind(" Email ")).toBe("email");
    expect(normalizeChannelIndicatorKind("SLACK")).toBe("slack");
    expect(normalizeChannelIndicatorKind("telegram")).toBe("telegram");
    expect(normalizeChannelIndicatorKind("web")).toBeNull();
    expect(normalizeChannelIndicatorKind("scheduled")).toBeNull();
    expect(normalizeChannelIndicatorKind(null)).toBeNull();
    expect(normalizeChannelIndicatorKind("discord")).toBeNull();
  });

  it("returns branding for known channels only", () => {
    expect(getChannelBrand("email")?.label).toBe("Email");
    expect(getChannelBrand("slack")?.logoType).toBe("slack");
    expect(getChannelBrand("telegram")?.logoType).toBe("telegram");
    expect(getChannelBrand("web")).toBeNull();
    expect(getChannelBrand(null)).toBeNull();
  });

  it("parses stored channel kind JSON defensively", () => {
    expect(parseChannelIndicatorKindsJson('["slack","email","web"]')).toEqual([
      "email",
      "slack",
    ]);
    expect(parseChannelIndicatorKindsJson('"slack"')).toBeNull();
    expect(parseChannelIndicatorKindsJson("{")).toBeNull();
    expect(parseChannelIndicatorKindsJson(null)).toBeNull();
    expect(parseChannelIndicatorKindsJson('["unknown"]')).toEqual([]);
  });

  it("orders and dedupes channel brands canonically", () => {
    expect(
      orderedChannelBrands(["telegram", "slack", "email", "slack", "web"]).map(
        (brand) => brand.kind,
      ),
    ).toEqual(["email", "slack", "telegram"]);
  });
});

describe("ChannelLogoStack", () => {
  it("renders known channels in canonical order with per-channel labels", () => {
    const { container } = render(
      <ChannelLogoStack
        channels={["telegram", "unknown", "email", "slack", "email"]}
        tooltipFor={(label) => `Contains messages sent via ${label}`}
      />,
    );

    const chips = Array.from(
      container.querySelectorAll('[aria-label^="Contains messages sent via"]'),
    ).map((node) => node.getAttribute("aria-label"));
    expect(chips).toEqual([
      "Contains messages sent via Email",
      "Contains messages sent via Slack",
      "Contains messages sent via Telegram",
    ]);
  });
});
