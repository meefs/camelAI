# Legacy User Notification — Implementation Feedback

## Status

March 19, 2026 — Review of Draft v2 implementation

---

## Fix: Banner Does Not Show in Local Dev

The loader checks `APP_KV.get("legacy_user:admin@example.com")`, but local dev uses Miniflare's **local** KV store, which is empty. The import script writes to **remote** Cloudflare KV via `wrangler kv bulk put`. The banner will work in production, but we also want to be able to test it locally.

**Fix:** In the `_app.tsx` loader, when running in development mode, skip the KV lookup and always treat the user as a legacy user (still respect dismissal so that flow is testable too):

```typescript
const isDev = env.NEXTJS_ENV === 'development';
const normalizedEmail = authContext.user.email.trim().toLowerCase();

const isLegacyUser = isDev
  ? true
  : Boolean(await env.APP_KV.get(`legacy_user:${normalizedEmail}`));

const hasDismissed = isLegacyUser
  ? Boolean(await env.APP_KV.get(`legacy_banner_dismissed:${authContext.user.id}`))
  : false;

const showLegacyBanner = isLegacyUser && !hasDismissed;
```

This means every developer running locally sees the banner without needing to seed Miniflare's KV. Dismissal still works because that writes to local KV at runtime.

---

## Fix: X Button Should Not Permanently Dismiss

**Reported:** Clicking the `✕` button on the collapsed card permanently dismisses the banner (posts to `/api/legacy-banner/dismiss`, writes to KV). After refresh, the banner is gone forever.

**Problem:** The `✕` and "Got it, don't show again" both call the same `handleDismiss` function, which means there's no way for a user to casually close the card and see it again later. A user who quickly hits X to clear the notification never reads the actual message and never sees it again. These should be two distinct behaviors:

- **`✕` button** → Temporary dismiss. Hide the card, but bring it back on the next page load (navigation within the app). Use `localStorage` with a timestamp to suppress for a short cooldown period (e.g., 1 hour). This way the banner isn't annoying if they're in the middle of something, but it comes back soon enough that they'll eventually read it.
- **"Got it, don't show again"** → Permanent dismiss via `POST /api/legacy-banner/dismiss` (KV write, as currently implemented). Banner never returns.

**Changes needed in `src/components/legacy-user-banner.tsx`:**

1. On mount, check `localStorage.getItem('legacy_banner_snoozed_until')` — if set and the timestamp is in the future, don't render
2. Add a separate `handleClose` function for the `✕` button that writes a snooze timestamp to `localStorage` and hides via local state (no API call). Snooze duration: 1 hour (`Date.now() + 60 * 60 * 1000`).
3. Keep `handleDismiss` for the "Got it, don't show again" CTA only (permanent, API call)

```typescript
const SNOOZE_KEY = 'legacy_banner_snoozed_until';
const SNOOZE_DURATION_MS = 60 * 60 * 1000; // 1 hour

// Check on mount whether snoozed
const [isSnoozed] = useState(() => {
  const snoozedUntil = localStorage.getItem(SNOOZE_KEY);
  return snoozedUntil ? Date.now() < Number(snoozedUntil) : false;
});

// X button — snooze (temporary)
function handleClose() {
  localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_DURATION_MS));
  setIsHidden(true);
}

// "Got it, don't show again" — permanent KV dismiss
function handleDismiss() {
  localStorage.removeItem(SNOOZE_KEY); // clean up snooze key
  dismissPendingRef.current = true;
  setIsDismissed(true);
  setIsExpanded(false);
  fetcher.submit({}, { method: 'post', action: '/api/legacy-banner/dismiss' });
}
```

The 1-hour snooze means: if someone is in the middle of work and hits X, the banner won't pester them for an hour. But next time they come back (or after an hour in the same session), it reappears. They have to actually expand and read the message to permanently dismiss it.

---

## Fix: Replace Lucide Hand Icon with Waving Emoji + Animation

**Reported:** The Lucide `Hand` icon is static and doesn't convey a friendly wave. It's generic.

**Fix:** Replace the Lucide `Hand` icon with the actual wave emoji (`👋`) and add a subtle CSS waving animation. The emoji is more recognizable and warmer. The animation draws the eye without being obnoxious.

**Option A — Waving emoji (recommended):**

Replace the `<Hand>` icon with a `<span>` containing the emoji, and add a `@keyframes wave` animation that rotates it back and forth a couple of times then stops:

```css
/* Add to globals.css or as inline keyframes via Tailwind arbitrary values */
@keyframes wave {
  0%, 100% { transform: rotate(0deg); }
  10% { transform: rotate(14deg); }
  20% { transform: rotate(-8deg); }
  30% { transform: rotate(14deg); }
  40% { transform: rotate(-4deg); }
  50% { transform: rotate(10deg); }
  60% { transform: rotate(0deg); }
  /* stays still for the remaining 40% */
}
```

```tsx
// In the component:
<span className="inline-block animate-[wave_1.5s_ease-in-out_1]" aria-hidden="true">
  👋
</span>
```

This waves twice over 1.5 seconds then stops — noticeable but not distracting.

**Option B — Glowing notification dot:**

Instead of a hand, use a small pulsing dot (like an unread indicator) next to the text:

```tsx
<span className="relative flex size-2.5 shrink-0">
  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
  <span className="relative inline-flex size-2.5 rounded-full bg-primary" />
</span>
```

This is the standard "pulsing dot" pattern (similar to Tailwind's `animate-ping` example). More subtle, draws the eye through motion without emoji personality.

**Recommendation:** Option A (waving emoji) matches the original intent better — it's friendly and immediately communicates "hey, look here." Option B is more corporate/subtle. Either works. Do not use both together.

---

## Code Quality Issues

### 1. KV lookups are sequential but could be parallelized

**File:** `src/routes/_app.tsx` (loader)

The two KV lookups run sequentially — the dismissal check waits for the legacy-user check. These are independent reads that could be parallelized with `Promise.all` to shave ~1ms off the loader:

```typescript
const normalizedEmail = authContext.user.email.trim().toLowerCase();
const [isLegacyUser, hasDismissed] = await Promise.all([
  env.APP_KV.get(`legacy_user:${normalizedEmail}`),
  env.APP_KV.get(`legacy_banner_dismissed:${authContext.user.id}`),
]);
const showLegacyBanner = Boolean(isLegacyUser) && !Boolean(hasDismissed);
```

This is a minor optimization but it's also simpler code — no conditional nesting.

### 2. The dismiss route catches auth redirects as errors — fragile pattern

**File:** `src/routes/api/legacy-banner.dismiss.ts` (lines 10-18)

```typescript
try {
  authContext = await requireAuthContext(request, context);
} catch (error) {
  if (error instanceof Response && error.status >= 300 && error.status < 400) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }
  throw error;
}
```

This intercepts redirect `Response` throws from `requireAuthContext` to convert them into JSON 401s. This works but is fragile — it depends on the internal behavior of `requireAuthContext` throwing `Response` objects for redirects.

Look at how other API routes in the codebase handle this (e.g., `src/routes/api/help.ts`). If they just let the redirect propagate, this route should too — the fetcher on the client side will handle the redirect naturally. If there's a precedent for catching and converting, keep it. But check the pattern.

### 3. Method check is unnecessary with React Router actions

**File:** `src/routes/api/legacy-banner.dismiss.ts` (lines 5-8)

```typescript
if (request.method !== 'POST') {
  return Response.json({ error: 'Method not allowed' }, { status: 405 });
}
```

Since this is exported as `action`, React Router only routes POST/PUT/PATCH/DELETE to it. GET requests won't reach this function. The method check is not harmful but is unnecessary boilerplate. Check if other API routes in the project follow this pattern — if they don't, remove it for consistency.

### 4. `useEffect` to reset state when `show` changes is unnecessary

**File:** `src/components/legacy-user-banner.tsx` (lines 32-37)

```typescript
useEffect(() => {
  if (show) return;
  setIsExpanded(false);
  setIsDismissed(false);
  dismissPendingRef.current = false;
}, [show]);
```

When `show` is false, the component returns `null` at line 58. When `show` later becomes true, React re-renders and `useState` defaults kick in (both already `false`). This effect only matters if `show` toggles from true→false→true *within the same mount*, which can't happen in practice since the loader determines the value server-side and it won't flip mid-session. Remove this effect — it adds complexity with no practical benefit.

---

## Nits

### 5. `cn()` import is unused in rendered markup

**File:** `src/components/legacy-user-banner.tsx` (line 13)

`cn` is imported from `@/lib/utils` but is only used once on line 94 for the `CollapsibleContent` className, where it joins two static strings. This could just be a template literal. Not blocking, just unnecessary dependency.

### 6. The `animate-in fade-in-0 slide-in-from-bottom-2` classes on the outer div

**File:** `src/components/legacy-user-banner.tsx` (line 61)

These animation utilities look like they come from `tailwindcss-animate`. Confirm these are installed and configured — if not, they'll silently do nothing and the card will just pop in without animation. Check `tailwind.config` or `globals.css` for `tailwindcss-animate` plugin registration.

---

## Summary of Required Changes

| Priority | Issue | File |
|----------|-------|------|
| **Fix** | X button should session-dismiss only, not permanent KV dismiss | `src/components/legacy-user-banner.tsx` |
| **Fix** | Replace Lucide Hand with waving `👋` emoji + CSS animation (Option A) | `src/components/legacy-user-banner.tsx`, `src/styles/globals.css` |
| **Fix** | Show banner for all users in dev mode (`NEXTJS_ENV === 'development'`) | `src/routes/_app.tsx` |
| Minor | Parallelize KV lookups with `Promise.all` | `src/routes/_app.tsx` |
| Minor | Review auth redirect catch pattern against codebase conventions | `src/routes/api/legacy-banner.dismiss.ts` |
| Nit | Remove unnecessary method check if not a codebase pattern | `src/routes/api/legacy-banner.dismiss.ts` |
| Nit | Remove unnecessary `useEffect` for `show` toggle | `src/components/legacy-user-banner.tsx` |
| Nit | Verify `tailwindcss-animate` is configured for entry animations | `src/components/legacy-user-banner.tsx` |
