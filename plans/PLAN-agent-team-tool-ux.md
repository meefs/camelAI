# Agent Team Tool UX Plan

## Overview

The Claude agent can spawn sub-agent teams using the `TeamCreate` tool and receive results back via `<teammate-message>` XML in user-role messages. Currently both of these render poorly:

1. **TeamCreate** falls through to `GenericDetails` and shows raw JSON for input/output
2. **Teammate messages** appear as regular user messages with raw XML tags visible

This plan addresses both issues to make the agent team experience feel native and consistent with the existing tool call UI.

---

## Goals

- Give `TeamCreate` a proper summary line, status, and detail view matching the existing tool call system
- Render `<teammate-message>` blocks as **collapsible tool-call-style rows** (not chat bubbles), keeping them compact and non-disruptive
- Keep changes minimal and consistent with existing patterns

---

## 1. TeamCreate Tool Call Styling

> **Status: Already implemented.** Included here for reference only.

### Current → Target

```
BEFORE:                                          AFTER:
┌────────────────────────────────────┐           ┌──────────────────────────────────────────┐
│ ●  TeamCreate                    ▸ │           │ ◉  Creating team animation-fixes...     ▸ │  running
└────────────────────────────────────┘           └──────────────────────────────────────────┘
  ┊  Input                                       ┌──────────────────────────────────────────┐
  ┊  { "team_name": "animation-…" }              │ ●  Created team animation-fixes         ▸ │  complete
  ┊  Output                                      └──────────────────────────────────────────┘
  ┊  { "team_name": "animation-…",                ┊  Team:        animation-fixes
  ┊    "team_file_path": "…",                      ┊  Description: Fix and enhance SVG…
  ┊    "lead_agent_id": "…" }                      ┊  Lead agent:  team-lead@animation-fixes
                                                   ┊  Config:      config.json  ← FileLink
```

Already done in:
- `src/components/tool-call/tool-summary.ts` - `TeamCreate` case
- `src/components/tool-call/details/team-create-details.tsx` - new component
- `src/components/tool-call/tool-details.tsx` - registered

---

## 2. Teammate Message Rendering (as Tool Call Row)

### Current Behavior

Teammate messages arrive as `role: "user"` messages with content like:

```
<teammate-message teammate_id="team-lead">
I've completed the `pixelDissolve` improvement in
`/home/sprite/svg-animator/app/lib/animations.ts` (lines 657-703).
Here's a summary of what changed:
...
TypeScript compiles cleanly with no errors.
</teammate-message>
```

This renders as a **right-aligned user chat bubble** with the raw XML tags visible:

```
                    ┌──────────────────────────────────────────┐
                    │  <teammate-message teammate_id="team-    │  ← raw XML
                    │  lead">                                  │
                    │  I've completed the `pixelDissolve`      │
                    │  improvement...                          │
                    │  </teammate-message>                     │  ← raw XML
                    └──────────────────────────────────────────┘
                           Sent by Alice at 3:45 PM  [Copy]
```

### Target Behavior

Teammate messages render as **collapsible tool-call rows** - the exact same visual pattern as every other tool call. Compact by default, expandable to see the full message.

```
COLLAPSED (default):
┌─────────────────────────────────────────────────────────────────┐
│ ●  team-lead: completed pixelDissolve improvement in /ho…    ▸ │
└─────────────────────────────────────────────────────────────────┘
  green dot ─┘     └─ teammate ID + first line preview     chevron ─┘


EXPANDED (on click):
┌─────────────────────────────────────────────────────────────────┐
│ ●  team-lead: completed pixelDissolve improvement in /ho…    ▾ │
└─────────────────────────────────────────────────────────────────┘
  ┊
  ┊  I've completed the `pixelDissolve` improvement in
  ┊  `/home/sprite/svg-animator/app/lib/animations.ts`
  ┊  (lines 657-703). Here's a summary of what changed:
  ┊
  ┊  - Changed iteration from sequential to random pixel
  ┊    selection
  ┊  - Added opacity fade-out for smoother look
  ┊
  ┊  TypeScript compiles cleanly with no errors.
  ┊
```

This reuses the **exact same visual language** as every other tool call:
- Colored status dot (green = complete, since these arrive finished)
- Single-line summary with truncation
- Chevron that rotates on expand (hidden until hover, like all tool calls)
- Left-bordered detail panel on expand (same `pl-4 border-l border-border/50 ml-1`)
- Full message rendered as markdown in the expanded panel

### Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Status dot = green** | Teammate messages arrive complete, never stream |
| **Summary = `"{id}: {preview}"`** | Shows who and what at a glance; first non-empty line, truncated to 60 chars |
| **Expanded = MarkdownRenderer** | Messages contain backticks, code refs, bullet lists |
| **No user bubble** | Entire user message consumed by the tool-call row; no right-aligned bubble |
| **Same CSS as ToolCall** | `tool-call`, `group/toolcall`, same hover/focus styles, identical animations |

### Implementation

#### A. Create `TeammateMessage` component

**New file:** `src/components/tool-call/teammate-message.tsx`

This component mirrors the structure of `ToolCall` in `tool-call.tsx` but is self-contained since the data comes from parsed XML, not a `ToolUseBlock`.

```tsx
"use client";

import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { MarkdownRenderer } from '@/components/markdown-renderer';

interface TeammateMessageProps {
  teammateId: string;
  content: string;
}

function getSummaryPreview(content: string): string {
  const firstLine = content.split(/\r?\n/).find(line => line.trim()) ?? '';
  const trimmed = firstLine.trim();
  const max = 60;
  return trimmed.length > max ? `${trimmed.slice(0, max)}...` : trimmed;
}

export function TeammateMessage({ teammateId, content }: TeammateMessageProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const preview = getSummaryPreview(content);

  return (
    <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
      <CollapsibleTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          className={cn(
            "tool-call group/toolcall flex w-full items-center gap-2 py-1 text-sm text-muted-foreground",
            "hover:bg-muted/30 rounded px-2 -mx-2 cursor-pointer text-left",
            "transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
          )}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              setIsExpanded(prev => !prev);
            }
          }}
        >
          <span className="tool-call__dot w-1.5 h-1.5 rounded-full shrink-0 bg-green-500" />
          <span className="tool-call__text min-w-0 flex-1 truncate">
            {teammateId}: {preview}
          </span>
          <ChevronRight
            className={cn(
              "tool-call__chevron h-4 w-4 text-muted-foreground/50 opacity-0 transition-all duration-150",
              "group-hover/toolcall:opacity-100",
              isExpanded && "opacity-100 rotate-90"
            )}
          />
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent
        className={cn(
          "group/details overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up",
          "motion-reduce:animate-none"
        )}
      >
        <div className="pl-4 mt-1 text-xs text-muted-foreground/80 border-l border-border/50 ml-1">
          <MarkdownRenderer content={content} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
```

Notable:
- Same `className` strings as `ToolCall` trigger row and content panel - pixel-identical styling
- Hardcoded `bg-green-500` on the dot (no status logic needed)
- Summary: `{teammateId}: {firstLinePreview}` - e.g. "team-lead: completed pixelDissolve improvement in /ho..."
- Content panel wraps `MarkdownRenderer` in the same `pl-4 mt-1 border-l border-border/50 ml-1` div used by `ToolCallDetails`

#### B. Update `message-bubble.tsx`

The parsing functions (`parseTeammateMessage`, `stripTeammateMessageTags`) are already in the codebase from the previous implementation. Keep them.

**Changes needed:**

1. **Remove** the `TeammateMessageBubble` component (the big blue-bordered block, currently around lines 318-370)
2. **Remove** the `Users` import from lucide-react (line 3) since it's no longer used
3. **Add** import for the new component:
   ```typescript
   import { TeammateMessage } from '@/components/tool-call/teammate-message';
   ```
4. **Simplify** the early return in the user message branch to use `TeammateMessage` instead of `TeammateMessageBubble`, dropping the unnecessary props (`timestamp`, `onCopy`, `isCopied`, `messageId`):
   ```typescript
   const teammateMessage = parseTeammateMessage(rawTextForTeammate);
   if (teammateMessage) {
     return (
       <TeammateMessage
         teammateId={teammateMessage.teammateId}
         content={teammateMessage.content}
       />
     );
   }
   ```

#### C. Keep `contentToString` / `stripTeammateMessageTags` as-is

The existing `stripTeammateMessageTags` in `contentToString` is still correct - if any code path calls `contentToString` on a message containing teammate XML, the tags get stripped cleanly.

---

## 3. Edge Cases

### Multiple teammate messages in one user message

If multiple `<teammate-message>` blocks arrive in a single message, the regex (which expects the entire content to be one teammate message) won't match. Falls through to normal user rendering with `stripTeammateMessageTags` cleaning the XML from display.

### Teammate message with author prefix

The `ChatThreadDO.formatAttributedUserMessage` adds `[Name (email)]:` prefixes. Teammate messages are injected by the Claude SDK, not typed by users, so they shouldn't go through author attribution. If they do, the regex won't match (it expects `<teammate-message` at start) and they'll fall through to regular rendering with XML stripped.

### Streaming teammate messages

Teammate messages arrive as complete `user` role messages, never streamed. No partial-render concern.

---

## Files Summary

| File | Change | Description |
|------|--------|-------------|
| `src/components/tool-call/tool-summary.ts` | Already done | `TeamCreate` case with running/complete tense |
| `src/components/tool-call/tool-details.tsx` | Already done | Import + register `TeamCreateDetails` |
| `src/components/tool-call/details/team-create-details.tsx` | Already done | Detail renderer: team, description, lead agent, config link |
| `src/components/tool-call/teammate-message.tsx` | **New** | Collapsible tool-call-style row for teammate messages |
| `src/components/message-bubble.tsx` | **Edit** | Remove `TeammateMessageBubble` + `Users` import, use `TeammateMessage` |

---

## Implementation Order

1. Create `TeammateMessage` component (`src/components/tool-call/teammate-message.tsx`)
2. Update `message-bubble.tsx`: remove `TeammateMessageBubble` + `Users` import, import + use `TeammateMessage`
3. Verify build

---

## Acceptance Criteria

- [x] TeamCreate tool shows "Creating team {name}..." while running and "Created team {name}" when complete
- [x] TeamCreate expanded state shows structured `DetailRow` fields (not raw JSON)
- [x] Config path is a clickable `FileLink`
- [ ] Teammate messages render as a collapsible tool-call row with green status dot
- [ ] Collapsed state shows `"{teammateId}: {first line preview...}"` as summary text
- [ ] Expanded state shows full message content as markdown in the standard left-bordered detail panel
- [ ] Same hover/chevron/animation behavior as all other tool calls
- [ ] Raw `<teammate-message>` XML tags are never visible to the user
- [ ] Copying content strips teammate XML tags
- [ ] Regular user messages are unaffected by the teammate parsing
