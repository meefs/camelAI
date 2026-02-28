# Chat Streaming Fix & User Message Overflow

**February 28, 2026 — v2**

---

## Overview

Two improvements to the chat message experience:

1. **Fix chat action flickering during streaming** — Actions (timestamp, copy button) on assistant messages are currently removed from the DOM during streaming and flash in when streaming ends, causing a layout shift. Fix: always keep them in the DOM.
2. **Max height on user messages** — Long user messages should collapse with a gradient fade and "Show more" button.

---

## Part 1: Fix Chat Action Flickering

### Problem

Assistant message actions (timestamp + copy button) are conditionally rendered with `{!isStreaming && hasContent && (...)}` in `message-bubble.tsx:652`. During streaming, the action row is completely absent from the DOM. When streaming ends and `isStreaming` flips to `false`, the row is inserted into the DOM, causing a visible layout shift — the message content jumps as the action row pushes it up.

```
During streaming:                    After streaming ends:
┌─────────────────────────────┐     ┌─────────────────────────────┐
│ Thinking...                 │     │ Thinking...                 │
│ Here is the code I wrote... │     │ Here is the code I wrote... │
│ ● Read src/index.ts         │     │ ● Read src/index.ts         │
│ ● Edit src/index.ts         │     │ ● Edit src/index.ts         │
│ ···                         │     │ 12:25 PM  [⎘]              │ ← flickers in
└─────────────────────────────┘     └─────────────────────────────┘
                                        ↑ layout shift
```

### Design

Remove the `!isStreaming` guard. The actions are already `opacity-0` by default and only appear on `group-hover:opacity-100` (the parent wrapper in `Chat.tsx:570` has the `group` class). Removing the guard means the row is always in the DOM but invisible — no layout shift when streaming ends. If the user hovers during streaming, they'll see timestamp and copy — which is fine UX.

```
During streaming (hovered):         After streaming (hovered):
┌─────────────────────────────┐     ┌─────────────────────────────┐
│ ● Edit src/index.ts         │     │ ● Edit src/index.ts         │
│ ···                         │     │ Done! Let me know if...     │
│ 12:25 PM  [⎘]              │     │ 12:25 PM  [⎘]              │
└─────────────────────────────┘     └─────────────────────────────┘
   ↑ always in DOM, visible           ↑ no layout shift
     on hover
```

### Implementation

**File: `src/components/message-bubble.tsx`**

Line 652 — remove the `!isStreaming` condition:

```tsx
// BEFORE (line 652)
{!isStreaming && hasContent && (
  <div
    className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
    ...
  >

// AFTER
{hasContent && (
  <div
    className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
    ...
  >
```

Also update the comment on line 651 from `{/* Hover action row - only show when not streaming */}` to `{/* Hover action row */}` to match the user message action row comment style.

That's the entire change. The opacity classes handle visibility. No new components, no new CSS.

### Files to modify

| File | Change |
|------|--------|
| `src/components/message-bubble.tsx` | Remove `!isStreaming &&` guard on assistant action row (line 652), update comment (line 651) |

### Verification

- Send a message, watch assistant stream response — actions should not flicker/jump at end of stream
- Hover during streaming — timestamp and copy button appear smoothly
- After streaming ends — same hover behavior as before, no layout shift
- Copy button works correctly during streaming (copies whatever content exists so far)

---

## Part 2: Max Height on User Messages with "Show More"

### Problem

Users can paste very long messages (code blocks, stack traces, data dumps). These render at full height inside the `max-w-[85%] rounded-3xl border bg-muted/30` bubble, pushing the assistant's response far below the viewport.

```
Current (long user message):
┌──────────────────────────────────────────┐
│                                          │
│    ┌──────────────────────────────────┐  │
│    │ Can you fix this error?          │  │
│    │                                  │  │
│    │ Error: Cannot find module...     │  │
│    │   at Module._resolveFilename     │  │
│    │   at Module._load                │  │
│    │   at Module.require              │  │
│    │   at require (internal/module... │  │
│    │   ... (50 more lines)            │  │
│    │   at process._tickCallback       │  │
│    │                                  │  │
│    │ Here is the full file:           │  │
│    │ ```                              │  │
│    │ import express from 'express'    │  │
│    │ ... (200 lines of code)          │  │
│    │ ```                              │  │
│    └──────────────────────────────────┘  │
│                                          │
│ (assistant response way below fold)      │
│                                          │
└──────────────────────────────────────────┘
```

### Design

Collapse long user messages to a max height with a gradient fade overlay and a "Show more" button. The gradient fades from transparent to the bubble's background, creating a natural text fade-out. The button sits centered at the bottom of the gradient.

```
Collapsed (default for long messages):
┌──────────────────────────────────────────┐
│                                          │
│    ┌──────────────────────────────────┐  │
│    │ Can you fix this error?          │  │
│    │                                  │  │
│    │ Error: Cannot find module...     │  │
│    │   at Module._resolveFilename     │  │
│    │   at Module._load                │  │
│    │   at Module.require              │  │
│    │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │  │
│    │ ░░░░░░░░░ Show more ▾ ░░░░░░░░░ │  │
│    └──────────────────────────────────┘  │
│                                          │
│ Thinking...                              │
│ Here's the fix for your module error...  │
│                                          │
└──────────────────────────────────────────┘

Expanded (after clicking "Show more"):
┌──────────────────────────────────────────┐
│                                          │
│    ┌──────────────────────────────────┐  │
│    │ Can you fix this error?          │  │
│    │                                  │  │
│    │ Error: Cannot find module...     │  │
│    │   at Module._resolveFilename     │  │
│    │   at Module._load                │  │
│    │   at Module.require              │  │
│    │   at require (internal/module... │  │
│    │   ... (all lines visible)        │  │
│    │   at process._tickCallback       │  │
│    │                                  │  │
│    │ Here is the full file:           │  │
│    │ ```                              │  │
│    │ import express from 'express'    │  │
│    │ ... (full code visible)          │  │
│    │ ```                              │  │
│    │                     Show less ▴  │  │
│    └──────────────────────────────────┘  │
│                                          │
└──────────────────────────────────────────┘
```

#### Gradient overlay detail

The gradient sits inside the bubble (positioned absolutely within it). It fades from transparent at the top to the bubble's effective background at the bottom. The bubble uses `bg-muted/30` on a page with a `background` color, so the gradient bottom color should match `muted` at sufficient opacity to fully obscure the text underneath.

```
┌──────────────────────────────────────┐
│ Message text visible...              │
│ More text visible here...            │
│ ╔════════════════════════════════════╗ ← gradient starts (transparent)
│ ║  text fading out gradually...     ║
│ ║▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓║ ← gradient mid (semi-opaque)
│ ║▓▓▓▓▓▓▓▓▓ Show more ▾ ▓▓▓▓▓▓▓▓▓▓▓║ ← button centered on gradient
│ ╚════════════════════════════════════╝ ← gradient end (fully opaque)
└──────────────────────────────────────┘
```

### Implementation

Create a `CollapsibleContent` wrapper component (named `CollapsibleUserMessage` to avoid conflict with the shadcn `CollapsibleContent` already imported in this codebase).

**Constants:**
- `MAX_COLLAPSED_HEIGHT = 300` (px) — roughly 12-14 lines of text

#### Step 1 — Create `CollapsibleUserMessage` component

**New file: `src/components/collapsible-user-message.tsx`**

```tsx
'use client';

import { useState, useRef, useLayoutEffect } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

const MAX_COLLAPSED_HEIGHT = 300;

interface CollapsibleUserMessageProps {
  children: ReactNode;
}

export function CollapsibleUserMessage({ children }: CollapsibleUserMessageProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;

    const check = () => {
      setIsOverflowing(el.scrollHeight > MAX_COLLAPSED_HEIGHT);
    };
    check();

    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const handleCollapse = () => {
    setIsExpanded(false);
    // Scroll the message back into view after collapsing
    requestAnimationFrame(() => {
      contentRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  };

  return (
    <div className="relative">
      <div
        ref={contentRef}
        className={cn(
          !isExpanded && isOverflowing && 'overflow-hidden'
        )}
        style={!isExpanded && isOverflowing ? { maxHeight: MAX_COLLAPSED_HEIGHT } : undefined}
      >
        {children}
      </div>

      {/* Gradient fade + Show more button (collapsed state) */}
      {!isExpanded && isOverflowing && (
        <div className="absolute bottom-0 left-0 right-0 h-24 bg-gradient-to-t from-muted/80 to-transparent rounded-b-3xl flex items-end justify-center pb-2 pointer-events-none">
          <button
            type="button"
            onClick={() => setIsExpanded(true)}
            className="pointer-events-auto text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1 px-3 py-1 rounded-full bg-background/80 border border-border/50 backdrop-blur-sm"
          >
            Show more
            <ChevronDown className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* Show less button (expanded state) */}
      {isExpanded && isOverflowing && (
        <div className="flex justify-end mt-1">
          <button
            type="button"
            onClick={handleCollapse}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
          >
            Show less
            <ChevronDown className="h-3 w-3 rotate-180" />
          </button>
        </div>
      )}
    </div>
  );
}
```

**Design decisions in this component:**

| Decision | Rationale |
|----------|-----------|
| `ResizeObserver` over one-time check | Content could reflow (e.g. images loading, code blocks rendering) |
| `useLayoutEffect` over `useEffect` | Prevents flash of full-height content before collapse |
| `rounded-b-3xl` on gradient | Matches the bubble's `rounded-3xl` so the gradient clips to the rounded corners |
| `pointer-events-none` on gradient div | Lets clicks pass through except on the button (`pointer-events-auto`) |
| `bg-background/80 backdrop-blur-sm` on button | Pill-shaped button floats on the gradient with subtle blur, readable in both light/dark mode |
| `from-muted/80` gradient | Needs to be opaque enough to obscure text but blend with `bg-muted/30` bubble. Implementer should test both light/dark and adjust if needed |
| `scrollIntoView` on collapse | Prevents disorienting viewport jump when a long expanded message collapses |
| No CSS transition on max-height | `max-height` transitions don't work well with `auto` height. The snap is acceptable and avoids complexity |

#### Step 2 — Wrap user message content

**File: `src/components/message-bubble.tsx`**

In the regular user message branch (around line 601-604), wrap `ContentBlockRenderer` with `CollapsibleUserMessage`. The wrapper goes **inside** the bubble div so the gradient blends with the bubble background:

```tsx
// BEFORE (lines 601-604)
{hasCleanContent && (
  <div className="max-w-[85%] px-4 py-3 rounded-3xl border border-border bg-muted/30 text-foreground">
    <ContentBlockRenderer content={cleanedContent} skillSheets={skillSheets} />
  </div>
)}

// AFTER
{hasCleanContent && (
  <div className="max-w-[85%] px-4 py-3 rounded-3xl border border-border bg-muted/30 text-foreground">
    <CollapsibleUserMessage>
      <ContentBlockRenderer content={cleanedContent} skillSheets={skillSheets} />
    </CollapsibleUserMessage>
  </div>
)}
```

Add the import at the top of `message-bubble.tsx`:
```tsx
import { CollapsibleUserMessage } from '@/components/collapsible-user-message';
```

**Note:** Do NOT wrap bug report card messages (lines 520-578). Those are already compact card UIs and should not be collapsible.

### Files to modify

| File | Change |
|------|--------|
| `src/components/collapsible-user-message.tsx` | **New** — overflow detection, gradient overlay, show more/less toggle |
| `src/components/message-bubble.tsx` | Import `CollapsibleUserMessage`, wrap user message `ContentBlockRenderer` inside it (line 601-604) |

### Not in scope

- Collapsing assistant messages (they contain tool calls and context that should stay visible)
- Collapsing bug report cards (already compact)
- Animating expand/collapse transition (CSS `max-height` transitions don't work with `auto` height; adding JS-measured height animation adds complexity for minimal UX gain)
- Virtualizing the message list (separate concern)

---

## Summary

| # | Change | Files | Effort |
|---|--------|-------|--------|
| 1 | Remove `!isStreaming` guard on assistant actions | `message-bubble.tsx` | Trivial (1 line + comment) |
| 2 | Collapsible user messages with gradient fade | `collapsible-user-message.tsx` (new), `message-bubble.tsx` | Small |

### Implementation order

1. **Part 1** — streaming action fix (trivial, immediate UX win)
2. **Part 2** — collapsible user messages (new component + integration)

### Components & dependencies used

- `cn()` from `@/lib/utils` (existing)
- `ChevronDown` from `lucide-react` (existing dependency)
- `Button`, `Tooltip`, `TooltipTrigger`, `TooltipContent` from `@/components/ui/*` (existing, already used in message-bubble)
- No new shadcn/ui components needed
- No new npm dependencies

### Verification

**Part 1 — Streaming actions:**
- Send a message, watch assistant stream → actions should NOT flicker/jump when streaming ends
- Hover during streaming → timestamp and copy button appear smoothly via opacity transition
- After streaming → same hover behavior as before
- Copy button during streaming → copies content accumulated so far (works because `contentToString(message.content)` reads current content)

**Part 2 — Collapsible user messages:**
- Short message (1-3 lines) → renders normally, no gradient, no button
- Long message (20+ lines, or paste a large code block) → collapses at 300px, gradient fade visible, "Show more" button centered at bottom
- Click "Show more" → full message expands, "Show less" appears at bottom-right
- Click "Show less" → message collapses, viewport scrolls to keep message top visible
- Light mode → gradient blends naturally with the muted/30 bubble background
- Dark mode → same gradient blending, button readable
- Message with file upload chips → chips render above bubble (unaffected), collapsible only affects the text content inside the bubble
- Resize window → `ResizeObserver` re-checks overflow, button appears/disappears appropriately
