# Legacy User Notification Banner

## Status

March 19, 2026 — Draft v2

## Problem

We've pivoted from an analytics tool (app.camelai.com) to a full coding-agent platform (camelai.dev). Our sales site now routes to camelai.dev, so ~2,300 active/paying legacy users land on the new product and get confused — they don't know where their dashboards went. We need to proactively surface a one-time notification that explains the transition and gives them a direct path back to their analytics workspace.

---

## Goal

Legacy users who log in see a non-intrusive floating notification card in the bottom-right corner. Clicking it expands the full context about the product transition with a link to app.camelai.com. They can permanently dismiss it. Non-legacy users never see it.

---

## Design

### 1. Floating Card (Collapsed — Default State)

A small floating card fixed to the bottom-right corner of the viewport, overlaying page content. Uses `position: fixed` so it persists across all pages within the `_app` layout. Styled to match the site's zinc theme using existing design tokens (`popover`, `card`, `border`).

```
┌─────────────────────┬──────────────────────────────────────────┐
│                     │                                          │
│     Sidebar         │           Page Content (Outlet)          │
│                     │                                          │
│                     │                                          │
│                     │                                          │
│                     │                                          │
│                     │        ┌────────────────────────────────┐ │
│                     │        │ 👋 Things look different?      │ │
│                     │        │    Here's why              ✕   │ │
│                     │        └────────────────────────────────┘ │
└─────────────────────┴──────────────────────────────────────────┘
```

- Fixed position: `fixed bottom-4 right-4 z-50`
- Card styling: `bg-popover text-popover-foreground border border-border rounded-lg shadow-lg`
- `cursor-pointer` on the card body — clicking expands the detail
- `✕` button in the top-right corner permanently dismisses (does not expand first)
- `Hand` icon (Lucide) for a friendly wave to draw attention
- Card text: **"Things look different? Here's why"**
- Floats above page content but below modals/dialogs (`z-50`)

### 2. Expanded Card

Clicking the collapsed card expands it in-place (grows upward from the bottom-right anchor). Uses `Collapsible` (shadcn) for the expand/collapse transition.

```
                                  ┌──────────────────────────────────┐
                                  │ 👋 Things look different?    ▴ ✕ │
                                  │    Here's why                    │
                                  ├──────────────────────────────────┤
                                  │                                  │
                                  │  You're on camelAI.dev — the     │
                                  │  new camelAI. What started as    │
                                  │  an analytics tool has evolved   │
                                  │  into a full platform: a coding  │
                                  │  agent with a persistent         │
                                  │  computer that can build,        │
                                  │  deploy, and automate anything.  │
                                  │                                  │
                                  │  Your existing dashboards and    │
                                  │  data connections are still      │
                                  │  live. Nothing is going away.    │
                                  │                                  │
                                  │  ┌──────────────────────────┐   │
                                  │  │ Take me to my analytics  │   │
                                  │  │ workspace            ↗   │   │
                                  │  └──────────────────────────┘   │
                                  │  ┌──────────────────────────┐   │
                                  │  │ Got it, don't show again │   │
                                  │  └──────────────────────────┘   │
                                  │                                  │
                                  └──────────────────────────────────┘
```

- Max width: `w-80` (~320px) — compact card, not a full-width banner
- Same `bg-popover border-border shadow-lg rounded-lg` styling as collapsed state
- Body text: `text-sm text-muted-foreground`

**CTAs (stacked vertically to fit card width):**
- **"Take me to my analytics workspace"** — Primary `Button` (default variant, full-width), links to `https://app.camelai.com` (`target="_blank"`, `rel="noopener"`), with external-link icon (`ArrowUpRight` from Lucide)
- **"Got it, don't show again"** — Secondary `Button` (outline variant, full-width), permanently dismisses

**Collapse/expand indicator:** Small chevron icon (`ChevronDown`/`ChevronUp`) next to the `✕`.

### 3. Interaction Flow

```
User logs in
     │
     ▼
 Is user email in        No
 legacy email set? ──────────► Show nothing
     │ Yes
     ▼
 Has user dismissed?     Yes
 (UserDO flag) ──────────────► Show nothing
     │ No
     ▼
 Show collapsed bar
     │
     ├── Click bar text ──► Expand detail panel
     │                          │
     │                          ├── "Take me to analytics" ──► Opens app.camelai.com (new tab)
     │                          │                                (banner stays, user can dismiss later)
     │                          │
     │                          └── "Got it, don't show again" ──► Dismiss permanently
     │                                                               (POST /api/legacy-banner/dismiss)
     │
     └── Click ✕ ──► Dismiss permanently
                      (POST /api/legacy-banner/dismiss)
```

---

## Implementation

### Step 1: Import Legacy Emails into KV

Store the 2,313 legacy emails in the `APP_KV` namespace so they can be checked at login time without reading a file.

**Format:** One KV key per email.
- Key: `legacy_user:{normalized_email}` (lowercase, trimmed)
- Value: `"1"` (minimal — we only need existence check)

**Import script:** A one-time Node script (`scripts/import-legacy-emails.ts`) that:
1. Reads the CSV from a local path (passed as CLI arg)
2. Normalizes each email (lowercase, trim)
3. Appends hardcoded founder emails that are not in the CSV: `admin-one@example.com`, `admin-two@example.com`, `admin-three@example.com`
4. Deduplicates the combined list
5. Bulk-writes to `APP_KV` via Wrangler KV API (`wrangler kv key put` or the bulk API)

```bash
# Usage (run once per environment):
bun run scripts/import-legacy-emails.ts /path/to/emails.csv --env production
bun run scripts/import-legacy-emails.ts /path/to/emails.csv --env staging
```

**Why KV, not UserDO?** Not all legacy emails correspond to existing camelai.dev accounts. KV lets us check at auth-context time without requiring a UserDO lookup for users who may not exist yet.

### Step 2: Detect Legacy User in Auth Loader

In the `_app.tsx` loader, after `requireAuthContext()` succeeds, check whether the authenticated user's email is in the legacy set.

**Changes to `src/routes/_app.tsx` loader:**
1. Look up `legacy_user:{user.email}` in `APP_KV`
2. If found, check whether the user has already dismissed the banner (look up `legacy_banner_dismissed:{user.id}` in `APP_KV`)
3. Pass `showLegacyBanner: boolean` in the loader return data

```typescript
// Pseudocode for the loader addition:
const isLegacyUser = await context.cloudflare.env.APP_KV.get(`legacy_user:${authContext.user.email.toLowerCase()}`);
const hasDismissed = isLegacyUser
  ? await context.cloudflare.env.APP_KV.get(`legacy_banner_dismissed:${authContext.user.id}`)
  : null;
const showLegacyBanner = Boolean(isLegacyUser && !hasDismissed);
```

**Why KV for dismissal too?** Avoids adding a column to `UserDO`'s SQL schema for a temporary feature. KV is perfect for boolean flags that we'll eventually clean up.

**Performance note:** These are two KV `get` calls (~1-2ms each at edge). The second is conditional on the first. This adds negligible latency to the loader. Additionally, we should skip these lookups during `shouldRevalidate` skips (already handled — the loader simply won't re-run).

### Step 3: Dismiss API Route

**New file: `src/routes/api/legacy-banner.dismiss.ts`**

A simple POST endpoint that writes the dismissal flag to KV.

- Route path: `/api/legacy-banner/dismiss` (add to `src/routes.ts`)
- Auth: `requireAuthContext()` — must be logged in
- Action: `context.cloudflare.env.APP_KV.put(`legacy_banner_dismissed:${user.id}`, "1")`
- Response: `{ success: true }`

### Step 4: Banner Component

**New file: `src/components/legacy-user-banner.tsx`**

A self-contained component that handles collapsed/expanded state and dismiss.

**shadcn components used:**
- `Collapsible`, `CollapsibleTrigger`, `CollapsibleContent` — expand/collapse behavior
- `Button` — CTAs

**Lucide icons used:**
- `Hand` — waving hand in the card header
- `ChevronDown` / `ChevronUp` — expand indicator
- `X` — dismiss button
- `ArrowUpRight` — external link indicator on analytics CTA

**Component structure:**

```tsx
// Props
interface LegacyUserBannerProps {
  show: boolean;
}

export function LegacyUserBanner({ show }: LegacyUserBannerProps) {
  // If !show, render nothing
  // Local state: expanded (boolean), dismissed (boolean, for optimistic UI)
  // useFetcher() for POST to /api/legacy-banner/dismiss
  // On dismiss: set dismissed=true optimistically, fire fetcher.submit()

  return (
    <div className="fixed bottom-4 right-4 z-50 w-80">
      <Collapsible>
        <div className="bg-popover text-popover-foreground border border-border rounded-lg shadow-lg">
          {/* Header — always visible when not dismissed */}
          <div className="flex items-start gap-2 p-3">
            <CollapsibleTrigger className="flex-1 flex items-start gap-2 cursor-pointer text-left">
              <Hand className="size-4 mt-0.5 shrink-0" />
              <span className="text-sm font-medium">Things look different? Here's why</span>
              <ChevronDown className="size-4 mt-0.5 shrink-0 ml-auto" />
            </CollapsibleTrigger>
            <button onClick={handleDismiss} className="text-muted-foreground hover:text-foreground">
              <X className="size-4" />
            </button>
          </div>

          {/* Expanded detail */}
          <CollapsibleContent>
            <div className="px-3 pb-3 space-y-3 border-t border-border pt-3">
              <p className="text-sm text-muted-foreground">
                You're on camelAI.dev — the new camelAI. What started as an
                analytics tool has evolved into a full platform: a coding agent
                with a persistent computer that can build, deploy, and automate
                anything.
              </p>
              <p className="text-sm text-muted-foreground">
                Your existing dashboards and data connections are still live.
                Nothing is going away.
              </p>
              <div className="flex flex-col gap-2">
                <Button asChild className="w-full">
                  <a href="https://app.camelai.com" target="_blank" rel="noopener">
                    Take me to my analytics workspace
                    <ArrowUpRight className="size-4 ml-auto" />
                  </a>
                </Button>
                <Button variant="outline" className="w-full" onClick={handleDismiss}>
                  Got it, don't show again
                </Button>
              </div>
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>
    </div>
  );
}
```

**Styling guidelines:**
- Card container: `bg-popover text-popover-foreground border border-border rounded-lg shadow-lg` — matches existing popovers/dropdowns in the zinc theme
- Body text: `text-sm text-muted-foreground`
- Buttons: full-width, stacked vertically with `gap-2`
- Transition: `CollapsibleContent` handles open/close animation natively
- No warm/amber colors — everything uses the site's existing design tokens

### Step 5: Mount in Layout

**Changes to `src/routes/_app.tsx`:**

Pass `showLegacyBanner` from loader data to the layout component. Render the banner component anywhere inside the layout — since it uses `position: fixed`, placement in the JSX tree doesn't affect visual position. Placing it after `SidebarInset` keeps the layout tree clean.

```tsx
export default function AppLayout() {
  const { defaultSidebarOpen, showLegacyBanner } = useLoaderData<typeof loader>();

  return (
    <SidebarProvider defaultOpen={defaultSidebarOpen}>
      <AppSidebar />
      <SidebarInset className="h-svh overflow-hidden flex flex-col">
        <Outlet />
      </SidebarInset>
      <LegacyUserBanner show={showLegacyBanner} />
    </SidebarProvider>
  );
}
```

---

## Files Changed

| File | Change |
|------|--------|
| `scripts/import-legacy-emails.ts` | **New** — One-time KV import script |
| `src/routes/_app.tsx` | Add KV lookups in loader, pass `showLegacyBanner`, render `LegacyUserBanner` |
| `src/routes/api/legacy-banner.dismiss.ts` | **New** — POST endpoint to persist dismissal in KV |
| `src/routes.ts` | Add route entry for `/api/legacy-banner/dismiss` |
| `src/components/legacy-user-banner.tsx` | **New** — Banner component (collapsed bar + expanded detail) |

---

## Implementation Order

1. **Import script** — Write and run `scripts/import-legacy-emails.ts` to seed KV with legacy emails
2. **Dismiss route** — Create `api/legacy-banner.dismiss.ts` + add to `src/routes.ts`
3. **Banner component** — Build `legacy-user-banner.tsx` with Collapsible + Buttons
4. **Loader integration** — Add KV lookups to `_app.tsx` loader, pass flag, mount component
5. **Test** — Verify with a test email in KV, check dismiss persistence, check non-legacy users see nothing

---

## Not in Scope

- Sending emails to legacy users about the transition (separate initiative)
- Showing the banner to unauthenticated users on the login/signup page
- Migrating legacy user data into camelai.dev
- Removing the legacy emails from KV after the transition period (future cleanup task)
- Analytics/tracking of banner impressions or click-through rates
