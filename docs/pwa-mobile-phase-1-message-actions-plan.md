# PWA & Mobile — Phase 1: Message Actions Visible on Touch

> Phase 1 of 3. Phase 2 is `pwa-mobile-phase-2-pwa-polish-plan.md`. Phase 3 is `pwa-mobile-phase-3-larger-investments-plan.md`. **Each phase ships as its own PR.**

## Goal

The per-message **Copy** and **Fork** buttons in chat are completely invisible on phones. They're gated behind `hover:` and `focus-within:` opacity rules, neither of which fires on touch input. Make them visible on touch devices using a CSS-only solution (no JS, no hydration considerations) and bump the touch-target size while we're there.

## Background

### The bug

[src/components/message-bubble.tsx:562](src/components/message-bubble.tsx#L562) sets the default class string for the action row:

```ts
actionHoverClassName = "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
```

[src/components/Chat.tsx:1260-1263](src/components/Chat.tsx#L1260-L1263) overrides it for assistant turns:

```tsx
actionHoverClassName={
  messageGroup.isAssistantTurn
    ? "opacity-0 group-hover/turn:opacity-100 group-focus-within/turn:opacity-100"
    : undefined
}
```

On a phone:

- `hover:` — never fires (no hover-capable pointer).
- `focus-within:` — only fires if a focusable element inside the group receives keyboard focus. A tap on a markdown paragraph doesn't focus anything. The chat itself never gets focus.

Result: `opacity-0` wins forever. Users can't copy or fork on mobile.

### What's in the action row

[src/components/message-bubble.tsx:763-794](src/components/message-bubble.tsx#L763-L794) — **user message row:** timestamp + Copy button.

[src/components/message-bubble.tsx:816-860](src/components/message-bubble.tsx#L816-L860) — **assistant message row:** timestamp + (optional) Fork button + Copy button.

Both rows share the same `actionVisibilityClassName` derived at [line 624-627](src/components/message-bubble.tsx#L624-L627):

```ts
const actionVisibilityClassName = cn(
  "transition-opacity",
  actionHoverClassName,
);
```

## Design Decision

**Always show the action row on touch devices. Don't introduce a "more" overflow menu.**

Rationale:
- There are at most 2 buttons per message (Copy + Fork on assistant, Copy on user).
- An overflow menu would hide the affordance behind another tap and another guess.
- Always-visible avoids any tap-detection / long-press hacks that fight iOS text selection.
- If we ever grow to 4+ message-level actions, revisit with a `DropdownMenu`.

**Mechanism: Tailwind v4's `pointer-coarse:` variant.**

`pointer-coarse:` resolves to `@media (pointer: coarse)` — true for fingers, false for mice/trackpads/precision styluses. This is the right primitive for this question (not "small screen" — a desktop-class tablet with a finger should also see the actions; a stylus on the same tablet would not).

Tailwind v4 ships `pointer-coarse:`, `pointer-fine:`, `pointer-none:`, `any-pointer-coarse:`, `any-pointer-fine:`, and `any-pointer-none:` as built-in variants. No config addition needed. (If smoke-testing, see "QA Checklist" below.)

```
DESKTOP   (pointer: fine)              TOUCH   (pointer: coarse)
──────────────────────                ───────────────────────
┌────────────────────┐                ┌────────────────────┐
│ Assistant message… │                │ Assistant message… │
│                    │                │                    │
└────────────────────┘                └────────────────────┘
                                      ⏱ 12:34   [⑂]   [📋]
       ↑ row appears on hover ↑              ↑ always visible ↑
⏱ 12:34  [⑂] [📋]                              (and bigger tap targets)
```

## Implementation

Three small edits. **Two class strings + a per-button class addition.** No new components, no new hooks, no JSX restructuring.

### Edit 1: default `actionHoverClassName`

**File:** [src/components/message-bubble.tsx:562](src/components/message-bubble.tsx#L562)

**Before:**
```tsx
  actionHoverClassName = "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
```

**After:**
```tsx
  actionHoverClassName = "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100",
```

That's it for the default. Adding `pointer-coarse:opacity-100` *after* the base `opacity-0` lets the media-query variant win on touch devices through CSS specificity (Tailwind orders variants so media variants override the base utility when matched).

### Edit 2: assistant-turn override

**File:** [src/components/Chat.tsx:1260-1263](src/components/Chat.tsx#L1260-L1263)

**Before:**
```tsx
            actionHoverClassName={
              messageGroup.isAssistantTurn
                ? "opacity-0 group-hover/turn:opacity-100 group-focus-within/turn:opacity-100"
                : undefined
            }
```

**After:**
```tsx
            actionHoverClassName={
              messageGroup.isAssistantTurn
                ? "opacity-0 group-hover/turn:opacity-100 group-focus-within/turn:opacity-100 pointer-coarse:opacity-100"
                : undefined
            }
```

### Edit 3: bigger touch targets on the action buttons

The action buttons use `size="icon-sm"`. Per [src/components/ui/button.tsx:26](src/components/ui/button.tsx#L26), `icon-sm` resolves to:

```
size-6 [&_svg:not([class*='size-'])]:size-3
```

That's a **24×24 px button with a 12 px icon**. WCAG 2.2 SC 2.5.8 requires a 24×24 CSS-px minimum *with adequate spacing* — at `gap-0.5` (2 px) we're at the floor. Apple HIG asks for 44 pt. We need a meaningful bump on touch.

**Strategy:** keep the compile-time `size="icon-sm"` for desktop, override via className on touch. Override both the button box AND the SVG inside it (otherwise the icon stays 12 px in a 36 px button and looks lonely).

There are **three Button instances** to update across two action rows:

#### 3a. User-message Copy button — [src/components/message-bubble.tsx:778-792](src/components/message-bubble.tsx#L778-L792)

**Before:**
```tsx
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground"
                  onClick={() => onCopy(message.id, actionCopyContent ?? contentToString(cleanedContent))}
                >
                  {isCopied ? <Check /> : <Copy />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {isCopied ? 'Copied!' : 'Copy message'}
              </TooltipContent>
            </Tooltip>
```

**After:**
```tsx
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground pointer-coarse:size-9 pointer-coarse:[&_svg:not([class*='size-'])]:size-4"
                  onClick={() => onCopy(message.id, actionCopyContent ?? contentToString(cleanedContent))}
                >
                  {isCopied ? <Check /> : <Copy />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {isCopied ? 'Copied!' : 'Copy message'}
              </TooltipContent>
            </Tooltip>
```

#### 3b. Assistant-message Fork button — [src/components/message-bubble.tsx:826-842](src/components/message-bubble.tsx#L826-L842)

Add the same two `pointer-coarse:` classes to the Button's `className`:

**Before:**
```tsx
                className="text-muted-foreground"
```

**After:**
```tsx
                className="text-muted-foreground pointer-coarse:size-9 pointer-coarse:[&_svg:not([class*='size-'])]:size-4"
```

#### 3c. Assistant-message Copy button — [src/components/message-bubble.tsx:844-858](src/components/message-bubble.tsx#L844-L858)

Same change:

**Before:**
```tsx
                className="text-muted-foreground"
```

**After:**
```tsx
                className="text-muted-foreground pointer-coarse:size-9 pointer-coarse:[&_svg:not([class*='size-'])]:size-4"
```

### Edit 4: bump row gap on touch (tiny but worth it)

The row uses `gap-0.5` (2 px). When buttons are 36 px, 2 px between them feels glued together and gives no spacing buffer for adjacent-target accessibility.

**File:** [src/components/message-bubble.tsx:766](src/components/message-bubble.tsx#L766) (user row) **and** [src/components/message-bubble.tsx:819](src/components/message-bubble.tsx#L819) (assistant row).

Both currently say:
```tsx
            className={cn("flex items-center gap-0.5", actionVisibilityClassName)}
```

Change both to:
```tsx
            className={cn("flex items-center gap-0.5 pointer-coarse:gap-1", actionVisibilityClassName)}
```

`gap-1` = 4 px on touch. Modest, but honors 2.5.8 spacing guidance.

## What This Plan Does NOT Touch

- Does **not** introduce `useIsMobile()` for this change. CSS variant is strictly better — no hydration flash, no JS, correct on tablets/stylus, smaller bundle.
- Does **not** change the shadcn `Button` component itself. All overrides are at the call site.
- Does **not** add or remove buttons. Only changes visibility/sizing.
- Does **not** change desktop hover/focus behavior. Mouse-driven users see exactly the same UI as today.
- Does **not** touch `<Tooltip>` behavior. Tooltips on tap are mildly awkward but not broken; revisit in a follow-up if users complain.
- Does **not** introduce a long-press → context-menu pattern (iOS hijacks long-press for text selection on markdown content; reliable detection is a rabbit hole).
- Does **not** introduce a "more actions" overflow menu. Two buttons don't justify it.

## Files Touched

| File | Lines | Change |
|------|-------|--------|
| `src/components/message-bubble.tsx` | 562 | Add `pointer-coarse:opacity-100` to default `actionHoverClassName` |
| `src/components/message-bubble.tsx` | 766 | Add `pointer-coarse:gap-1` to user row container |
| `src/components/message-bubble.tsx` | 778-792 | Add `pointer-coarse:size-9 pointer-coarse:[&_svg:not([class*='size-'])]:size-4` to user Copy button |
| `src/components/message-bubble.tsx` | 819 | Add `pointer-coarse:gap-1` to assistant row container |
| `src/components/message-bubble.tsx` | 826-842 | Add same touch-size classes to Fork button |
| `src/components/message-bubble.tsx` | 844-858 | Add same touch-size classes to assistant Copy button |
| `src/components/Chat.tsx` | 1260-1263 | Add `pointer-coarse:opacity-100` to assistant-turn override |

**Total:** 2 files, ~7 line-level edits. CSS-only behavior change.

## QA Checklist

### Pre-implementation smoke test (Tailwind v4 sanity)

Before doing the real edits, drop this temporarily into any rendered page:

```tsx
<div className="size-10 bg-blue-500 pointer-coarse:bg-red-500" />
```

In Chrome DevTools, open **More Tools → Sensors**, set **Touch** to **Force enabled**, refresh. Square should be red. Toggle off → blue. If red doesn't appear, the variant isn't wired — investigate before proceeding (should not happen in stock Tailwind v4).

### Real-device QA

After the edits ship:

- [ ] **iOS Safari (iPhone, real device or BrowserStack):** open any chat with at least one assistant turn. Confirm:
  - [ ] Copy button visible under every user message, no hover/tap required.
  - [ ] Copy + Fork buttons visible under every finalized assistant message.
  - [ ] Buttons are noticeably larger (~36 px) than on desktop.
  - [ ] Tapping Copy shows the Check icon and toast.
  - [ ] Tapping Fork triggers the fork flow.
- [ ] **Chrome Android:** same checks.
- [ ] **Desktop Chrome (mouse):** action rows are hidden by default and appear on hover, exactly as today. Buttons are 24 px (not 36 px).
- [ ] **Desktop Chrome (DevTools touch emulation):** rows appear always-visible and buttons are 36 px.
- [ ] **iPad (Safari, finger):** rows always visible, 36 px (correct — iPad with finger is `pointer: coarse`).
- [ ] **iPad with Apple Pencil / external trackpad:** rows hidden until hover (correct — `pointer: fine`).
- [ ] **iPhone SE (320 px wide):** action row doesn't push the timestamp off-screen. If it does, follow-up: hide the timestamp on `pointer-coarse` via `pointer-coarse:hidden` on the `<span>` at lines 775 and 823.

### Tests

This is a CSS-only change. The existing test suite should continue to pass with no edits required. **Do not add a snapshot test** — snapshot churn for class-string updates costs more than it's worth.

If a developer wants a regression guard, the lightest option is a single Vitest test on `MessageBubble`:

```ts
it("includes pointer-coarse:opacity-100 on the action row by default", () => {
  const { container } = render(<MessageBubble {...minimalProps} />);
  const row = container.querySelector('[role="group"][aria-label="Message actions"]');
  expect(row?.className).toContain("pointer-coarse:opacity-100");
});
```

Skip if the message-bubble test setup doesn't already exist — manual QA on a real phone is the higher-signal verification for this change.

## Success Criteria

- A user on iOS Safari can copy any message and fork from any assistant message without a stylus, keyboard, or hidden gesture.
- Touch targets feel comfortable (subjective; verified by at least one real-device tap-test, ideally two thumbs on iPhone SE width).
- Desktop hover/focus behavior is bit-for-bit unchanged.
- No bundle-size or runtime-cost change (CSS-only).

## Open Questions for the Coding Agent

1. After landing, do tooltips on tap feel intrusive enough to remove on touch? If yes, follow-up: add `pointer-coarse:hidden` to the `<TooltipContent>` elements (or replace `<Tooltip>` with a no-op wrapper on touch). Defer the decision until after real-device feedback.
2. On iPhone SE width, does the assistant action row (timestamp + 2 buttons at 36 px + 4 px gap) wrap or push off-screen? If yes, hide the timestamp on touch (`pointer-coarse:hidden` on the timestamp `<span>`s at lines 775 and 823).
