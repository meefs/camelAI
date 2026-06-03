import { Mail } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  CHANNEL_INDICATOR_KIND_ORDER,
  normalizeChannelIndicatorKind,
  type ChannelIndicatorKind,
} from "@/lib/channel-kinds";

export interface ChannelBrand {
  kind: ChannelIndicatorKind;
  label: string;
  icon?: LucideIcon;
  logoType?: string;
}

export const CHANNEL_BRANDS: Record<ChannelIndicatorKind, ChannelBrand> = {
  email: { kind: "email", label: "Email", icon: Mail },
  slack: { kind: "slack", label: "Slack", logoType: "slack" },
  telegram: { kind: "telegram", label: "Telegram", logoType: "telegram" },
};

export function getChannelBrand(kind?: string | null): ChannelBrand | null {
  const normalized = normalizeChannelIndicatorKind(kind);
  return normalized ? CHANNEL_BRANDS[normalized] : null;
}

export function orderedChannelBrands(kinds: Iterable<string>): ChannelBrand[] {
  const present = new Set(
    Array.from(kinds)
      .map((kind) => normalizeChannelIndicatorKind(kind))
      .filter((kind): kind is ChannelIndicatorKind => Boolean(kind)),
  );
  return CHANNEL_INDICATOR_KIND_ORDER.filter((kind) =>
    present.has(kind),
  ).map((kind) => CHANNEL_BRANDS[kind]);
}
