# Legacy User Notification — Review Round 2

## Status

March 19, 2026 — Post-codex-review fixes applied

---

## Fixes Already Applied (this round)

These were found by `codex review` and fixed directly in the code:

### 1. KV failure in `_app` loader could crash the entire app

**File:** `src/routes/_app.tsx`

The two `APP_KV.get()` calls for legacy-user detection were unguarded. If KV had a transient outage, the `_app` loader would reject and every authenticated page would 500 — all to decide whether to show an informational banner.

**Fix applied:** Wrapped the KV lookups in a try/catch that degrades to `showLegacyBanner = false` on failure.

### 2. Snooze key was not scoped per user

**File:** `src/components/legacy-user-banner.tsx`

The `localStorage` snooze key was `legacy_banner_snoozed_until` (global). If two legacy users shared a browser (e.g., logout/login), one user's snooze would leak to the other.

**Fix applied:** Changed to `legacy_banner_snoozed_until:{userId}`. The component now accepts a `userId` prop, and `_app.tsx` passes `authState.user.id`.

### 3. `--env local` silently fell through to remote KV

**File:** `scripts/import-legacy-emails.ts`

The CLI advertised `--env local` in its usage string, but `normalizeWranglerEnv` stripped `local` to `undefined`, which made `wrangler kv bulk put` fall back to the top-level KV binding (remote). Someone trying to seed local data could accidentally write to the shared remote namespace.

**Fix applied:** `--env local` now prints a warning explaining that local KV is managed by Miniflare and suggests using `--env dev-illiana` or `--env dev-miguel` instead.

### 4. Tests updated

All test files updated to pass `userId="test-user-1"` and use the scoped snooze key `legacy_banner_snoozed_until:test-user-1`. All 6 tests pass.

---

## No Remaining Issues

The dismiss route's auth try/catch pattern and method check both match the existing convention used by `src/routes/api/help.ts`. No changes needed there.
