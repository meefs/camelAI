# PWA & Mobile — Phase 2: PWA Polish

> Phase 2 of 3. Phase 1 (`pwa-mobile-phase-1-message-actions-plan.md`) ships first. Phase 3 is `pwa-mobile-phase-3-larger-investments-plan.md`. **Each phase ships as its own PR.**

## Goal

Close the small-but-compounding gaps in our PWA setup. None of these is hard. Together they take the app from "renders on mobile" to "feels like a real installable app on iPhone."

Six independent sub-changes, all in this PR (or split into 2-3 sub-PRs if reviewer prefers). They're independent — any single one can ship or be reverted alone.

## Sub-Changes

| # | Change | Files | Risk |
|---|--------|-------|------|
| 2.1 | Stop unregistering service workers on every page load | `src/root.tsx` | Trivial |
| 2.2 | Expand `site.webmanifest` (description, shortcuts, screenshots, categories) | `public/site.webmanifest`, `public/screenshots/*` | Low |
| 2.3 | Safe-area-inset utilities + apply to chat input, top bar, sidebar | `src/styles/globals.css`, `src/components/Chat.tsx`, `src/components/chat-tab-bar.tsx`, `src/components/sidebar/app-sidebar.tsx` | Low |
| 2.4 | `overscroll-behavior-y: none` to kill iOS pull-to-refresh inside chat | `src/styles/globals.css` | Low |
| 2.5 | `theme-color` meta tags media-queried for light/dark | `src/root.tsx` | Trivial |
| 2.6 | Audit and replace `100vh` / `min-h-screen` with `100dvh` in layout-critical spots | grep across `src/` | Low–Medium |

---

## 2.1 — Stop Unregistering Service Workers

[src/root.tsx:67-71](src/root.tsx#L67-L71) currently runs on every page load:

```tsx
        <script
          dangerouslySetInnerHTML={{
            __html: `if('serviceWorker' in navigator){navigator.serviceWorker.getRegistrations().then(function(r){r.forEach(function(reg){reg.unregister()})})}`,
          }}
        />
```

This was presumably a one-time defensive cleanup from a prior SW experiment. **It's now in the way.** Phase 3 plans a real service worker; this script would unregister it on the very next load. Even without Phase 3, it does nothing for the 99.9% of users who never had a SW.

**Action:** delete the entire `<script>` block (lines 67-71). No replacement.

---

## 2.2 — Expand `site.webmanifest`

Current manifest at `public/site.webmanifest` is minimal — name, icons, colors. Replace with the full version below.

### New `public/site.webmanifest`

```json
{
  "name": "camelAI",
  "short_name": "camelAI",
  "description": "Chat with a coding agent that has its own persistent computer. Build and publish apps from your phone or desktop.",
  "start_url": "/",
  "scope": "/",
  "id": "/",
  "display": "standalone",
  "display_override": ["window-controls-overlay", "standalone", "minimal-ui"],
  "orientation": "any",
  "theme_color": "#09090b",
  "background_color": "#09090b",
  "categories": ["productivity", "developer", "utilities"],
  "icons": [
    { "src": "/android-chrome-192x192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/android-chrome-512x512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/android-chrome-512x512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ],
  "shortcuts": [
    {
      "name": "New chat",
      "short_name": "New",
      "description": "Start a new chat in your default workspace",
      "url": "/",
      "icons": [{ "src": "/android-chrome-192x192.png", "sizes": "192x192" }]
    }
  ],
  "screenshots": []
}
```

### Implementation notes for the agent

- **Verify route URLs before adding more shortcuts.** Only `/` is guaranteed to exist (it's the landing route). I deliberately scoped `shortcuts` to one safe entry. If `/workspaces` or `/chat/new` exist as real routes, add them; otherwise leave the single shortcut. To verify: grep `src/routes.ts` for `route("workspaces"`, `route("chat/new"` etc., or run `bun run typecheck` after adding and watch for `Route` type errors. **Do not link to a route that doesn't exist** — Android will silently fail the shortcut.
- **`screenshots` is intentionally empty.** Mobile install prompts on Android show a richer card when screenshots exist, but missing files cause the manifest to fail validation. If screenshots aren't ready yet, leave the array empty (valid) rather than referencing files that don't exist (invalid). Follow-up task: ask design for a 1080×1920 portrait screenshot of the chat UI and a 1920×1080 landscape one. When they exist, drop into `public/screenshots/`, then populate the array:

```json
  "screenshots": [
    {
      "src": "/screenshots/chat-mobile.png",
      "sizes": "1080x1920",
      "type": "image/png",
      "form_factor": "narrow",
      "label": "Chat with the camelAI coding agent"
    },
    {
      "src": "/screenshots/chat-desktop.png",
      "sizes": "1920x1080",
      "type": "image/png",
      "form_factor": "wide",
      "label": "Chat and live preview side by side"
    }
  ]
```

- **`display_override`** is an ordered list of preferred display modes. `window-controls-overlay` is for desktop PWA installs and falls through to `standalone` on mobile. Safe addition.
- **Existing icon paths are reused as-is.** Don't generate new icons.

### Validation

After the edit, paste the manifest into <https://manifest-validator.appspot.com/> or run a Lighthouse PWA audit in Chrome DevTools. Expect zero errors.

---

## 2.3 — Safe-Area Insets

iOS PWAs in `apple-mobile-web-app-status-bar-style: black-translucent` (set at [src/root.tsx:119](src/root.tsx#L119)) draw under the status bar and home indicator. Without `env(safe-area-inset-*)` padding, the prompt input slides under the home indicator and the top bar slides under the notch.

```
                ╔════════════════════════════════╗
            ┌───╫─ NOTCH ────────────────────────╫───┐  ← need pt-safe here
            │   ║ ChatTabBar                     ║   │
            │   ║ ┌────────────────────────────┐ ║   │
            │   ║ │ Chat scroll                │ ║   │
            │   ║ │                            │ ║   │
            │   ║ │ Messages…                  │ ║   │
            │   ║ │                            │ ║   │
            │   ║ ├────────────────────────────┤ ║   │
            │   ║ │ Prompt input               │ ║   │
            │   ║ └────────────────────────────┘ ║   │
            │   ║   ↑ pb-safe here ↑             ║   │
            │   ╚════════════════════════════════╝   │
            │      ░░ HOME INDICATOR ░░              │
            └────────────────────────────────────────┘
```

### Step 1: define safe-area utilities in globals.css

This codebase uses Tailwind v4 with `@utility` blocks (see existing `@utility no-scrollbar` in [src/styles/globals.css:67-74](src/styles/globals.css#L67-L74)).

**File:** `src/styles/globals.css`

**Where:** add a new block immediately below the existing `@utility no-scrollbar` block (around line 74). Do **not** put it inside `@theme` or `@layer base` — `@utility` is a top-level Tailwind v4 directive.

**Content to add:**

```css
@utility pt-safe {
  padding-top: max(var(--tw-padding-top, 0px), env(safe-area-inset-top));
}

@utility pb-safe {
  padding-bottom: max(var(--tw-padding-bottom, 0px), env(safe-area-inset-bottom));
}

@utility pl-safe {
  padding-left: max(var(--tw-padding-left, 0px), env(safe-area-inset-left));
}

@utility pr-safe {
  padding-right: max(var(--tw-padding-right, 0px), env(safe-area-inset-right));
}
```

This gives us four utility classes (`pt-safe`, `pb-safe`, `pl-safe`, `pr-safe`) that add the safe-area inset on top of any other padding utility on the same element. They should compose with existing `pt-*` / `pb-*` because `max()` picks the larger.

> **Agent note (Tailwind v4 quirk):** if `var(--tw-padding-*)` doesn't resolve cleanly when composing with other padding utilities, fall back to the simpler form below. Pick whichever works on first try — verify by visually checking a notched iPhone preview in Chrome DevTools (Device toolbar → iPhone 15 Pro):
>
> ```css
> @utility pt-safe { padding-top: env(safe-area-inset-top); }
> @utility pb-safe { padding-bottom: env(safe-area-inset-bottom); }
> @utility pl-safe { padding-left: env(safe-area-inset-left); }
> @utility pr-safe { padding-right: env(safe-area-inset-right); }
> ```
>
> The simpler form *replaces* rather than composes with existing padding. If you go with the simpler form, change `pb-4` on the composer wrapper (Step 2 below) to `pb-[max(1rem,env(safe-area-inset-bottom))]` instead. Either approach works; the `max()` arbitrary value is slightly more verbose but bulletproof.

### Step 2: apply `pb-safe` to the chat composer

**File:** [src/components/Chat.tsx:6216](src/components/Chat.tsx#L6216)

The composer wrapper currently is:

```tsx
            <div className="pt-2 pb-4 px-4">
```

**Change to:**

```tsx
            <div className="pt-2 pb-4 px-4 pb-safe">
```

(With the simpler `@utility pb-safe` fallback, replace `pb-4` with the arbitrary value as noted above. Don't keep both `pb-4` and `pb-safe` if `pb-safe` doesn't compose.)

### Step 3: apply `pt-safe` to the top tab bar

**File:** `src/components/chat-tab-bar.tsx`

Open the file, find the **outermost** wrapping element (the one that anchors the bar at the top of the page). It will be a `<div>` or `<header>` near the top of the JSX tree — typically with `flex`, `border-b`, or `bg-` classes.

Add `pt-safe` to its className. Example:

**If you find something like:**
```tsx
<div className="flex items-center border-b bg-background px-4 py-2">
```

**Change to:**
```tsx
<div className="flex items-center border-b bg-background px-4 py-2 pt-safe">
```

If `chat-tab-bar.tsx` doesn't contain an obvious top-level wrapper, the safer fallback is to apply `pt-safe` to its parent at [src/routes/_app.chat.$id.tsx](src/routes/_app.chat.$id.tsx) on the outermost `<div className="flex h-full min-h-0 flex-col">`.

### Step 4: apply `pl-safe` and `pr-safe` to the sidebar

**File:** [src/components/sidebar/app-sidebar.tsx](src/components/sidebar/app-sidebar.tsx)

Open the file. Find the outermost `<Sidebar>` (or its inner `<SidebarContent>`) wrapper. Add `pl-safe` (so a landscape iPhone with the notch on the left doesn't tuck the sidebar under it). Example: if you see

```tsx
<Sidebar collapsible="icon">
```

…and the visible left edge styling lives one level inside, add `pl-safe` to the inner `<SidebarHeader>` or `<SidebarContent>` wrapper. The exact element varies — pick the one whose left edge sits at viewport `x = 0` when the sidebar is open.

This is the lowest-priority of the three (most users hold phones portrait), but it's a one-class addition.

### Visual QA

In Chrome DevTools → Device Toolbar → "iPhone 15 Pro" or similar notched device:

- The **prompt input** should sit visually clear of the simulated home indicator (Chrome simulates this).
- The **top of the chat tab bar** should sit clear of the notch.
- Rotate to landscape — sidebar (when open) should not tuck under the left/right notch.

Real-device QA (iPhone with home indicator, in PWA mode via Add to Home Screen) is the gold-standard test.

---

## 2.4 — `overscroll-behavior` to Block Pull-to-Refresh

iOS Safari fires its built-in pull-to-refresh when you yank the page top. Inside chat, that means scrolling up past message #1 reloads the page mid-conversation.

**File:** `src/styles/globals.css`

**Where:** add to an existing `@layer base` block (one exists around line 191 — see [src/styles/globals.css:191](src/styles/globals.css#L191)). If the block is small, add at the bottom of it.

**Content:**

```css
@layer base {
  html, body {
    overscroll-behavior-y: none;
  }
}
```

This is global. If a future feature actually wants pull-to-refresh on a specific page, that page can opt back in with a localized `overscroll-behavior-y: auto`. Currently no such page exists.

---

## 2.5 — `theme-color` for Light Mode

Currently [src/root.tsx:121](src/root.tsx#L121) sets a single dark `theme-color`:

```ts
{ name: 'theme-color', content: '#09090b' },
```

On a phone in light mode, this paints the iOS status-bar-bleed and Android tab strip dark, which clashes with the light app surface.

**File:** [src/root.tsx:121](src/root.tsx#L121) (inside `meta()` function returning `Route.MetaDescriptors`)

**Replace** the single line with:

```ts
{ name: 'theme-color', content: '#ffffff', media: '(prefers-color-scheme: light)' },
{ name: 'theme-color', content: '#09090b', media: '(prefers-color-scheme: dark)' },
```

The browser picks the matching one at runtime. The manifest's single `theme_color: "#09090b"` stays — manifest spec doesn't support media queries, but the meta tag wins for the address bar / status bar at runtime.

> **Agent note:** Check whether the React Router `meta()` typing for `MetaDescriptors` accepts `media` as a key. It should — it passes through to the rendered `<meta>` tag — but if the type complains, cast or use the alternative `tagName: "meta"` form. Don't fight the types; if blocked, fall back to setting the meta tags directly in the `<head>` of `Layout` in `src/root.tsx`:
>
> ```tsx
> <head>
>   {/* …existing… */}
>   <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
>   <meta name="theme-color" content="#09090b" media="(prefers-color-scheme: dark)" />
> </head>
> ```
>
> If you take that fallback, remove the existing `theme-color` from the `meta()` return.

---

## 2.6 — Viewport-Height Audit

[src/components/Chat.tsx:1](src/components/Chat.tsx#L1) already uses `100dvh` in some spots — good. The remaining `100vh` and `min-h-screen` references in *layout-critical* spots will cause iOS Safari URL-bar jitter and chrome that hides under the keyboard.

### Step 1: find candidates

Run:

```bash
grep -rn "100vh\|min-h-screen\|h-screen" src/components src/routes --include="*.tsx" --include="*.css"
```

### Step 2: triage

For each result, decide:

- **Layout-critical** (chat, prompt input, full-screen overlays, sticky/fixed elements): replace `100vh` → `100dvh`, `min-h-screen` → `min-h-[100dvh]`, `h-screen` → `h-[100dvh]`.
- **Static page** (marketing, error page, settings page that scrolls naturally): leave alone. `min-h-screen` is acceptable on pages where the URL-bar shift isn't user-visible.

### Specific known fixes

- [src/components/chat-file-preview/notebook-preview/full-screen-dialog.tsx](src/components/chat-file-preview/notebook-preview/full-screen-dialog.tsx) uses `calc(100dvh-2rem)` — already correct, no change.
- The `ErrorBoundary` in [src/root.tsx:97-98](src/root.tsx#L97-L98) uses `min-h-screen` — leave as-is (error page, no chat interaction).
- Anywhere inside `src/components/Chat.tsx`, `src/components/prompt-input.tsx`, or any `src/components/chat-file-preview/**` should prefer `100dvh`.

### Step 3: don't introduce regressions

`dvh` resolves dynamically with the URL bar. Some layouts that *want* a stable height (e.g. modal dialogs that shouldn't resize when the URL bar shows/hides) want `svh` (small viewport height) instead. Use judgment: if the element is **scrolling content**, `dvh`; if it's a **fixed-height modal**, consider `svh`.

When in doubt, leave existing working code alone and only fix verified-broken cases.

---

## Files Touched (full Phase 2 scope)

| File | Change |
|------|--------|
| `src/root.tsx` | Delete SW-unregister script (lines 67-71); replace single `theme-color` meta with two media-queried versions |
| `public/site.webmanifest` | Replace contents with expanded version above |
| `public/screenshots/*.png` | Optionally add (deferred to design); leave `screenshots: []` if not ready |
| `src/styles/globals.css` | Add 4 `@utility` safe-area blocks + `overscroll-behavior` rule in `@layer base` |
| `src/components/Chat.tsx` | Add `pb-safe` to composer wrapper at line 6216; audit `100vh` → `100dvh` |
| `src/components/chat-tab-bar.tsx` | Add `pt-safe` to outermost wrapper |
| `src/components/sidebar/app-sidebar.tsx` | Add `pl-safe` to outermost left-edge wrapper |
| Various | `100vh` → `100dvh` audit per Step 2.6 |

## QA Checklist

- [ ] `bun run typecheck` passes.
- [ ] `bun run lint` passes.
- [ ] **Lighthouse PWA audit** in Chrome DevTools → Application → Manifest: zero errors. PWA score ≥ 90.
- [ ] Manifest validator (<https://manifest-validator.appspot.com/>): zero errors.
- [ ] **Real iPhone, PWA installed (Add to Home Screen):**
  - [ ] Status bar / notch doesn't overlap the chat tab bar.
  - [ ] Home indicator doesn't overlap the prompt input.
  - [ ] Pull down at the top of chat does **not** refresh the page.
  - [ ] Long-press the home-screen icon shows the "New chat" shortcut.
  - [ ] Toggle iOS Settings → Display → Light/Dark Mode: status-bar-bleed color flips.
- [ ] **Chrome desktop, light mode:** browser theme color is light. Toggle to dark mode: theme color is dark.
- [ ] **No regressions** in any existing chat / file-preview / settings page (visual diff of key pages).
- [ ] If a service worker existed in any user's cached install (unlikely but possible from old experiments), it stays unregistered until a real Phase 3 SW ships. No mid-state where a stale SW lingers.

## Non-Goals

- No service worker added (Phase 3).
- No `share_target` (needs a backend route to receive shares — scope separately).
- No `beforeinstallprompt` UX (manifest improvements alone make Android show a richer prompt; revisit if install rates are low).
- No iOS Add-to-Home-Screen banner / education UI in this PR.
- No font-size or line-height changes for mobile readability — separate concern.

## Success Criteria

- Lighthouse PWA score ≥ 90 (currently likely in the 60s due to manifest gaps).
- iPhone PWA renders without notch or home-indicator overlap.
- Long-press on installed icon shows shortcuts on Android.
- No accidental pull-to-refresh during chat.
- Status bar / browser chrome color matches the user's color scheme on both iOS and Android.
- Phase 3's service worker (when it ships) is no longer fighting the unregister script.
