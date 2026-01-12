# Skill Sheet Tool Call Bug Fix - Implementation Plan

This document outlines the fix for the bug where skill sheet content is displayed as a user message instead of being styled as a proper tool call.

---

## Problem Statement

When the `Skill` tool is invoked, the skill sheet content (the skill's documentation) is incorrectly displayed as if it were a message sent by the user.

### Current Behavior

Looking at the conversation log:

1. Assistant calls Skill tool:
   ```json
   {"type":"tool_use","id":"toolu_01Pfm7h2FfT1jmULmwq7uUpp","name":"Skill","input":{"skill":"frontend-design"}}
   ```

2. Tool result is returned:
   ```json
   {"type":"tool_result","tool_use_id":"toolu_01Pfm7h2FfT1jmULmwq7uUpp","content":"Launching skill: frontend-design"}
   ```

3. Skill sheet content arrives as a separate "meta" message:
   ```json
   {
     "type":"user",
     "message":{"role":"user","content":[{"type":"text","text":"Base directory for this skill: /home/claude/.claude/skills/frontend-design\n\n..."}]},
     "isMeta":true,
     "sourceToolUseID":"toolu_01Pfm7h2FfT1jmULmwq7uUpp"
   }
   ```

**Problem:** The frontend renders this meta message as a regular user message (with the user message bubble styling) because:
- The `isMeta` flag is not being checked
- The `sourceToolUseID` field is not being used to associate it with the Skill tool call

### Expected Behavior

The skill sheet should be displayed as part of the Skill tool call inline display, following the existing tool call UX design:

- **Collapsed:** `• Activated frontend-design` (with green dot)
- **Expanded:** Shows skill name and expandable skill sheet content

---

## Root Cause Analysis

### Data Flow

1. The SDK emits skill-related events through the WebSocket
2. `Chat.tsx` receives `sdk_event` messages and updates message state
3. However, the skill sheet comes as a separate message with `isMeta: true`
4. This message has `type: "user"` and `role: "user"` so it's treated as a user message
5. `MessageBubble` renders it with user styling (rounded pill, right-aligned)

### Key Fields

| Field | Purpose |
|-------|---------|
| `isMeta` | Indicates this is a system/meta message, not a real user message |
| `sourceToolUseID` | Links this message to the originating tool_use block |

---

## Implementation Plan

### Phase 1: Update Types

**File:** `src/types.ts`

Add metadata fields to the Message type:

```typescript
export interface Message {
  id: string;
  thread_id: string;
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
  created_at: number;
  isStreaming?: boolean;
  /** @internal Block offset for streaming, cleared when done */
  _blockOffset?: number;
  /** Indicates this is a meta message (e.g., skill sheet), not a real user message */
  isMeta?: boolean;
  /** Links meta message to the originating tool_use block */
  sourceToolUseID?: string;
}
```

---

### Phase 2: Filter Meta Messages from User Display

**File:** `src/components/message-bubble.tsx`

Update `MessageBubble` to not render messages with `isMeta: true` as user messages. These messages should be hidden from the regular message flow since they'll be displayed as part of tool calls.

**Option A (Simple):** Return null for meta messages

```typescript
export function MessageBubble({ message, onCopy, copiedId, showStreamingIndicator = false }: MessageBubbleProps) {
  // Don't render meta messages - they're displayed as part of tool calls
  if (message.isMeta) {
    return null;
  }

  // ... rest of component
}
```

**Option B (Explicit filter in Chat.tsx):** Filter meta messages before rendering

```typescript
// In Chat.tsx, filter out meta messages from the render loop
const visibleMessages = useMemo(
  () => messages.filter(msg => !msg.isMeta),
  [messages]
);
```

**Recommendation:** Use Option A - it's cleaner and keeps the filtering logic close to where rendering happens.

---

### Phase 3: Build Skill Sheet Context

**File:** `src/components/Chat.tsx`

Create a map of `toolUseId -> skillSheetContent` that can be passed to tool call rendering:

```typescript
// Build skill sheet lookup from meta messages
const skillSheetsByToolId = useMemo(() => {
  const map = new Map<string, string>();
  for (const msg of messages) {
    if (msg.isMeta && msg.sourceToolUseID) {
      // Extract text content from the message
      const content = typeof msg.content === 'string'
        ? msg.content
        : msg.content
            .filter(block => block.type === 'text')
            .map(block => (block as TextBlock).text)
            .join('\n\n');
      map.set(msg.sourceToolUseID, content);
    }
  }
  return map;
}, [messages]);
```

Then pass this to `MessageBubble` which can forward it to `ContentBlockRenderer`:

```typescript
<MessageBubble
  message={msg}
  skillSheets={skillSheetsByToolId}
  // ... other props
/>
```

---

### Phase 4: Update ContentBlockRenderer

**File:** `src/components/message-bubble.tsx`

Update `ContentBlockRenderer` to accept and pass skill sheets to `ToolCall`:

```typescript
interface ContentBlockRendererProps {
  content: string | ContentBlock[];
  isStreaming?: boolean;
  skillSheets?: Map<string, string>;  // NEW
}

function ContentBlockRenderer({ content, isStreaming = false, skillSheets }: ContentBlockRendererProps) {
  // ... existing code ...

  if (block.type === 'tool_use') {
    const result = toolResultsById.get(block.id);
    const skillSheet = skillSheets?.get(block.id);  // Get associated skill sheet
    items.push({
      kind: 'tool',
      key: `tool-${block.id || index}`,
      node: <ToolCall tool={block} result={result} isStreaming={isStreaming} skillSheet={skillSheet} />,
    });
    return;
  }

  // ... rest of function
}
```

---

### Phase 5: Update ToolCall Component

**File:** `src/components/tool-call/tool-call.tsx`

Add `skillSheet` prop to `ToolCallProps`:

```typescript
export interface ToolCallProps {
  tool?: ToolUseBlock;
  result?: ToolResultBlock;
  isStreaming?: boolean;
  defaultExpanded?: boolean;
  skillSheet?: string;  // NEW: Skill sheet content for Skill tool calls
}
```

Pass to `ToolCallDetails`:

```typescript
<ToolCallDetails tool={tool} result={result} skillSheet={skillSheet} />
```

---

### Phase 6: Add Skill Summary

**File:** `src/components/tool-call/tool-summary.ts`

Add a case for the `Skill` tool:

```typescript
case 'Skill': {
  const skill = typeof inputRecord.skill === 'string' ? inputRecord.skill : '';
  if (isStreaming && !skill) {
    return { action: 'Activating skill...' };
  }
  return {
    action: 'Activated',
    filename: skill || 'skill',
  };
}
```

**Note:** We use `filename` here because the summary rendering checks for `filename` to display the second part. The skill name serves a similar role to a filename.

---

### Phase 7: Create SkillDetails Component

**File:** `src/components/tool-call/details/skill-details.tsx` (NEW)

```typescript
"use client";

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { ToolResultBlock, ToolUseBlock } from '@/types';
import { DetailRow, OutputBlock } from './shared';
import { getResultText } from '../tool-utils';
import { cn } from '@/lib/utils';

interface SkillDetailsProps {
  tool?: ToolUseBlock;
  result?: ToolResultBlock;
  skillSheet?: string;
}

export function SkillDetails({ tool, result, skillSheet }: SkillDetailsProps) {
  const [isSheetExpanded, setIsSheetExpanded] = useState(false);
  const input = tool?.input ?? {};
  const skillName = typeof input.skill === 'string' ? input.skill : '';
  const resultText = getResultText(result);

  // Truncate skill sheet for preview
  const previewLength = 200;
  const hasLongSheet = skillSheet && skillSheet.length > previewLength;
  const sheetPreview = hasLongSheet
    ? skillSheet.slice(0, previewLength) + '...'
    : skillSheet;

  return (
    <div className="space-y-1">
      <DetailRow label="Skill:" value={skillName} mono />
      {resultText && <DetailRow label="Status:" value={resultText} />}

      {skillSheet && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setIsSheetExpanded(!isSheetExpanded)}
            className={cn(
              "flex items-center gap-1 text-[0.7rem] text-muted-foreground/60 hover:text-muted-foreground transition-colors",
              "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/50 rounded"
            )}
          >
            {isSheetExpanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            <span>Skill Sheet</span>
          </button>

          <div className={cn(
            "mt-2 font-mono text-xs bg-muted/30 rounded p-2 overflow-auto transition-all",
            isSheetExpanded ? "max-h-64" : "max-h-16"
          )}>
            <pre className="whitespace-pre-wrap font-mono text-xs text-muted-foreground/80">
              {isSheetExpanded ? skillSheet : sheetPreview}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
```

---

### Phase 8: Register Skill in ToolCallDetails

**File:** `src/components/tool-call/tool-details.tsx`

Add the Skill case:

```typescript
import { SkillDetails } from './details/skill-details';

// ... in the switch statement:

case 'Skill':
  content = <SkillDetails tool={tool} result={result} skillSheet={skillSheet} />;
  break;
```

Update the component signature to accept `skillSheet`:

```typescript
interface ToolCallDetailsProps {
  tool?: ToolUseBlock;
  result?: ToolResultBlock;
  skillSheet?: string;  // NEW
}

export function ToolCallDetails({ tool, result, skillSheet }: ToolCallDetailsProps) {
  // ...
}
```

---

## File Summary

| File | Changes |
|------|---------|
| `src/types.ts` | Add `isMeta` and `sourceToolUseID` fields to Message type |
| `src/components/message-bubble.tsx` | Filter out `isMeta` messages, pass `skillSheets` to ContentBlockRenderer |
| `src/components/Chat.tsx` | Build `skillSheetsByToolId` map from meta messages |
| `src/components/tool-call/tool-call.tsx` | Add `skillSheet` prop, pass to ToolCallDetails |
| `src/components/tool-call/tool-summary.ts` | Add `Skill` case |
| `src/components/tool-call/tool-details.tsx` | Add `Skill` case, accept `skillSheet` prop |
| `src/components/tool-call/details/skill-details.tsx` | **NEW** - Skill tool expanded details component |

---

## Visual Design

### Collapsed State

```
• Activated frontend-design
```

- Green dot (complete status)
- "Activated" as the action verb
- Skill name displayed like a filename
- Hover shows chevron for expansion

### Expanded State

```
• Activated frontend-design                              ▼
  Skill: frontend-design
  Status: Launching skill: frontend-design

  ▶ Skill Sheet

  [Collapsed preview of first ~200 chars...]
```

When "Skill Sheet" is clicked:

```
• Activated frontend-design                              ▼
  Skill: frontend-design
  Status: Launching skill: frontend-design

  ▼ Skill Sheet

  Base directory for this skill: /home/claude/.claude/skills/frontend-design

  This skill guides creation of distinctive, production-grade frontend...
  [Full content with scroll]
```

---

## Edge Cases

### 1. Skill tool without skill sheet
- Display the tool call with just the tool_result content
- "Skill Sheet" section not shown

### 2. Skill sheet arrives before tool_use
- The `skillSheetsByToolId` map is rebuilt on every message change
- When tool_use block renders, it will find the skill sheet

### 3. Multiple skills in same conversation
- Each skill sheet is keyed by its `sourceToolUseID`
- No collision between different skill invocations

### 4. Streaming state
- While streaming (before skill name arrives): "Activating skill..."
- After skill name arrives: "Activated {skill-name}"

---

## Testing Checklist

### Functional Tests
- [ ] Skill sheet not displayed as user message
- [ ] Skill tool call shows correct collapsed summary
- [ ] Expanded view shows skill name and status
- [ ] Skill sheet is expandable/collapsible
- [ ] Skill sheet content renders correctly (preserves whitespace)
- [ ] Multiple skill calls in conversation work independently

### Visual Tests
- [ ] Collapsed state matches other tool calls styling
- [ ] Expanded state follows tool-call UX design
- [ ] Skill sheet toggle is keyboard accessible
- [ ] Long skill sheets scroll within container

### Edge Case Tests
- [ ] Skill tool without skill sheet displays gracefully
- [ ] Streaming state shows "Activating skill..."
- [ ] Historical messages with skills render correctly

---

## Implementation Order

1. **Types** - Add `isMeta` and `sourceToolUseID` to Message type
2. **Filter** - Hide meta messages from user message rendering
3. **Context** - Build skill sheet lookup in Chat.tsx
4. **Summary** - Add Skill case to tool-summary.ts
5. **Details** - Create skill-details.tsx component
6. **Wire up** - Update tool-details.tsx and tool-call.tsx to pass skill sheet
7. **Test** - Verify end-to-end behavior

---

## Notes for Implementation

- The skill sheet content can be quite long (several hundred lines). The expandable/collapsible design keeps the default view compact.
- Follow existing patterns in `tool-call/details/` for consistency.
- The `isMeta` field check should be the very first thing in MessageBubble to avoid unnecessary rendering work.
- Consider adding a copy button for the skill sheet content (useful for debugging).
