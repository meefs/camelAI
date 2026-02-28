# Chat Streaming, User Message Overflow, and Thinking Style

**February 28, 2026 — Draft v1**

---

## Overview

Three improvements to the chat message experience:

1. **Fix chat action flickering during streaming** — Actions (timestamp, copy button) on assistant messages are currently hidden during streaming and flash in when streaming ends. Instead, always render them at the bottom of the message.
2. **Max height on user messages** — Long user messages should collapse with a gradient fade and "Show more" button.
3. **Style the thinking block** — The current thinking block is too plain. Give it a more polished, distinct visual treatment.

---

## Part 1: Fix Chat Action Flickering

### Problem

Assistant message actions (timestamp + copy button) are conditionally rendered with `{!isStreaming && hasContent && (...)}` in `message-bubble.tsx:652`. This causes them to flicker in abruptly when streaming ends — the message jumps as the action row gets inserted into the DOM.

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

Always render the action row. During streaming, keep it invisible (like the hover state) so it occupies no space — but never remove it from the DOM. When streaming ends, it simply becomes hoverable without any layout shift.

Alternatively, we can make it always present in the DOM but collapsed to zero height during streaming, transitioning smoothly. The simplest fix is just removing the `!isStreaming` guard entirely — the actions are already `opacity-0` by default and only appear on hover, so they won't be visible during streaming unless hovered. This is actually fine UX — if the user hovers during streaming, showing the timestamp and copy button is reasonable.

```
During streaming (hovered):         After streaming (hovered):
┌─────────────────────────────┐     ┌─────────────────────────────┐
│ ● Edit src/index.ts         │     │ ● Edit src/index.ts         │
│ ···                         │     │ Done! Let me know if...     │
│ 12:25 PM  [⎘]              │     │ 12:25 PM  [⎘]              │
└─────────────────────────────┘     └─────────────────────────────┘
   ↑ same row, just visible            ↑ no layout shift
     on hover during streaming
```

### Implementation

**File: `src/components/message-bubble.tsx`**

Line 652 — remove the `!isStreaming` condition from the assistant message action row:

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

That's the entire change. The actions are already hidden by default (`opacity-0`) and only shown on hover (`group-hover:opacity-100`), so this doesn't change the visual appearance during streaming — it only prevents the layout shift when streaming ends.

### Files to modify

| File | Change |
|------|--------|
| `src/components/message-bubble.tsx` | Remove `!isStreaming &&` guard on assistant action row (line 652) |

---

## Part 2: Max Height on User Messages with "Show More"

### Problem

Users can paste very long messages (code blocks, stack traces, data dumps). These render at full height, pushing the assistant's response far down the viewport and making the conversation hard to follow.

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
│ (assistant response is way below fold)   │
│                                          │
└──────────────────────────────────────────┘
```

### Design

Collapse long user messages to a max height with a gradient fade overlay and a "Show more" button. The gradient goes from transparent at the top to the bubble's background color at the bottom, creating a natural fade-out effect. The "Show more" button sits on top of the gradient.

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
│    │ ░░░░░░░░░░░░ Show more ░░░░░░░░ │  │
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

#### Visual detail: gradient overlay

The gradient needs to blend into the user message bubble's background (`bg-muted/30` with `border-border`). Use a gradient that goes from fully transparent to the bubble's effective background color. Since the bubble uses a semi-transparent background, the gradient's bottom color should match `muted` at the appropriate opacity.

```
┌──────────────────────────────────────┐
│ Message text...                      │
│ More text...                         │
│ ╔════════════════════════════════════╗ ← gradient starts (transparent)
│ ║  gradually fading text...         ║
│ ║▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓║ ← gradient mid (semi-opaque)
│ ║▓▓▓▓▓▓▓▓▓ Show more ▓▓▓▓▓▓▓▓▓▓▓▓▓║ ← button centered on gradient
│ ╚════════════════════════════════════╝ ← gradient end (fully opaque)
└──────────────────────────────────────┘
```

### Implementation

Create a new `CollapsibleUserMessage` wrapper component that handles the max-height, overflow detection, gradient, and toggle.

**Constants:**
- `MAX_COLLAPSED_HEIGHT = 300` (px) — roughly 12-14 lines of text. Enough to see the beginning of the message clearly.

#### Step 1 — Create `CollapsibleUserMessage` component

**New file: `src/components/collapsible-user-message.tsx`**

```tsx
interface CollapsibleUserMessageProps {
  children: ReactNode;
}
```

Component logic:
1. Wrap children in a container with `ref` for measuring
2. Use `useLayoutEffect` + `ResizeObserver` to detect if content exceeds `MAX_COLLAPSED_HEIGHT`
3. If content is short, render normally (no gradient, no button)
4. If content overflows:
   - Collapsed: Apply `max-h-[300px] overflow-hidden` to content wrapper
   - Show gradient overlay (`absolute bottom-0 left-0 right-0 h-24`)
   - Show "Show more" button centered on the gradient
   - Expanded: Remove max-height, show "Show less" button at bottom-right

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

      {/* Gradient fade overlay */}
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

      {/* Show less button (when expanded) */}
      {isExpanded && isOverflowing && (
        <div className="flex justify-end mt-1">
          <button
            type="button"
            onClick={() => setIsExpanded(false)}
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

**Gradient color note:** The user bubble has `bg-muted/30`, so the gradient should fade from transparent to something that roughly matches. Using `from-muted/80` creates a stronger opaque bottom that blends into the muted background. The implementer should test this in both light and dark mode and may need to adjust. The gradient needs to be opaque enough that the text is clearly fading out but translucent enough that it blends naturally with the bubble.

The `rounded-b-3xl` on the gradient matches the bubble's `rounded-3xl` so the gradient doesn't overflow the rounded corners.

#### Step 2 — Wrap user message content in `CollapsibleUserMessage`

**File: `src/components/message-bubble.tsx`**

In the regular user message branch (lines 581-637), wrap the content bubble with `CollapsibleUserMessage`:

```tsx
// BEFORE (lines 601-605)
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

The `CollapsibleUserMessage` sits inside the bubble so the gradient blends with the bubble's background.

#### Step 3 — Handle scroll-to behavior

When the user clicks "Show less", the message may collapse and the viewport may jump. Add a scroll-into-view on collapse:

```tsx
// Inside CollapsibleUserMessage, in the collapse handler:
const handleCollapse = () => {
  setIsExpanded(false);
  // Scroll the message top into view after collapsing
  requestAnimationFrame(() => {
    contentRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
};
```

### Files to modify

| File | Change |
|------|--------|
| `src/components/collapsible-user-message.tsx` | **New** — overflow detection, gradient overlay, show more/less toggle |
| `src/components/message-bubble.tsx` | Wrap user message content in `<CollapsibleUserMessage>` |

### Not in scope
- Collapsing assistant messages (they can be long too, but collapsing them would hide tool calls and important context)
- Collapsing bug report cards (they're already compact)
- Animating the expand/collapse transition (keep it simple for now — CSS transitions on max-height don't work well with auto height)

---

## Part 3: Style the Thinking Block

### Problem

The current thinking block is minimal — just an italic "Thinking..." label that expands to show monospace text. It lacks visual distinction and personality. Given that thinking is a significant part of the AI's process, it deserves a more polished treatment.

Current:
```
┌─ Current thinking block ──────────────────────────────┐
│                                                        │
│  Thinking...                                      ▸    │  ← italic muted text, chevron on hover
│  ┃ The user wants me to fix the bug in...              │  ← expanded: monospace, left border
│  ┃ Let me check the error first...                     │
│                                                        │
└────────────────────────────────────────────────────────┘
```

### Design

Give the thinking block a distinct visual identity: a subtle background container, a sparkle/brain icon, and improved typography for the expanded content.

```
┌─ Redesigned thinking block (collapsed) ────────────────┐
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │  ✦  Thinking                               ▸   │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
└─────────────────────────────────────────────────────────┘

┌─ Redesigned thinking block (expanded) ─────────────────┐
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │  ✦  Thinking                               ▾   │   │
│  │                                                 │   │
│  │  The user wants me to fix the bug in the        │   │
│  │  authentication module. Let me check the        │   │
│  │  error stack trace first to understand           │   │
│  │  what's happening...                            │   │
│  │                                                 │   │
│  │  I see — the issue is that the session          │   │
│  │  token is being validated before the            │   │
│  │  middleware runs. I need to reorder the          │   │
│  │  middleware chain.                              │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

#### Design details

- **Container:** `rounded-lg border border-border/30 bg-muted/20` — a subtle card that sets the thinking apart from regular text without being heavy
- **Icon:** Use `Sparkles` from lucide-react (✦) — conveys intelligence/processing. Sized at `h-3.5 w-3.5`, colored `text-muted-foreground/50`
- **Label:** "Thinking" (drop the "..." — the block's existence already implies process). `text-sm text-muted-foreground/60 font-medium` (no longer italic)
- **Chevron:** `ChevronRight` that rotates to `ChevronDown` on expand, `text-muted-foreground/40`, visible on hover same as current
- **Expanded content:** `text-sm text-muted-foreground/70` with `whitespace-pre-wrap leading-relaxed`. No longer monospace — thinking content reads better in the body font. Drop the left border, use padding instead
- **Expanded content max-height:** `max-h-[400px] overflow-y-auto` — thinking blocks can be very long, cap them with scroll
- **Animation:** Keep existing `collapsible-down` / `collapsible-up` from the Collapsible component

### Implementation

**File: `src/components/tool-call/thinking-block.tsx`**

Full replacement of the component:

```tsx
"use client";

import { useState } from 'react';
import { ChevronRight, Sparkles } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

interface ThinkingBlockProps {
  thinking: string;
  defaultExpanded?: boolean;
}

export function ThinkingBlock({ thinking, defaultExpanded = false }: ThinkingBlockProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  return (
    <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
      <div className={cn(
        "rounded-lg border border-border/30 transition-colors duration-150",
        isExpanded ? "bg-muted/20" : "bg-transparent hover:bg-muted/10"
      )}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className={cn(
              "flex w-full items-center gap-2 px-3 py-2 text-sm text-muted-foreground/60",
              "cursor-pointer text-left rounded-lg",
              "transition-colors duration-150",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
            )}
          >
            <Sparkles className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
            <span className="flex-1 font-medium">Thinking</span>
            <ChevronRight
              className={cn(
                "h-3.5 w-3.5 text-muted-foreground/40 transition-transform duration-150",
                isExpanded && "rotate-90"
              )}
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent
          className={cn(
            "overflow-hidden",
            "data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up",
            "motion-reduce:animate-none"
          )}
        >
          <div className="px-3 pb-3 pt-0">
            <div className="text-sm text-muted-foreground/70 whitespace-pre-wrap leading-relaxed max-h-[400px] overflow-y-auto">
              {thinking}
            </div>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
```

#### Key changes from current:
1. Added a subtle container (`rounded-lg border`) around the entire block
2. Replaced italic "Thinking..." with `Sparkles` icon + "Thinking" label
3. Expanded content uses body font (`text-sm`) instead of monospace (`text-xs`)
4. Removed the `border-l` left border in favor of the container's border
5. Added `max-h-[400px]` with overflow scroll for very long thinking content
6. Container background changes on expand (`bg-transparent` → `bg-muted/20`)
7. Chevron is always visible (not just on hover) since it's inside a card now

### Files to modify

| File | Change |
|------|--------|
| `src/components/tool-call/thinking-block.tsx` | Redesign with container, Sparkles icon, improved typography |

---

## Summary

| # | Change | Files | Effort |
|---|--------|-------|--------|
| 1 | Remove `!isStreaming` guard on assistant actions | `message-bubble.tsx` | Trivial (1 line) |
| 2 | Collapsible user messages with gradient | `collapsible-user-message.tsx` (new), `message-bubble.tsx` | Small |
| 3 | Restyle thinking block | `thinking-block.tsx` | Small |

### Implementation order

1. **Part 1** — streaming action fix (trivial, immediate UX improvement)
2. **Part 3** — thinking block restyle (self-contained, one file)
3. **Part 2** — collapsible user messages (new component + integration)

### Components used

- `Collapsible`, `CollapsibleContent`, `CollapsibleTrigger` from `@/components/ui/collapsible` (existing)
- `cn()` from `@/lib/utils` (existing)
- `ChevronRight`, `ChevronDown`, `Sparkles` from `lucide-react` (existing dependency)
- No new shadcn/ui components needed
- No new dependencies

### Verification

**Part 1:**
- Send a message, watch assistant stream response — actions should not flicker at end of stream
- Hover during streaming — timestamp and copy button appear smoothly
- After streaming — same hover behavior as before

**Part 2:**
- Send a short message (1-2 lines) — no gradient, no "Show more" button
- Send/paste a long message (20+ lines) — message collapses at 300px, gradient visible, "Show more" button centered
- Click "Show more" — full message expands, "Show less" appears at bottom-right
- Click "Show less" — message collapses again, viewport scrolls to keep message visible
- Both light and dark mode — gradient blends naturally with bubble background

**Part 3:**
- Send a message that triggers thinking — "Thinking" label with sparkle icon appears in a subtle card
- Click to expand — thinking content appears in body font with comfortable spacing
- Very long thinking content — scrolls within the 400px container
- Collapse again — smooth animation
