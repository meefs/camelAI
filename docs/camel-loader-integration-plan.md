# CamelLoader Integration & In-Progress Indicator Refresh

## Problem

Today's chat loading states are functional but generic:
- The agent-working state in chat is three bouncing dots (`LoadingDots`) — visually indistinguishable from any other chat product.
- The chat tab and sidebar use a stock `Loader2` spinner.
- The "completed / awaiting your review" state is a tiny 6–8px red dot. It's easy to miss next to the spinner's visual weight, and red reads more like "error" than "ready for you."

A custom `CamelLoader` (animated camel-silhouette morph) is now packaged at `/Users/illiana/camel-loader/` and ready to drop in. This plan integrates it into the **primary chat surface** (where the camel actually has room to read), keeps the existing minimal indicators where the camel detail would blur, and refreshes the completed-state pip so it carries more visual weight and a friendlier semantic color.

---

## Design Summary

| Surface | Today (running) | Today (completed) | After |
|---|---|---|---|
| **Chat thread, agent working** | `LoadingDots` (3× bouncing 2px dots, 24px tall container) | n/a | **CamelLoader 24px + elapsed time** |
| **Top tab bar (active chat group)** | `Loader2` 14px blue spin in 16px slot | 8px red dot | **CamelLoader 16px**; completed pip bumped to 10px `bg-amber-500` |
| **Sidebar chat-group row** | `Loader2` 12px blue spin | 6px red dot | **CamelLoader 16px**; completed pip bumped to 8px `bg-amber-500` |
| **Sidebar collapsed-icon dot** | n/a (no running indicator in collapsed view) | 8px red dot | 10px `bg-amber-500` |
| **Sidebar hover card row** | 6px blue dot + timer | 6px red dot | Keep dot at 6px, recolor completed to `bg-amber-500` |
| **Todo list line item** | `Loader2` 16px blue spin | `CheckCircle2` 16px green | **Recolor running spinner to `text-foreground`** for consistency; keep icon shape (camel here would be overkill per user) |
| **Compacting indicator** | 6px blue pulse dot + text | n/a | No change |

### Where the camel goes — and where it doesn't

Per the user, the camel silhouette is legible down to **16px** (not the 32px the README quotes — that's the "luxurious detail" floor, not the "still recognizable" floor). That changes the calculus: all of our main chat-status surfaces have at least a 16px slot, so the camel can become the unified "agent is working" symbol across the product.

So:
- **Chat thread "agent is working" → CamelLoader 24px + elapsed time.** This is the spot the user spends the most time staring at while waiting. 24px matches the current `LoadingDots` container height (8px dots + `py-2`), so the chat layout vertical rhythm is preserved. The elapsed-time readout sits to the right as reassurance ("yes, the agent is still thinking").
- **Top tab bar (active chat group) → CamelLoader 16px.** The existing slot is already `size-4` (16px) and renders the model logo at 16px when idle, so this is a drop-in size match — no row-height change.
- **Sidebar chat-group row → CamelLoader 16px.** Bumps from a 12px spinner to a 16px camel. The row already has a flex layout with `gap-1.5`; the camel + count fit comfortably. Visual consistency with the tab bar.
- **Hover card row → stay with 6px dot.** Way below the 16px floor and visually correct as an inline status pip — a camel here would crowd the title text and timer.
- **Todo list line item → stay with `Loader2`.** User explicitly flagged that the camel would be overkill here. We **do** recolor the spinner to `text-foreground` so it harmonizes (no lingering blue while everywhere else is warm/neutral). See "Consistency" note below.
- **Compacting indicator → unchanged.** Semantically distinct ("conversation being compacted", not "agent thinking").

### Consistency: what happens to the leftover `Loader2`s

Once we swap the chat tab and sidebar group spinners for the camel, the **only** remaining `Loader2`-as-chat-status is in the todo list line item. Leaving it blue would make it the lone outlier in a product otherwise using warm neutral tones for in-progress. Recolor it to `text-foreground` so it reads as "intentionally neutral and in-progress" alongside the camel and green `CheckCircle2`. (Other `Loader2` usages — prompt input send button, voice recorder, etc. — are for *action-in-flight* states, not chat status, and stay as-is.)

### Why amber, not red, for completed

Red reads as *error* or *destructive*. The "completed / awaiting your review" state isn't either of those — it's a gentle "hey, look at me, I'm done." Amber (`bg-amber-500`) is the standard UI signal for *attention without alarm*: closer to a notification badge than a stop sign. It also pairs visually better with the warm camel silhouette than red does.

We bump the size from 6–8px to ~10px on the surfaces where it sits alone (tab strip, collapsed sidebar), and keep it at 6px in the hover card where it sits inline with text and a larger pip would feel chunky.

### A tiny "boing" on completion

When a chat finishes and the pip appears, it does a very short overshoot scale-in:
`scale 0 → 1.15 → 1` over ~220ms with an ease-out curve. Just enough to catch the eye as a one-shot "ding!" without being noisy. Fires once on mount (the pip's mount IS the moment of completion, since it replaces a running indicator). Wrapped in `motion-safe:` so reduced-motion users get the pip statically.

If it feels gimmicky in practice, delete the one class — no other code change needed.

---

## ASCII Designs

### Chat thread — agent working (the primary CamelLoader surface)

Before:
```
┌──────────────────────────────────────────────┐
│  ● ● ●                                       │
│  (3× 8px bouncing dots, ~24px tall container)│
└──────────────────────────────────────────────┘
```

After:
```
┌──────────────────────────────────────────────┐
│   ╭──╮                                       │
│   │🐪│  3m 24s                               │
│   ╰──╯  (text-sm, text-muted-foreground)     │
│   24px                                       │
│   (morphs camel → flower → J → hourglass → starburst → camel) │
└──────────────────────────────────────────────┘
```

Layout: `flex items-center gap-3 py-2 text-muted-foreground`. The camel sits left, elapsed time to its right, vertically centered. The whole block replaces the current `<LoadingDots />` slot in [chat-messages-view.tsx:241-245](src/components/chat-messages-view.tsx#L241-L245). 24px matches the LoadingDots container height (8px dot + `py-2`), so the chat layout's vertical rhythm is preserved.

The timer reads `12s` → `3m 24s` → `1h 05m` using the existing `formatRunningElapsed()` helper at [chat-group-hover-time.ts:21-35](src/lib/chat-group-hover-time.ts#L21-L35). The timer ticks every 1s via `setInterval` (same pattern as `RunningTimerSlot` in the hover card).

### Top tab bar (active chat group) — running vs. completed

Before:
```
┌─────────────────────────────────────────────┐
│  ◐ Analysis chat                 ↻ 🔵       │   running  (14px blue Loader2 in 16px slot)
├─────────────────────────────────────────────┤
│  ◐ Analysis chat                  ●         │   completed (8px red dot)
└─────────────────────────────────────────────┘
```

After:
```
┌─────────────────────────────────────────────┐
│  ◐ Analysis chat                 🐪         │   running  (16px CamelLoader, matches existing 16px ModelLogo slot)
├─────────────────────────────────────────────┤
│  ◐ Analysis chat                 ⬤         │   completed (10px bg-amber-500, boing on mount)
└─────────────────────────────────────────────┘
```

The right slot is already `<span className="grid size-4 shrink-0 place-items-center">` (16px) per [chat-tab-bar.tsx:337-342](src/components/chat-tab-bar.tsx#L337-L342) — no row-height change.

### Sidebar chat-group row — running vs. completed

Before:
```
┌─────────────────────────────────────────┐
│  ▸ Analysis group       ↻ 🔵  3         │   running  (12px blue Loader2 + count)
├─────────────────────────────────────────┤
│  ▸ Analysis group        ●   3          │   completed (6px red dot + count)
└─────────────────────────────────────────┘
```

After:
```
┌─────────────────────────────────────────┐
│  ▸ Analysis group       🐪   3          │   running  (16px CamelLoader + count)
├─────────────────────────────────────────┤
│  ▸ Analysis group       ⬤   3           │   completed (8px bg-amber-500 + count, boing on mount)
└─────────────────────────────────────────┘
```

The row is `ml-auto flex shrink-0 items-center gap-1.5`. Bumping the indicator from 12px → 16px adds 4px of width to the inline group — fine inside the existing flex layout.

### Sidebar hover card row — minor recolor only

Before:
```
🔵 Analysis chat                       3m 24s     <- running, 6px blue dot
●  Other chat                          12m ago    <- completed, 6px red dot
```

After:
```
🔵 Analysis chat                       3m 24s     <- running, 6px blue dot (unchanged)
🟡 Other chat                          12m ago    <- completed, 6px amber dot
```

---

## Implementation

### Step 1 — Drop the CamelLoader package into the repo

Copy `/Users/illiana/camel-loader/CamelLoader.tsx` and `/Users/illiana/camel-loader/flubber.d.ts` into the repo:

```
src/components/camel-loader/
├── camel-loader.tsx     (renamed from CamelLoader.tsx — matches repo kebab-case)
└── flubber.d.ts
```

- Rename the file to `camel-loader.tsx` to match the codebase's kebab-case convention (everything else under `src/components/` is kebab-case).
- The exported component stays `CamelLoader` (PascalCase named export, as in the package).
- `flubber.d.ts` can sit beside `camel-loader.tsx`; TypeScript picks up `.d.ts` files anywhere under `src/`. No `tsconfig.json` edit needed.

Install the runtime dep:
```bash
bun add flubber
```

The component is SSR-safe (initial render is the static camel) and dynamic-imports flubber, so it stays out of the React Router server bundle. No further build config required.

Verify by running `bun run typecheck` and `bun run build`.

### Step 2 — Replace `LoadingDots` with `CamelLoader` + elapsed time in the chat thread

**File:** [src/components/chat-messages-view.tsx:241-245](src/components/chat-messages-view.tsx#L241-L245)

Currently:
```tsx
{showGlobalAssistantIndicator && !isCompacting && (
  <div ref={assistantPendingMeasureRef}>
    <LoadingDots />
  </div>
)}
```

Replace with a new component, `ChatThreadWorkingIndicator`, that wraps `CamelLoader` plus an elapsed-time readout:

```tsx
{showGlobalAssistantIndicator && !isCompacting && (
  <div ref={assistantPendingMeasureRef}>
    <ChatThreadWorkingIndicator startedAt={runningStartedAt} />
  </div>
)}
```

**New component:** `src/components/chat-thread-working-indicator.tsx`

```tsx
import { useEffect, useState } from "react";
import { CamelLoader } from "@/components/camel-loader/camel-loader";
import { formatRunningElapsed } from "@/lib/chat-group-hover-time";

interface Props {
  /** Unix ms timestamp the current agent turn started, or null if unknown. */
  startedAt: number | null;
}

export function ChatThreadWorkingIndicator({ startedAt }: Props) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (startedAt === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);

  return (
    <div
      className="flex items-center gap-3 py-2 text-muted-foreground"
      role="status"
      aria-label="Agent is working"
    >
      <CamelLoader size={24} ariaLabel="Agent is working" />
      {startedAt !== null && (
        <span className="text-sm tabular-nums">
          {formatRunningElapsed(startedAt, now)}
        </span>
      )}
    </div>
  );
}
```

Notes:
- `CamelLoader` paints with `currentColor`, so wrapping it in `text-muted-foreground` gives the silhouette the same muted gray feel as the old dots. If we want stronger brand presence, swap to `text-foreground`. Recommend starting with `text-muted-foreground` — easier to dial up than down.
- 24px matches the current `LoadingDots` container height (8px dot + `py-2`), keeping the chat layout's vertical rhythm. If it reads too small in practice, bump to 28–32px (still well under "hero" sizes).
- The elapsed time is suppressed when `startedAt` is `null` (the loader still shows). That covers the brief window before the start timestamp lands.

### Step 3 — Plumb `runningStartedAt` from chat-groups state into `Chat.tsx`

The chat view doesn't currently track when the current turn started; only the sidebar does, via `ChatGroupThreadSummary.running_started_at` in [use-chat-groups.tsx](src/hooks/use-chat-groups.tsx). We want a single source of truth, so read from there.

**File:** [src/components/Chat.tsx](src/components/Chat.tsx)

Around line 800 (where `assistantTurnActive` is derived), add a lookup for the current thread's `running_started_at`. The exact shape depends on what hooks/contexts `Chat.tsx` already has — coding agent: pick the cleanest of these in order:

1. **Preferred:** if `Chat.tsx` (or a parent provider) already calls `useChatGroups()` or has access to the chat-group store, pull `running_started_at` for the current `threadId` from there. This is the same value `ChatGroupHoverCard` displays — guaranteed consistent with the sidebar.
2. **Fallback:** add a small `useTurnStartedAt(assistantTurnActive)` local hook that captures `Date.now()` on the false→true transition of `assistantTurnActive` and resets on true→false. This is a *fallback* — it drifts from the server-truth value on a refresh mid-turn, so prefer #1.

Then pass `runningStartedAt` down through `ChatMessagesView` props:

**File:** [src/components/chat-messages-view.tsx:36-64](src/components/chat-messages-view.tsx#L36-L64)

Add `runningStartedAt: number | null;` to `ChatMessagesViewProps`, destructure it in the component, and pass it to `<ChatThreadWorkingIndicator startedAt={runningStartedAt} />`.

**File:** [src/components/Chat.tsx:4441-4451](src/components/Chat.tsx#L4441-L4451)

Pass the new prop on the `<ChatMessagesView />` render.

Remove the now-unused `LoadingDots` import from `chat-messages-view.tsx` (it's only used for the global indicator). Quick grep first to confirm — `LoadingDots` is also used in `message-bubble.tsx:851` for the per-message streaming indicator and **stays there unchanged** (it's a different, even smaller use case: inline with streaming text, doesn't need branding).

### Step 4 — Replace the top tab bar's spinner with `CamelLoader`, bump completed pip

**File:** [src/components/chat-tab-bar.tsx:91-115](src/components/chat-tab-bar.tsx#L91-L115)

Current `TabRightSlot`:
```tsx
if (status === "running") {
  return (
    <Loader2
      className="size-3.5 animate-spin text-blue-500 motion-reduce:animate-none"
      ...
    />
  );
}
if (status === "unread") {
  return (
    <span
      ...
      className="size-2 rounded-full bg-red-500"
    />
  );
}
```

Change to:
```tsx
if (status === "running") {
  return (
    <span className="text-muted-foreground" aria-label="Agent is working">
      <CamelLoader size={16} ariaLabel="Agent is working" />
    </span>
  );
}
if (status === "unread") {
  return (
    <span
      aria-label="Awaiting your review"
      className="size-2.5 rounded-full bg-amber-500 motion-safe:animate-pip-boing"
    />
  );
}
```

Notes:
- The slot container at line ~337 is `grid size-4 place-items-center` (16px), which is exactly the camel's size — drop-in fit, no row-height change.
- Wrap the camel in a `<span>` with `text-muted-foreground` so the silhouette inherits the muted color via `currentColor`. (Or use `text-foreground` if it reads too washed-out on the tab background — try muted first.)
- Completed pip: `size-2 bg-red-500` → `size-2.5 bg-amber-500`. `motion-safe:animate-pip-boing` triggers the one-shot scale-overshoot animation on mount; see Step 7 for the keyframe definition. Drop the class to remove the animation if it feels gimmicky.

### Step 5 — Replace the sidebar chat-group spinner with `CamelLoader`, bump completed pip

**File:** [src/components/sidebar/chat-groups-list.tsx:72-100](src/components/sidebar/chat-groups-list.tsx#L72-L100)

In `ChatGroupRightSlot`:
```tsx
{status === "running" ? (
  <span className="text-muted-foreground" aria-label="Agent is working">
    <CamelLoader size={16} ariaLabel="Agent is working" />
  </span>
) : status === "unread" ? (
  <span
    aria-label="Awaiting your review"
    className="size-2 rounded-full bg-amber-500 motion-safe:animate-pip-boing"
  />
) : null}
```

Changes: replace `<Loader2 size-3 ...>` with the 16px camel; completed dot `size-1.5 bg-red-500` → `size-2 bg-amber-500 motion-safe:animate-pip-boing`.

**File:** [src/components/sidebar/chat-groups-list.tsx:112-118](src/components/sidebar/chat-groups-list.tsx#L112-L118)

Collapsed-icon completed dot: `size-2 bg-red-500` → `size-2.5 bg-amber-500 motion-safe:animate-pip-boing`.

### Step 6 — Refresh the hover card completed dot (color only)

**File:** [src/components/sidebar/chat-group-hover-card.tsx:267-282](src/components/sidebar/chat-group-hover-card.tsx#L267-L282)

In the inline `StatusDot` component, change the completed branch:
```tsx
className="size-1.5 shrink-0 rounded-full bg-amber-500 motion-safe:animate-pip-boing"
```
(was `bg-red-500`). Size stays 6px — the dot sits inline with text and a bigger pip would feel chunky. Apply the boing here too for consistency.

The running branch stays `bg-blue-500` — it pairs with the `RunningTimerSlot` text and reads as the active/positive state.

### Step 7 — Define the `pip-boing` keyframe + recolor todo spinner

**File:** [src/styles/globals.css](src/styles/globals.css)

Add the keyframe and a utility class. The repo uses `tw-animate-css`, but its `zoom-in` doesn't overshoot — we want a tight "boing." Add at the bottom of the file:

```css
@keyframes pip-boing {
  0%   { transform: scale(0);    }
  60%  { transform: scale(1.15); }
  100% { transform: scale(1);    }
}

@utility animate-pip-boing {
  animation: pip-boing 220ms cubic-bezier(0.34, 1.56, 0.64, 1) both;
}
```

(If the repo's Tailwind v4 config uses a different mechanism for custom utilities, the coding agent should match that pattern — the goal is a `.animate-pip-boing` utility class that runs the keyframe once.)

The `motion-safe:` prefix on each use site means reduced-motion users get the pip statically — no animation.

**File:** [src/components/floating-todo/todo-status-icon.tsx:20-24](src/components/floating-todo/todo-status-icon.tsx#L20-L24)

Recolor the in-progress spinner for cross-product consistency:
```tsx
case 'in_progress':
  return (
    <Loader2
      className={cn("h-4 w-4 text-foreground animate-spin", className)}
    />
  );
```

(Was `text-blue-500`.) Now the only colored chat-status icon left is the green completed checkmark, which is intentional — green = done is a strong, well-understood signal.

---

## Files Touched

**New:**
- `src/components/camel-loader/camel-loader.tsx` (copied + renamed from package)
- `src/components/camel-loader/flubber.d.ts` (copied from package)
- `src/components/chat-thread-working-indicator.tsx`

**Modified:**
- `package.json` (add `flubber`)
- `src/styles/globals.css` (add `@keyframes pip-boing` + `.animate-pip-boing` utility)
- `src/components/chat-messages-view.tsx` (swap `LoadingDots` for new indicator, add `runningStartedAt` prop)
- `src/components/Chat.tsx` (wire `runningStartedAt` for current thread, pass through)
- `src/components/chat-tab-bar.tsx` (`TabRightSlot`: `Loader2` → `CamelLoader 16px`, completed pip color/size/boing)
- `src/components/sidebar/chat-groups-list.tsx` (`ChatGroupRightSlot`: `Loader2` → `CamelLoader 16px`, completed pip color/size/boing; collapsed-icon color/size/boing)
- `src/components/sidebar/chat-group-hover-card.tsx` (`StatusDot` completed color + boing)
- `src/components/floating-todo/todo-status-icon.tsx` (in-progress spinner recolor `text-blue-500` → `text-foreground`)

**Untouched (intentional):**
- `src/components/loading-dots.tsx` — still used by `message-bubble.tsx:851` for the per-message streaming indicator (smaller and more frequent than the global indicator; LoadingDots is fine there).
- `src/components/compacting-indicator.tsx` — semantically distinct ("conversation being compacted", not "agent thinking"); keep its pulse-dot.

---

## Edge Cases & Notes

- **`runningStartedAt === null`**: the loader renders without a timer. Don't render `—` or `0s` — just omit. This covers the brief window between turn-start and the start timestamp arriving from server.
- **`prefers-reduced-motion`**: `CamelLoader` already honors this and renders the static camel without RAF. Nothing extra needed.
- **Bundle**: `flubber` is ~5KB gzipped, dynamic-imported by `CamelLoader`, so it only ships when the loader renders client-side. Won't bloat the SSR bundle or the initial JS payload.
- **Color theming**: `CamelLoader` paints with `currentColor`. The plan wraps it in `text-muted-foreground` to start. Worth eyeballing in both light and dark mode before merge — if the camel reads too washed-out in light mode, bump to `text-foreground`.
- **Tab/sidebar color contrast**: the running spinner moves from `text-blue-500` to `text-foreground`. In dark mode this becomes near-white, which has high contrast against the dark sidebar. In light mode it becomes near-black. Check both. If `text-foreground` reads too heavy, fall back to `text-muted-foreground`.
- **No semantic change**: `ThreadStatus` (`"idle" | "running" | "unread"`) and the underlying data model are untouched. This is a purely presentational refresh.

---

## Testing

- `bun run typecheck` and `bun run lint` after changes.
- `bun run test:run` — should be no test churn; if any tests snapshot the chat indicator markup, update them.
- Manual:
  1. Start an agent turn in chat → verify CamelLoader appears at 24px with timer ticking from `0s`.
  2. Wait long enough that the timer crosses `60s` and `1m 00s` formatting kicks in.
  3. Refresh mid-turn → verify the timer resumes from the correct elapsed value (this is the test that confirms `runningStartedAt` is wired from server-truth, not local state).
  4. Open the top tab bar with a running thread → verify the 16px camel renders in place of the spinner and the tab row height hasn't changed.
  5. Sidebar with a running chat group → verify the 16px camel renders + count stays aligned.
  6. Let an agent finish in a background tab → verify the completed pip is amber, noticeably bigger than before, and does the one-shot boing on appear.
  7. Open the floating todo list with an in-progress task → verify the spinner is now `text-foreground` (not blue) and harmonizes with the rest.
  8. Toggle `prefers-reduced-motion` (devtools → Rendering → Emulate CSS media feature) → verify the camel renders static AND the pip boing is suppressed (pip appears statically).
  9. Sidebar in collapsed mode → verify the larger amber dot still fits in the icon slot.
  10. Dark mode + light mode pass on all surfaces.

---

## Open Questions for Review

1. **Completed pip color** — `bg-amber-500` (yellow-leaning) vs. `bg-amber-600` (more orange). 500 is brighter and reads better against dark mode; 600 has more pop against light mode. Pick after eyeballing both.
2. **Boing tuning** — current spec is `scale 0 → 1.15 → 1` over 220ms with overshoot easing. If 1.15 reads as too bouncy, drop to 1.1; if 220ms feels sluggish, drop to 180ms. Easy to iterate on.

(Resolved during planning: camel color → `text-muted-foreground`; chat-thread camel size → 24px; boing is in-scope.)
