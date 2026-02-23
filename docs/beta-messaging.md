# Beta Messaging Plan

## Status

February 20, 2026 — Draft v2

## Problem

camelAI is in early access beta. Users should know this so they calibrate expectations and feel invited to share feedback. Right now there's no visible beta indicator anywhere in the app. We want two lightweight, non-disruptive signals:

1. A **permanent, low-profile notice** on the welcome screen nudging users to share feedback
2. A **persistent BETA badge** in the sidebar so the beta status is always visible

---

## Design

### 1. Welcome Screen Beta Notice

A single line of small, muted text between the `WelcomeGreeting` and the `PromptInput`. No background, no border, no icon — just understated text that blends naturally into the greeting area.

**Full welcome screen layout (showing where the notice inserts):**

```
┌───────────────────────────────────────────────────────────────────┐
│                                                                   │
│                    Hey, Jane 👋                                   │  ← WelcomeGreeting
│                What would you like to build?                      │
│                                                                   │
│          You're in the early access beta. Things may              │
│          break — share feedback                                   │  ← NEW: BetaNotice
│                  ^^^^^^^^^^^^^^                                   │     (small muted text)
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

**Notice close-up:**

```
                                                        text-xs
                                                        text-muted-foreground
                                                        text-center
                                                         ↓
      You're in the early access beta. Things may break — share feedback
                                                          ^^^^^^^^^^^^^^
                                                          underlined, clickable
                                                          opens GetHelpDialog
```

#### Component: `BetaNotice`

**File:** `src/components/welcome-screen/beta-notice.tsx`

A minimal inline component. No shadcn Alert — just a `<p>` tag with small muted text.

**Structure:**

```tsx
<p className="text-center text-xs text-muted-foreground">
  You're in the early access beta. Things may break —{" "}
  <button
    onClick={onFeedbackClick}
    className="underline underline-offset-2 font-medium hover:text-foreground transition-colors"
  >
    share feedback
  </button>
</p>
```

**Styling rationale:**

- `text-xs` + `text-muted-foreground` — small and subdued, reads as secondary information
- `text-center` — centers below the greeting, which is also centered
- No background, no border, no padding — this is just a line of text, not a card or alert
- "share feedback" uses `underline` + `font-medium` + `hover:text-foreground` to indicate it's clickable without looking like a button
- No icon — keeps the notice as low-profile as possible

**Behavior:**

- **Not dismissible** — this notice is permanent for the duration of beta
- **"share feedback" click** → calls `onFeedbackClick` prop, which opens the `GetHelpDialog` with the category pre-selected to `"feature"`
- No localStorage, no state management — the component is purely presentational

**Props:**

```typescript
interface BetaNoticeProps {
  onFeedbackClick: () => void
}
```

---

### 2. GetHelpDialog Enhancement: `defaultCategory` Prop

The `GetHelpDialog` currently always resets category to `"bug"` when it opens (line ~122 in `get-help-dialog.tsx`). Add an optional `defaultCategory` prop so callers can pre-select a different category.

**File to modify:** `src/components/get-help-dialog.tsx`

**Change the interface:**

```typescript
// BEFORE
interface GetHelpDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

// AFTER
interface GetHelpDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultCategory?: HelpCategory  // NEW — optional, defaults to "bug" if omitted
}
```

**Change the reset effect** (the `useEffect` that runs when `open` changes):

```typescript
// BEFORE (in the useEffect body)
setCategory("bug")

// AFTER
setCategory(defaultCategory ?? "bug")
```

**Important: preserving existing behavior.** When `defaultCategory` is not passed (which is the case for the existing sidebar GetHelpDialog), `defaultCategory` is `undefined`, and `undefined ?? "bug"` evaluates to `"bug"`. This means zero behavioral change for existing callers. The sidebar's `<GetHelpDialog open={helpOpen} onOpenChange={setHelpOpen} />` continues to work identically — category resets to "bug" on open.

The `defaultValue` in the `useForm` config also references `"bug"` for the initial form state. This is fine because `useForm` only uses `defaultValue` for the initial render, and the `useEffect` runs immediately when `open` becomes `true`, overriding it. No changes to `useForm` are needed.

---

### 3. WelcomeScreen Integration

**File to modify:** `src/components/welcome-screen/index.tsx`

Add `helpOpen` state and render both the `BetaNotice` and the `GetHelpDialog`:

```typescript
const [helpOpen, setHelpOpen] = useState(false)
```

Insert the `BetaNotice` between `WelcomeGreeting` and the `AnimatedPlaceholder`/`PromptInput`. The existing layout has a `space-y-10` container, so the notice will get the same vertical rhythm:

```tsx
<div className="w-full max-w-5xl space-y-10">
  <WelcomeGreeting userName={userName} seed={referenceTime} />

  {/* NEW: Beta notice between greeting and prompt */}
  <BetaNotice onFeedbackClick={() => setHelpOpen(true)} />

  <AnimatedPlaceholder isActive={shouldAnimatePlaceholder}>
    {/* ...existing PromptInput... */}
  </AnimatedPlaceholder>

  {/* ...rest of existing sections unchanged... */}
</div>

{/* NEW: GetHelpDialog for the beta notice "share feedback" link */}
<GetHelpDialog
  open={helpOpen}
  onOpenChange={setHelpOpen}
  defaultCategory="feature"
/>
```

**Note on spacing:** The `space-y-10` (2.5rem gap) on the parent container may feel like too much space between the greeting and this small notice. If the visual gap feels excessive, the implementer should consider reducing it by adding a **negative top margin** on the `BetaNotice` wrapper, e.g. `-mt-6` to bring it closer to the greeting:

```tsx
<div className="-mt-6">
  <BetaNotice onFeedbackClick={() => setHelpOpen(true)} />
</div>
```

This pulls the notice up so it reads as a subtitle/tagline under the greeting rather than a separate section. The implementer should use their judgment here based on what looks best visually.

**Note on `defaultCategory="feature"`:** "Feature request" is the closest existing category to general feedback. We avoid adding a new "Feedback" category for a temporary beta feature — when beta ends, we remove the notice and the new prop without touching the help form's category list.

---

### 4. Sidebar BETA Badge

A `BETA` badge in the sidebar header, below the `WorkspaceSwitcher`. Left-aligned in expanded state, centered in collapsed state.

**Expanded sidebar:**

```
┌─────────────────────────┐
│  🐪 My Workspace        │
│     Acme Inc             │
│  ┌──────────────┐       │
│  │ Early Access  │       │  ← Badge, left-aligned below WorkspaceSwitcher
│  └──────────────┘       │
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
│ BETA │  ← Badge, centered in the narrow column
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

Import `Badge` and `useSidebar`, then add the badge below `WorkspaceSwitcher` in `SidebarHeader`.

```tsx
import { Badge } from "@/components/ui/badge"
import { useSidebar } from "@/components/ui/sidebar"

// Inside AppSidebar, alongside existing hooks:
const { state } = useSidebar()  // "expanded" | "collapsed"
```

Update the `SidebarHeader`:

```tsx
<SidebarHeader>
  <WorkspaceSwitcher />
  <div className={cn(
    "flex px-2",
    state === "expanded" ? "justify-start" : "justify-center"
  )}>
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
- In expanded state: shows "Early Access" (more descriptive when space allows), left-aligned via `justify-start`
- In collapsed state: shows "Beta" (shorter to fit the narrow icon column), centered via `justify-center`
- `px-2` on the wrapper provides consistent horizontal padding that matches sidebar menu item alignment
- The badge is **not** dismissible — it stays visible as long as the app is in beta

---

## Files to Create

| File | Purpose |
|------|---------|
| `src/components/welcome-screen/beta-notice.tsx` | Permanent beta notice for the welcome screen |

## Files to Modify

| File | Change |
|------|--------|
| `src/components/get-help-dialog.tsx` | Add optional `defaultCategory` prop; use it instead of hardcoded `"bug"` in the reset `useEffect` |
| `src/components/welcome-screen/index.tsx` | Add `helpOpen` state, render `BetaNotice` between greeting and prompt input, render `GetHelpDialog` with `defaultCategory="feature"` |
| `src/components/sidebar/app-sidebar.tsx` | Import `Badge` and `useSidebar`, add BETA badge below `WorkspaceSwitcher` in `SidebarHeader` |

## Components Used

| Component | Source | Where |
|-----------|--------|-------|
| `Badge` | `@/components/ui/badge` | Sidebar header |
| `GetHelpDialog` | `@/components/get-help-dialog` | WelcomeScreen (new instance) |
| `useSidebar` | `@/components/ui/sidebar` | AppSidebar (for collapsed/expanded state detection) |

No new component installations needed — `Badge` is already installed.

## Not in Scope

- Adding a new "Feedback" category to the help form (use "Feature request" for now)
- Beta messaging in emails or other non-app surfaces
- Any backend changes — this is entirely client-side
- Dismissal logic or localStorage — the notice is permanent
