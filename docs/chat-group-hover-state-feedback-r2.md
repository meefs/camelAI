# Chat Group Hover State Frontend Review Feedback — R2

Scope: frontend only. Backend findings live in [chat-group-hover-state-backend-feedback-r2.md](./chat-group-hover-state-backend-feedback-r2.md).

## Findings

### 1. Subheader text overflows the popover without ellipsis

**Severity:** High

User-reported regression visible in this round's screenshot: long latest-user-message snippets (in-progress rows) and long completion summaries (completed rows) extend past the popover's right edge and are hard-clipped without `…` truncation. Examples from the screenshot:

- "can you build me a screen saver? just an html file will suff" — clipped mid-word, no ellipsis.
- "Created a polished interactive particle screensaver with 11" — clipped, no ellipsis.
- "The project compiles perfectly into clea" — clipped, no ellipsis.

Titles are mostly fine because they sit inside a flex row with `flex-1 min-w-0 truncate`, which forces ellipsis once the flex math forces them below intrinsic width. Subheaders are plain block divs that inherit width from their parent — and the parent is wider than the popover.

**Root cause.** Radix `ScrollAreaPrimitive.Viewport` renders an internal wrapper div with inline `style="min-width: 100%; display: table"`. With `display: table`, that wrapper grows to its widest child instead of staying at the viewport width. Children (our `HoverRow` buttons, including the subheader divs inside them) take that wider width as their `width: 100%`. Per-line text then doesn't wrap, `truncate` / `line-clamp-2` see no overflow to trim, and the outer Viewport's `overflow-x-hidden` just visually clips the right side without producing `text-overflow: ellipsis`.

This is in [src/components/ui/scroll-area.tsx:13-40](../src/components/ui/scroll-area.tsx) (the default Viewport markup) and surfaces in [src/components/sidebar/chat-group-hover-card.tsx:71](../src/components/sidebar/chat-group-hover-card.tsx) where `ChatGroupHoverCard` mounts a `ScrollArea` inside the `w-[20rem]` popover.

**Recommended fix.** Override the inline `display: table` on the inner Radix wrapper from the outside. In [src/components/sidebar/chat-group-hover-card.tsx:71](../src/components/sidebar/chat-group-hover-card.tsx):

```tsx
// before
<ScrollArea className="max-h-[26rem]" viewportClassName="px-1 pb-2">

// after
<ScrollArea
  className="max-h-[26rem]"
  viewportClassName="px-1 pb-2 [&>div]:!block [&>div]:!w-full"
>
```

`[&>div]:!block` targets the Radix-rendered child div and replaces `display: table` with `display: block`. `!w-full` keeps it pinned to viewport width (the `min-width: 100%` inline style still applies but no longer expands). The `!` prefix is needed because the value is set as an inline style, which beats normal Tailwind class specificity.

Alternative: swap `ScrollArea` for a plain `<div className="max-h-[26rem] overflow-y-auto overflow-x-hidden px-1 pb-2">`. Same scroll behavior, no Radix gotcha, but loses the custom Radix scrollbar styling. Pick whichever the team prefers. The Tailwind override is the smaller change.

**Add a regression test** to [tests/chat-group-hover-card.test.tsx](../tests/chat-group-hover-card.test.tsx):

- Render `ChatGroupHoverCard` with a completed thread whose `last_assistant_summary` is a single long unbroken sentence (~400 chars, no markup).
- Assert the rendered summary `<div>` has computed `width` ≤ the popover content width (`getBoundingClientRect().width` ≤ 320 in jsdom; or use `getComputedStyle` on the wrapper and assert it is not `display: table`).
- Optionally snapshot the markup to lock in `[&>div]:!block` on the Viewport.

### 2. Completed-row loading state needs a layout-stable placeholder

**Severity:** High

Today, [src/components/sidebar/chat-group-hover-card.tsx:195-199](../src/components/sidebar/chat-group-hover-card.tsx) renders the subheader only when `last_assistant_summary` is truthy. So during the window between "agent finished" and "summary persisted", the row shows just the title row. When the summary then arrives (and during streaming as tokens land), the row pops taller. This is the layout jitter the user is asking us to fix.

This depends on the backend exposing a status field. The R2 backend review already calls for `last_assistant_summary_status: "pending" | "ready" | "failed" | null` on `ChatGroupThreadSummary` and through `hydrateChatGroups`. UI work should ship after — or atomically with — that backend change. Until the field is wired up, the UI can rely on `last_assistant_summary` presence alone and falls back to current behavior.

**Render contract (once the status field exists):**

| Status                                | Subheader render                                |
| ------------------------------------- | ----------------------------------------------- |
| `pending`, no text yet                | Shimmer skeleton in a 2-line reserved slot      |
| `pending` or `ready`, text present    | Real text, clamped to 2 lines (current pattern) |
| `ready`, no text                      | No subheader                                    |
| `failed`                              | No subheader                                    |
| Field absent (legacy / no summary)    | No subheader                                    |

**Why this set of decisions.**

- A `pending` row shows the skeleton, so the row's height matches its final state from the first frame.
- A `ready` row with no text and a `failed` row both collapse the subheader area. The user's earlier concern about "leaving it in the loading state indefinitely" is handled by treating `failed` as a terminal collapse state — no client-side timeout needed, the backend's terminal status is the signal.
- Streaming partial text replaces the skeleton on the first non-empty token. The skeleton is purely a placeholder; the moment we have any real characters, render them. This avoids a skeleton flicker on fast summaries and gives a streaming-text feel on slow ones.
- The skeleton renders at the same vertical footprint as a 2-line clamped summary, so there is no jitter between `pending → ready (2 lines)`. There is intentional shrinkage for `pending → ready (1 line)` and `pending → failed` — accepting a small downward reflow is better than holding empty space forever.

**Visual.** Two stacked shimmer bars using the existing `Skeleton` primitive ([src/components/ui/skeleton.tsx](../src/components/ui/skeleton.tsx) — `bg-muted rounded-md animate-pulse`). First bar full width; second bar ~60% width so it reads as the last line of a wrapped paragraph, not a perfect rectangle.

ASCII:

```
[ pending ]                                  [ ready, 2 lines ]

● Build an HTML Screen Saver   just now      ● Build an HTML Screen Saver   just now
████████████████████████████                 Created a polished interactive
█████████████                                particle screensaver with 11…
```

**Code.** Add a `last_assistant_summary_status?: "pending" | "ready" | "failed" | null` field to `ChatGroupThreadSummary` in [src/types.ts:44-58](../src/types.ts) (this lands with the backend change; mark optional so legacy data still types).

Refactor the completed-row subheader in [src/components/sidebar/chat-group-hover-card.tsx](../src/components/sidebar/chat-group-hover-card.tsx) into a small component:

```tsx
import { Skeleton } from "@/components/ui/skeleton";

function CompletedRowSubheader({ thread }: { thread: ChatGroupThreadSummary }) {
  const status = thread.last_assistant_summary_status ?? null;
  const text = thread.last_assistant_summary?.trim() ?? "";
  const hasText = text.length > 0;

  if (hasText) {
    return (
      <div className="line-clamp-2 text-xs leading-snug text-muted-foreground">
        {thread.last_assistant_summary}
      </div>
    );
  }
  if (status === "pending") {
    return (
      <div
        role="status"
        aria-label="Generating summary"
        className="flex min-h-[2.0625rem] flex-col justify-center gap-1.5"
      >
        <Skeleton className="h-2.5 w-full" />
        <Skeleton className="h-2.5 w-3/5" />
      </div>
    );
  }
  return null;
}
```

And replace the inline subheader block in `CompletedRow` ([chat-group-hover-card.tsx:195-199](../src/components/sidebar/chat-group-hover-card.tsx)):

```tsx
// before
{thread.last_assistant_summary && (
  <div className="line-clamp-2 text-xs leading-snug text-muted-foreground">
    {thread.last_assistant_summary}
  </div>
)}

// after
<CompletedRowSubheader thread={thread} />
```

Sizing notes:

- `min-h-[2.0625rem]` = 33px = 2 lines at `text-xs` (12px font) × `leading-snug` (1.375). This matches the exact rendered height of a fully-clamped real summary so the row does not change height when text replaces the skeleton.
- `h-2.5` (10px) bars sit visually inside each 16.5px line slot with a touch of breathing room.
- `gap-1.5` (6px) approximates the visual baseline gap between two text lines at `leading-snug`.
- Do not use `text-xs` font sizing on the skeleton container — it has no text, and `min-h-[2.0625rem]` already locks the height. Setting a text size there can cause subpixel rounding differences between the skeleton and the real text frame.

**Reduced-motion.** `Skeleton` uses `animate-pulse`. That respects `prefers-reduced-motion` via Tailwind's `motion-reduce:` modifier — confirm `animate-pulse` is paused under reduced motion (it is, by default in current Tailwind). If not, add `motion-reduce:animate-none` to the skeleton bars.

**Accessibility.** `role="status" aria-label="Generating summary"` lets a screen reader announce the pending state once per row, then announce the summary text when it lands. Do not add `aria-live` here — the popover is hover-only, so it's almost never focused, and a polite live region would be ignored anyway.

**Tests** in [tests/chat-group-hover-card.test.tsx](../tests/chat-group-hover-card.test.tsx):

- `pending` with no text → renders 2 skeleton bars; row contains the `role="status"` element.
- `pending` with streaming text → renders the text (clamped), no skeleton.
- `ready` with text → renders the text, no skeleton.
- `failed` with no text → renders neither skeleton nor subheader; row is shorter.
- Status absent (legacy) with text → renders text (unchanged behavior).
- Status absent with no text → renders no subheader (unchanged behavior).
- Snapshot that the `pending` row's total height equals the `ready (2-line text)` row's total height. (Use `getBoundingClientRect` on each `HoverRow`.)

## Verification

Run after both fixes:

```bash
bun run test:run -- tests/chat-group-hover-card.test.tsx tests/chat-groups-ui.test.tsx tests/chat-group-hover-time.test.ts
bun run typecheck
```
