# Beta Messaging

## Status

February 20, 2026 — Draft v1

## Problem

camelAI is in early access beta. Users should know this so they calibrate expectations and feel invited to share feedback. Right now there's no visible beta indicator anywhere in the app. We want two lightweight, non-disruptive signals:

1. A **dismissible notification** on the welcome screen nudging users to share feedback
2. A **persistent BETA badge** in the sidebar so the beta status is always visible

---

## Design

### 1. Welcome Screen Beta Banner

A subtle, dismissible inline banner sits between the `WelcomeGreeting` and the `PromptInput` on the new chat screen. It uses the existing shadcn `Alert` component for structure, styled to feel informational rather than alarming.

**Full welcome screen layout (showing where the banner inserts):**

```
┌───────────────────────────────────────────────────────────────────┐
│                                                                   │
│                    Hey, Jane 👋                                   │  ← WelcomeGreeting
│                What would you like to build?                      │
│                                                                   │
│   ┌───────────────────────────────────────────────────────────┐   │
│   │  🧪  You're in the early access beta. Things may          │   │
│   │      break — share feedback                          ✕    │   │  ← NEW: BetaBanner
│   │              ^^^^^^^^^^^^^^^^^^^^                         │   │     (clickable link)
│   └───────────────────────────────────────────────────────────┘   │
│                                                                   │
│   ┌───────────────────────────────────────────────────────────┐   │
│   │  Ask anything...                                          │   │  ← PromptInput
│   │                                                  [Submit] │   │
│   └───────────────────────────────────────────────────────────┘   │
│                                                                   │
│   Your recent chats                               View all →      │
│   ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐           │
│   │ Thread 1 │ │ Thread 2 │ │ Thread 3 │ │ Thread 4 │           │
│   └──────────┘ └──────────┘ └──────────┘ └──────────┘           │
│                                                                   │
│   ...rest of welcome screen...                                    │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

**Banner close-up:**

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   🧪  You're in the early access beta. Things may break —      │
│       share feedback                                        ✕   │
│       ^^^^^^^^^^^^^^^                                           │
│       underlined, clickable                                     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

#### Component: `BetaBanner`

**File:** `src/components/welcome-screen/beta-banner.tsx`

Uses the shadcn `Alert` component with a custom dismissible layout.

**Structure:**

```tsx
<Alert className="...">
  <FlaskConical className="size-4" />    {/* from lucide-react — science/beta feel */}
  <AlertDescription>
    You're in the early access beta. Things may break —{" "}
    <button onClick={onFeedbackClick} className="underline underline-offset-2 ...">
      share feedback
    </button>
  </AlertDescription>
  <AlertAction>
    <Button variant="ghost" size="icon" onClick={onDismiss}>
      <X className="size-3.5" />
    </Button>
  </AlertAction>
</Alert>
```

**Styling details:**

- Use the `default` Alert variant (card background with subtle border)
- `FlaskConical` icon from lucide-react — a science beaker that communicates "experimental/beta" without feeling negative
- "share feedback" is a `<button>` styled as an inline link: `underline underline-offset-2 font-medium hover:text-foreground text-muted-foreground transition-colors`
- Dismiss `X` button uses `AlertAction` slot (absolute-positioned top-right) with `Button variant="ghost" size="icon"` using the `size-3.5` X icon
- Overall banner gets subtle additional classes: `py-2.5` for comfortable but compact height

**Behavior:**

- **"share feedback" click** → calls `onFeedbackClick` prop, which opens the `GetHelpDialog` with the category pre-selected to `"feature"` (closest to general feedback among existing categories)
- **Dismiss (X click)** → sets `localStorage` key `betaBannerDismissed` to `"true"`, hides the banner via local state
- **On mount** → checks `localStorage` for `betaBannerDismissed`. If `"true"`, banner is not rendered
- The banner is not shown if dismissed. There is no expiry — once dismissed, it stays dismissed until we remove the beta banner code entirely

**Props:**

```typescript
interface BetaBannerProps {
  onFeedbackClick: () => void
}
```

The component manages its own dismissed state internally (reads/writes localStorage). If dismissed, it returns `null`.

---

### 2. GetHelpDialog Enhancement: `defaultCategory` Prop

The `GetHelpDialog` currently resets category to `"bug"` every time it opens. Add an optional `defaultCategory` prop so callers can pre-select a different category.

**File to modify:** `src/components/get-help-dialog.tsx`

**Change:**

```typescript
interface GetHelpDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultCategory?: HelpCategory  // NEW — defaults to "bug" if not provided
}
```

In the `useEffect` that runs when `open` changes (the reset effect), replace the hardcoded:

```typescript
setCategory("bug")
```

with:

```typescript
setCategory(defaultCategory ?? "bug")
```

No other changes to the dialog.

---

### 3. WelcomeScreen Integration

**File to modify:** `src/components/welcome-screen/index.tsx`

Add a `helpOpen` state and render both the `BetaBanner` and the `GetHelpDialog`:

```typescript
const [helpOpen, setHelpOpen] = useState(false)
```

Insert the `BetaBanner` between `WelcomeGreeting` and the `AnimatedPlaceholder`/`PromptInput`:

```tsx
<WelcomeGreeting userName={userName} />

<BetaBanner onFeedbackClick={() => setHelpOpen(true)} />

<AnimatedPlaceholder isActive={shouldAnimatePlaceholder}>
  {/* ...existing PromptInput... */}
</AnimatedPlaceholder>

{/* ...rest of sections... */}

<GetHelpDialog
  open={helpOpen}
  onOpenChange={setHelpOpen}
  defaultCategory="feature"
/>
```

Note: The `defaultCategory="feature"` ensures that when opened from the beta banner's "share feedback" link, the category dropdown is pre-set to "Feature request". This is the closest existing category to general feedback and avoids adding a new category for a temporary beta feature.

---

### 4. Sidebar BETA Badge

A `BETA` badge in the sidebar header, integrated into the `WorkspaceSwitcher` area. It should be visible in both expanded and collapsed states.

**Expanded sidebar:**

```
┌─────────────────────────┐
│  🐪 My Workspace        │
│     Acme Inc             │
│                    BETA  │  ← Badge in the header area, right-aligned
├─────────────────────────┤
│  ◈ New Chat              │
│  ◈ Computer              │
│  ◈ Chat History          │
│  ◈ Connections           │
│  ◈ Apps                  │
│                          │
│  ⓘ Get Help              │
│  👤 Jane Doe             │
└─────────────────────────┘
```

**Collapsed sidebar:**

```
┌──────┐
│  🐪  │
│ BETA │  ← Badge, compact, below the workspace avatar
├──────┤
│  ◈   │
│  ◈   │
│  ◈   │
│  ◈   │
│  ◈   │
│      │
│  ?   │
│  👤  │
└──────┘
```

#### Implementation

**File to modify:** `src/components/sidebar/app-sidebar.tsx`

Add the `Badge` component to the `SidebarHeader`, positioned below the `WorkspaceSwitcher`. Use the shadcn `Badge` with `variant="secondary"` and the sidebar's `useSidebar()` hook to detect collapsed state.

```tsx
import { Badge } from "@/components/ui/badge"
import { useSidebar } from "@/components/ui/sidebar"

// Inside AppSidebar:
const { state } = useSidebar()  // "expanded" | "collapsed"
```

Add a `Badge` element below `WorkspaceSwitcher` inside `SidebarHeader`:

```tsx
<SidebarHeader>
  <WorkspaceSwitcher />
  <div className="flex justify-center px-2">
    <Badge
      variant="secondary"
      className="text-[10px] tracking-wider font-semibold uppercase"
    >
      {state === "expanded" ? "Early Access" : "Beta"}
    </Badge>
  </div>
</SidebarHeader>
```

**Styling details:**

- `variant="secondary"` — muted background (`bg-secondary text-secondary-foreground`), doesn't compete with navigation items
- `text-[10px]` — small and tasteful, doesn't dominate the header
- `tracking-wider` + `uppercase` + `font-semibold` — gives it a proper tag/label feel
- In expanded state: shows "Early Access" (slightly more descriptive when space allows)
- In collapsed state: shows "Beta" (shorter to fit the narrow icon column)
- `flex justify-center px-2` wrapper centers the badge in both states
- The badge is **not** dismissible — it stays visible as long as the app is in beta

#### Why not in the WorkspaceSwitcher itself?

The `WorkspaceSwitcher` has a complex dropdown trigger layout with avatar, text, and chevron. Injecting a badge there would require fragile layout changes and could break the dropdown trigger's sizing. Placing it as a sibling element below the switcher in `SidebarHeader` is cleaner and easier to remove later.

---

## Files to Create

| File | Purpose |
|------|---------|
| `src/components/welcome-screen/beta-banner.tsx` | Dismissible beta notification banner for the welcome screen |

## Files to Modify

| File | Change |
|------|--------|
| `src/components/get-help-dialog.tsx` | Add optional `defaultCategory` prop; use it instead of hardcoded `"bug"` in reset effect |
| `src/components/welcome-screen/index.tsx` | Add `helpOpen` state, render `BetaBanner` between greeting and prompt input, render `GetHelpDialog` |
| `src/components/sidebar/app-sidebar.tsx` | Import `Badge` and `useSidebar`, add BETA badge below `WorkspaceSwitcher` in `SidebarHeader` |

## Components Used

| Component | Source | Where |
|-----------|--------|-------|
| `Alert`, `AlertDescription`, `AlertAction` | `@/components/ui/alert` | BetaBanner |
| `Badge` | `@/components/ui/badge` | Sidebar header |
| `Button` | `@/components/ui/button` | BetaBanner dismiss X |
| `FlaskConical`, `X` | `lucide-react` | BetaBanner |
| `GetHelpDialog` | `@/components/get-help-dialog` | WelcomeScreen |
| `useSidebar` | `@/components/ui/sidebar` | AppSidebar (for collapsed state detection) |

No new component installations needed — `Alert`, `Badge`, and `Button` are all already installed.

## Dismissal Persistence

| Key | Storage | Value | Purpose |
|-----|---------|-------|---------|
| `betaBannerDismissed` | `localStorage` | `"true"` | Hides the welcome screen beta banner permanently |

## Not in Scope

- Adding a new "Feedback" category to the help form (use "Feature request" for now)
- Beta messaging in emails or other non-app surfaces
- Expiry/reset of the dismissed state (banner stays dismissed)
- Any backend changes — this is entirely client-side
