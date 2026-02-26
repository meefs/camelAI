# Bug Fix Stragglers

## Status

February 25, 2026 — Draft v1

## Overview

Three UI polish bugs to fix: connection modal overflow, missing pointer cursors on buttons, and text input font size mismatch with chat messages.

---

## Bug 1: Connection Modal Content Overflow

### Problem

The agent-populated custom connection modal (`ConnectionSetupPrompt`) allows content to overflow outside the dialog rather than wrapping text and/or scrolling horizontally. This happens when the AI agent sends long markdown instructions, URLs, or code blocks via the `prompt_connection_setup` MCP tool. The static config-based dialog (`AddConnectionDialog`) does not have this issue.

### Root Cause

The `DialogContent` base component (`src/components/ui/dialog.tsx:61`) uses `grid` layout but has no `overflow-hidden` to contain its children. The connection setup prompt's scrollable content wrapper (`max-h-[60vh] overflow-y-auto`) handles vertical overflow but there is no horizontal containment. Specifically:

1. **Instructions box** (`src/components/connection-setup-prompt.tsx:266`) wraps `MarkdownRenderer` in a `div` with `rounded-md border bg-muted/50 p-3 text-sm` — no width constraint or `overflow-x` handling
2. **Field descriptions** (`src/components/connection-setup-prompt.tsx:309`) use `text-xs text-muted-foreground` with no `break-words` or `break-all` for long URLs/tokens
3. **DialogDescription** (`src/components/connection-setup-prompt.tsx:249-251`) can receive arbitrary agent-provided `data.message` text with no overflow handling
4. The `.markdown-content` CSS class (`src/styles/globals.css:207-213`) sets `word-wrap: break-word` and `overflow-wrap: break-word`, which helps for prose but does not constrain code blocks, pre-formatted content, or very long inline code

### Fix

**File: `src/components/connection-setup-prompt.tsx`**

1. Add `overflow-hidden` to the `DialogContent` className (line 239):
   ```
   className="sm:max-w-lg overflow-hidden"
   ```

2. Add `overflow-x-auto` to the instructions wrapper (line 266) so long content scrolls within the box instead of breaking out:
   ```
   <div className="rounded-md border bg-muted/50 p-3 text-sm overflow-x-auto">
   ```

3. Add `break-words` to field descriptions (line 309) to handle long API keys or URLs:
   ```
   <p className="text-xs text-muted-foreground break-words">{field.description}</p>
   ```

4. Add `break-words` to `DialogDescription` content (line 249-251) by adding a className:
   ```
   <DialogDescription className="break-words">
   ```

5. Add `min-w-0` to the scrollable content wrapper (line 255) to allow flex/grid children to shrink below their content width:
   ```
   <div className="max-h-[60vh] overflow-y-auto pr-4 min-w-0">
   ```

---

## Bug 2: Missing Pointer Cursor on Buttons

### Problem

Some buttons across the app show the default arrow cursor instead of the hand/pointer cursor when hovered. Users reported this on the scroll-to-bottom button, and a broader audit is needed. The root issue is that the base `Button` component does not include `cursor-pointer`.

### Root Cause

The `buttonVariants` CVA definition in `src/components/ui/button.tsx` (line 8) does not include `cursor-pointer` in its base class string. While native `<button>` elements show a default cursor (not pointer) by browser spec, the UI convention is that all clickable buttons should show the pointer cursor.

Some components in the codebase have already worked around this by manually adding `cursor-pointer` (e.g., `ask-user-question.tsx`, `AppCard.tsx`, `file-card.tsx`), but this is inconsistent.

### Fix

**File: `src/components/ui/button.tsx`**

Add `cursor-pointer` to the base CVA class string on line 8. Insert it alongside the other interaction-related classes (near `disabled:pointer-events-none disabled:opacity-50`):

```
Current (line 8):
"focus-visible:border-ring ... disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none shrink-0 ..."

Change to:
"focus-visible:border-ring ... cursor-pointer disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none shrink-0 ..."
```

This single change fixes all `<Button>` instances globally, including:
- Scroll-to-bottom button (`src/components/Chat.tsx:3416-3427`)
- Copy message buttons (`src/components/message-bubble.tsx`)
- All dialog action buttons
- All sidebar and nav buttons
- Every other `<Button>` in the app

**No other changes needed.** This is the correct fix because:
- `disabled:pointer-events-none` already handles disabled state (cursor won't show)
- The `link` variant benefits from pointer cursor as well
- Components that manually added `cursor-pointer` will just have a harmless duplicate class

---

## Bug 3: Chat Input Font Size Mismatch

### Problem

The text input field where users type messages uses a noticeably different (larger) font size than the rendered chat messages. The placeholder text also appears larger. Users expect WYSIWYG-like consistency — what they type should visually match what appears in the conversation.

### Root Cause

- **Input textarea** (`src/components/prompt-input.tsx:266`): Uses `text-base` (16px)
- **Rendered chat messages**: The message column (`src/components/Chat.tsx:3382`) and message bubbles (`src/components/message-bubble.tsx:602`) do not set an explicit text size. The `DialogContent` base sets `text-xs/relaxed` and the `.markdown-content` CSS class sets `text-foreground` but no size. The effective inherited font size for chat messages is the browser/body default (typically 16px from `<html>`) BUT the `text-xs/relaxed` on the dialog wrapper or page layout may cascade smaller.

The actual mismatch: the chat area's body text inherits from the root, which in this app renders at the base Tailwind size. The MarkdownRenderer paragraphs (`src/components/markdown-renderer.tsx`) have no explicit text size class — they inherit from their container. Looking at the rendering chain:

```
Chat.tsx scroll container (no text size set)
  └─ max-w-3xl column (no text size set)
    └─ MessageBubble (no text size set for content area)
      └─ MarkdownRenderer → .markdown-content (text-foreground, no size)
        └─ <p> tags (no size class — inherits parent)
```

The body/root text size determines chat message rendering. Meanwhile the input is explicitly `text-base` (16px).

### Fix

**The goal is to make the input text size match the conversation text size.** Since the rendered messages inherit the page's base text size and the input explicitly sets `text-base`, the fix should make them consistent. The simplest, safest approach:

**Option A (Recommended): Set explicit text size on the chat message area to `text-base` and keep the input at `text-base`**

This ensures both sides are explicitly `text-base` (16px) and won't drift if a parent changes.

**File: `src/components/message-bubble.tsx`**

Add `text-base` to the assistant message wrapper (line 645) and the user message bubble (line 602):

- Line 602 — user message bubble:
  ```
  Current:  "max-w-[85%] px-4 py-3 rounded-3xl border border-border bg-muted/30 text-foreground"
  Change:   "max-w-[85%] px-4 py-3 rounded-3xl border border-border bg-muted/30 text-foreground text-base"
  ```

- Line 645 — assistant message wrapper:
  ```
  Current:  "max-w-none space-y-4"
  Change:   "max-w-none space-y-4 text-base"
  ```

This makes both user bubbles and assistant messages render at `text-base` (16px), matching the input field's `text-base`. Sub-elements like code blocks (`text-sm`), headings, and inline code use relative or explicit sizes that will continue to work correctly.

**Why not change the input instead?** Reducing the input font size to `text-sm` or `text-xs` would make typing harder to read. `text-base` (16px) is the minimum recommended for mobile inputs (prevents iOS auto-zoom) and is a good default for a text input.
