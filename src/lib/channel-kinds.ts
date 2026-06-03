export const CHANNEL_INDICATOR_KIND_ORDER = [
  "email",
  "slack",
  "telegram",
] as const;

export type ChannelIndicatorKind =
  (typeof CHANNEL_INDICATOR_KIND_ORDER)[number];

const CHANNEL_INDICATOR_KIND_SET = new Set<string>(
  CHANNEL_INDICATOR_KIND_ORDER,
);

export function normalizeChannelIndicatorKind(
  kind?: string | null,
): ChannelIndicatorKind | null {
  const normalized = kind?.trim().toLowerCase();
  return normalized && CHANNEL_INDICATOR_KIND_SET.has(normalized)
    ? (normalized as ChannelIndicatorKind)
    : null;
}

export function collectChannelIndicatorKinds(
  kinds: Iterable<unknown>,
): ChannelIndicatorKind[] {
  const present = new Set<ChannelIndicatorKind>();
  for (const kind of kinds) {
    const normalized = normalizeChannelIndicatorKind(
      typeof kind === "string" ? kind : null,
    );
    if (normalized) present.add(normalized);
  }
  return CHANNEL_INDICATOR_KIND_ORDER.filter((kind) => present.has(kind));
}

export function parseChannelIndicatorKindsJson(
  value?: string | null,
): ChannelIndicatorKind[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? collectChannelIndicatorKinds(parsed)
      : null;
  } catch {
    return null;
  }
}
