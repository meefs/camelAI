// Chat group avatars render a Lucide icon (not an emoji). A group stores the
// icon's canonical kebab-case Lucide name (e.g. "bar-chart-3") in its avatar
// `content` field; the color field is vestigial and ignored when rendering.
//
// This module is worker-safe: it never imports `lucide-react` (which would pull
// ~1900 icon modules into the Worker bundle). Instead it validates against the
// committed name list in `lucide-icon-names.generated.ts`. The client renders
// names through one generated SVG sprite, keeping the full Lucide module graph
// out of runtime bundles.
import { LUCIDE_ICON_NAMES } from "@/lib/lucide-icon-names.generated";

// Any Lucide icon name is valid; this is just the canonical string type.
export type ChatGroupIconName = string;

// Fallback icon for new groups, legacy emoji rows, and any unrecognized value.
export const DEFAULT_CHAT_GROUP_ICON = "messages-square";

// Curated, hand-verified subset shown by default in the picker. Search in the
// picker still spans the full catalog; automatic selection uses Lucide's
// generated metadata rather than this list.
export const POPULAR_CHAT_GROUP_ICONS: readonly string[] = [
  "messages-square",
  "message-circle",
  "mail",
  "megaphone",
  "bell",
  "hash",
  "bar-chart-3",
  "line-chart",
  "pie-chart",
  "trending-up",
  "activity",
  "database",
  "table-2",
  "list-checks",
  "clipboard-list",
  "calendar",
  "clock",
  "target",
  "flag",
  "code",
  "file-code",
  "bug",
  "terminal",
  "git-branch",
  "cpu",
  "server",
  "cloud",
  "package",
  "wrench",
  "settings",
  "file-text",
  "file-spreadsheet",
  "folder",
  "book-open",
  "receipt",
  "rocket",
  "zap",
  "sparkles",
  "lightbulb",
  "flame",
  "star",
  "trophy",
  "users",
  "building-2",
  "briefcase",
  "globe",
  "map-pin",
  "compass",
  "shield",
  "dollar-sign",
  "shopping-cart",
  "palette",
  "graduation-cap",
  "heart",
];

// This module is shared with Worker code. Keep the module-level lookup truly
// immutable so isolate reuse cannot leak mutations between requests.
const LUCIDE_ICON_NAME_LOOKUP: Readonly<Record<string, true>> = Object.freeze(
  Object.fromEntries(LUCIDE_ICON_NAMES.map((name) => [name, true] as const)),
);

export function isChatGroupIconName(value: unknown): value is ChatGroupIconName {
  return typeof value === "string" && Object.hasOwn(LUCIDE_ICON_NAME_LOOKUP, value);
}

/**
 * Converts arbitrary input toward Lucide's canonical kebab-case id: splits
 * camel/Pascal case ("BarChart3" -> "bar-chart-3"), lowercases, and collapses
 * separators. Does not check that the result is a real icon.
 */
function toKebabIconName(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Za-z])([0-9])/g, "$1-$2")
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]+/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Normalizes arbitrary input to a valid Lucide icon name, or null when it does
 * not resolve to a real icon. Accepts kebab-case ids and best-effort coerces
 * camel/Pascal case so lightly malformed values (e.g. from AI generation) still
 * resolve.
 */
export function normalizeChatGroupIconName(
  value: unknown,
): ChatGroupIconName | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (isChatGroupIconName(trimmed)) return trimmed;
  const kebab = toKebabIconName(trimmed);
  return kebab && isChatGroupIconName(kebab) ? kebab : null;
}

/**
 * Resolves stored avatar `content` to a real icon name, falling back to the
 * default chat icon for legacy emoji rows or any unknown value.
 */
export function resolveChatGroupIconName(
  value: string | null | undefined,
): ChatGroupIconName {
  return normalizeChatGroupIconName(value) ?? DEFAULT_CHAT_GROUP_ICON;
}
