export const PINNED_GROUPS_COOKIE_NAME = "pinned_groups";

const MAX_WORKSPACE_ENTRIES = 8;
const MAX_PINNED_GROUP_COUNT_HINT = 20;
const MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

type PinnedGroupCountHints = Record<string, number>;

function clampPinnedGroupCount(count: number): number {
  if (!Number.isFinite(count)) return 0;
  return Math.max(0, Math.min(Math.floor(count), MAX_PINNED_GROUP_COUNT_HINT));
}

function parsePinnedGroupCountHints(
  cookieValue: string | undefined,
): PinnedGroupCountHints {
  if (!cookieValue) return {};

  const candidates = [cookieValue];
  try {
    const decoded = decodeURIComponent(cookieValue);
    if (decoded !== cookieValue) candidates.push(decoded);
  } catch {
    // The cookie parser may already have decoded the value.
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        continue;
      }
      const hints: PinnedGroupCountHints = {};
      for (const [workspaceId, count] of Object.entries(parsed)) {
        if (typeof count !== "number" || !Number.isFinite(count)) continue;
        hints[workspaceId] = clampPinnedGroupCount(count);
      }
      return hints;
    } catch {
      // Try the decoded candidate before treating the cookie as malformed.
    }
  }

  return {};
}

function readClientCookieValue(name: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  for (const part of document.cookie.split(";")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex < 0) continue;
    const cookieName = part.slice(0, separatorIndex).trim();
    if (cookieName === name) return part.slice(separatorIndex + 1).trim();
  }
  return undefined;
}

export function readPinnedGroupCountHint(
  cookieValue: string | undefined,
  workspaceId: string,
): number {
  if (!workspaceId) return 0;
  return parsePinnedGroupCountHints(cookieValue)[workspaceId] ?? 0;
}

export function writePinnedGroupCountHint(
  workspaceId: string,
  count: number,
): void {
  if (typeof document === "undefined" || !workspaceId) return;

  const current = parsePinnedGroupCountHints(
    readClientCookieValue(PINNED_GROUPS_COOKIE_NAME),
  );
  const next: PinnedGroupCountHints = { ...current };
  delete next[workspaceId];
  next[workspaceId] = clampPinnedGroupCount(count);

  while (Object.keys(next).length > MAX_WORKSPACE_ENTRIES) {
    const oldestWorkspaceId = Object.keys(next)[0];
    delete next[oldestWorkspaceId];
  }

  const currentValue = JSON.stringify(current);
  const nextValue = JSON.stringify(next);
  if (currentValue === nextValue) return;

  document.cookie = `${PINNED_GROUPS_COOKIE_NAME}=${encodeURIComponent(nextValue)}; path=/; max-age=${MAX_AGE_SECONDS}`;
}
