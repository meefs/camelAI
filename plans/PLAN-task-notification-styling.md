# Task Notification Styling Plan

## Overview

Background tasks in the Claude SDK (e.g. `Task` tool spawning background commands) emit completion notifications as `<task-notification>` XML inside `role: "user"` messages. Currently these render as **regular user message bubbles** with raw XML visible (in history) or are **silently hidden** as meta messages (during live streaming). Neither behavior is correct.

This plan makes task notifications render as **collapsible tool-call rows** — identical in visual language to every other tool call — and merges them into the preceding assistant message so they don't interrupt the assistant's flow.

---

## Current Behavior

Task notifications originate from the Claude SDK's background task system. When a background command completes, the SDK queues the notification and eventually sends it as a `role: "user"` message with content like:

```xml
<task-notification>
<task-id>be1fc16</task-id>
<output-file>/tmp/claude-1001/-home-claude/tasks/be1fc16.output</output-file>
<status>completed</status>
<summary>Background command "Add shadcn components" completed (exit code 0)</summary>
</task-notification>
Read the output file to retrieve the result: /tmp/claude-1001/-home-claude/tasks/be1fc16.output
```

### Problem 1: History rendering

When loading from JSONL history, the task notification is a plain `role: "user"` message with string content. It passes through all filters and renders as a right-aligned user bubble with raw XML:

```
                     ┌──────────────────────────────────────────────┐
                     │  <task-notification>                         │
                     │  <task-id>be1fc16</task-id>                  │
                     │  <output-file>/tmp/claude-1001/...</output-  │
                     │  file>                                       │
                     │  <status>completed</status>                  │
                     │  <summary>Background command "Add shadcn     │
                     │  components" completed (exit code 0)</summary│
                     │  >                                           │
                     │  </task-notification>                        │
                     │  Read the output file to retrieve the        │
                     │  result: /tmp/claude-1001/...                │
                     └──────────────────────────────────────────────┘
                            Sent by Alice at 3:45 PM  [Copy]
```

### Problem 2: Live streaming

During live WebSocket streaming, the task notification arrives as an SDK `user` event with string content (not tool_result blocks). Chat.tsx's handler hits the `!isToolResultEvent` branch, which marks it `isMeta: true`. Meta messages are filtered out of `visibleMessages` — the notification is invisible.

### Problem 3: Spacing disruption

Even if the notification were visible, it arrives as a `role: "user"` message. The render loop in Chat.tsx applies `mt-6 mb-1` to user messages, creating a jarring vertical gap that breaks the assistant's work flow:

```
CURRENT (history):
┌─────────────────────────────────────────────────────────┐
│ ● Read dashboard.tsx                                     │
│ ● Edited dashboard.tsx                                   │
│ The dashboard component is ready...                      │
└─────────────────────────────────────────────────────────┘
                                                             ← mt-6 gap
                     ┌──────────────────────────────────────────────┐
                     │ <task-notification>                          │  ← user bubble
                     │ ...raw XML...                                │
                     └──────────────────────────────────────────────┘
                                                             ← gap
┌─────────────────────────────────────────────────────────┐
│ I see the shadcn components are installed. Let me...     │  ← new assistant turn
└─────────────────────────────────────────────────────────┘
```

---

## Target Behavior

Task notifications render as collapsible tool-call rows, merged into the preceding assistant message, using the same visual language as every other tool call:

```
DESIRED:
┌─────────────────────────────────────────────────────────┐
│ ● Read dashboard.tsx                                     │
│ ● Edited dashboard.tsx                                   │
│ The dashboard component is ready...                      │
│ ● Background task "Add shadcn components" completed    ▸ │  ← inline, no gap
│ I see the shadcn components are installed. Let me...     │  ← next assistant turn
└─────────────────────────────────────────────────────────┘


COLLAPSED (default):
┌──────────────────────────────────────────────────────────┐
│ ●  Background task "Add shadcn components" completed   ▸ │
└──────────────────────────────────────────────────────────┘
 green ─┘  summary from XML ──────────────────┘    chevron ─┘


EXPANDED:
┌──────────────────────────────────────────────────────────┐
│ ●  Background task "Add shadcn components" completed   ▾ │
└──────────────────────────────────────────────────────────┘
  ┊  Status:      completed
  ┊  Task ID:     be1fc16
  ┊  Output file: /tmp/claude-1001/…/be1fc16.output  ← FileLink


FAILED variant:
┌──────────────────────────────────────────────────────────┐
│ ●  Background task "Run tests" failed                  ▸ │
└──────────────────────────────────────────────────────────┘
 red ─┘
```

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Summary = `<summary>` from XML** | The SDK already provides a human-readable summary ("Background command \"Add shadcn components\" completed (exit code 0)"). Use it directly — no need to synthesize a label. |
| **Status dot driven by `<status>`** | Green for `completed`, red for `failed`/`error`, grey for unknown. Matches existing tool call color semantics. |
| **Merge into preceding assistant message** | Follows the exact pattern established by `mergeTeammateMessages`. Eliminates spacing gaps and hover action orphans. |
| **Strip trailing instruction text** | Content after `</task-notification>` (e.g. "Read the output file...") is an instruction for Claude, not for the user. Strip it during parsing. |
| **Use `DetailRow` for expanded state** | Same shared component used across all detail views. Keeps the UI consistent. |
| **Output file as `FileLink`** | The output file path is actionable — clicking it could open the file preview. |
| **Same CSS as `ToolCall` / `TeammateMessage`** | `tool-call`, `group/toolcall`, same hover/focus styles, identical animations. |

---

## Implementation

This follows the same three-layer pattern as the teammate message implementation:
1. **Parse** — regex detection and structured extraction
2. **Normalize** — merge into preceding assistant message
3. **Render** — collapsible tool-call row component

### 1. New content block type

**File:** `src/types.ts`

Add `TaskNotificationBlock` to the `ContentBlock` union:

```typescript
export interface TaskNotificationBlock {
  type: 'task_notification';
  taskId: string;
  outputFile: string;
  status: string;       // 'completed' | 'failed' | etc.
  summary: string;      // Human-readable summary from SDK
}

export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | TeammateMessageBlock
  | TaskNotificationBlock;
```

### 2. Parser

**New file:** `src/lib/task-notification.ts`

Mirrors `src/lib/teammate-message.ts` in structure.

```typescript
const TASK_NOTIFICATION_REGEX =
  /<task-notification>\s*<task-id>([^<]+)<\/task-id>\s*<output-file>([^<]+)<\/output-file>\s*<status>([^<]+)<\/status>\s*<summary>([\s\S]*?)<\/summary>\s*<\/task-notification>/;

export interface ParsedTaskNotification {
  taskId: string;
  outputFile: string;
  status: string;
  summary: string;
}

/**
 * Strip Chiridion system message tags from content.
 * Duplicated here to avoid circular dependency with message-bubble.tsx.
 */
function stripSystemMessageTags(text: string): string {
  return text
    .replace(/<chiridion system message>[\s\S]*?<\/chiridion system message>/g, '')
    .trim();
}

export function parseTaskNotification(rawContent: string): ParsedTaskNotification | null {
  const stripped = stripSystemMessageTags(rawContent).trim();
  const match = stripped.match(TASK_NOTIFICATION_REGEX);
  if (!match) return null;
  return {
    taskId: (match[1] ?? '').trim(),
    outputFile: (match[2] ?? '').trim(),
    status: (match[3] ?? '').trim(),
    summary: (match[4] ?? '').trim(),
  };
}

export function stripTaskNotificationTags(text: string): string {
  return text
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
    .replace(/Read the output file to retrieve the result:.*$/gm, '')
    .trim();
}
```

### 3. Normalization function

**File:** `src/lib/streaming.ts`

Add `mergeTaskNotifications` following the exact pattern of `mergeTeammateMessages`:

```typescript
import { parseTaskNotification } from '@/lib/task-notification';
import type { TaskNotificationBlock } from '@/types';

/**
 * Merge task notifications into the preceding assistant message.
 *
 * Task notifications arrive as `role: "user"` messages containing
 * `<task-notification>` XML. This function detects them, removes them
 * from the message list, and appends a `task_notification` content block
 * to the preceding assistant message — so they render inline with the
 * assistant's tool calls and text, with identical spacing.
 */
export function mergeTaskNotifications(messages: Message[]): Message[] {
  const result: Message[] = [];
  let changed = false;

  for (const msg of messages) {
    if (msg.role !== 'user') {
      result.push(msg);
      continue;
    }

    // Extract raw text to check for task notification
    const rawText = typeof msg.content === 'string'
      ? msg.content
      : msg.content
          .map(block => (block.type === 'text' ? block.text : ''))
          .filter(Boolean)
          .join('\n');

    const parsed = parseTaskNotification(rawText);
    if (!parsed) {
      result.push(msg);
      continue;
    }

    // Find the last assistant message to attach to
    let lastAssistantIndex = -1;
    for (let i = result.length - 1; i >= 0; i -= 1) {
      if (result[i].role === 'assistant') {
        lastAssistantIndex = i;
        break;
      }
    }

    if (lastAssistantIndex === -1) {
      // No preceding assistant message — keep as-is (fallback)
      result.push(msg);
      continue;
    }

    // Append task notification block to the assistant message's content
    const assistantMsg = result[lastAssistantIndex];
    const existingContent: ContentBlock[] = Array.isArray(assistantMsg.content)
      ? assistantMsg.content
      : [{ type: 'text' as const, text: assistantMsg.content }];

    const notificationBlock: TaskNotificationBlock = {
      type: 'task_notification',
      taskId: parsed.taskId,
      outputFile: parsed.outputFile,
      status: parsed.status,
      summary: parsed.summary,
    };

    result[lastAssistantIndex] = {
      ...assistantMsg,
      content: [...existingContent, notificationBlock],
    };
    changed = true;
  }

  return changed ? result : messages;
}
```

### 4. Pipeline wiring

**File:** `src/components/Chat.tsx`

#### 4a. Normalization pipeline

Update the `normalizedMessages` useMemo to include task notification merging:

```typescript
import { mergeTaskNotifications } from '@/lib/streaming';

const normalizedMessages = useMemo(
  () => mergeTaskNotifications(mergeTeammateMessages(normalizeToolResultMessages(messages))),
  [messages]
);
```

Order: `normalizeToolResultMessages` → `mergeTeammateMessages` → `mergeTaskNotifications`

#### 4b. Live streaming handler

In the `sdkEvent.type === 'user'` branch, detect task notifications and add them as regular (non-meta) user messages so they flow through the normalization pipeline:

```typescript
} else if (sdkEvent.type === 'user' && sdkEvent.message?.content) {
  // ... existing compact summary handling ...

  const contentBlocks = sdkEvent.message.content;
  const isToolResultEvent = /* ... existing check ... */;

  if (!isToolResultEvent) {
    // Check if this is a task notification — should be visible, not meta
    const rawText = typeof contentBlocks === 'string'
      ? contentBlocks
      : Array.isArray(contentBlocks)
        ? contentBlocks.map(b => b.type === 'text' ? b.text : '').filter(Boolean).join('\n')
        : '';
    const isTaskNotification = Boolean(parseTaskNotification(rawText));

    if (isTaskNotification) {
      // Add as regular user message — normalization pipeline will merge
      // it into the preceding assistant message as a task_notification block
      const notificationMsg: Message = {
        id: `task_notif_${Date.now()}`,
        thread_id: id,
        role: 'user',
        content: contentBlocks,
        created_at: Date.now(),
      };
      setMessages(prev => [...prev, notificationMsg]);
      return;
    }

    // ... existing meta message handling for other user messages ...
  }
```

Import `parseTaskNotification` from `@/lib/task-notification` at the top of the file.

### 5. Render component

**New file:** `src/components/tool-call/task-notification.tsx`

Mirrors `src/components/tool-call/teammate-message.tsx` in structure. Uses identical CSS classes and animation behavior:

```tsx
"use client";

import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { DetailRow } from './details/shared';
import { FileLink } from './file-link';

interface TaskNotificationProps {
  taskId: string;
  outputFile: string;
  status: string;
  summary: string;
}

function getStatusDotClass(status: string): string {
  switch (status) {
    case 'completed':
      return 'bg-green-500';
    case 'failed':
    case 'error':
      return 'bg-red-500';
    default:
      return 'bg-muted-foreground';
  }
}

export function TaskNotification({ taskId, outputFile, status, summary }: TaskNotificationProps) {
  const [isExpanded, setIsExpanded] = useState(false);

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
          <span className={cn("tool-call__dot w-1.5 h-1.5 rounded-full shrink-0", getStatusDotClass(status))} />
          <span className="tool-call__text min-w-0 flex-1 truncate">
            {summary}
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
          <div className="space-y-2">
            <DetailRow label="Status:" value={status} />
            <DetailRow label="Task ID:" value={taskId} />
            {outputFile && (
              <div className="flex gap-2">
                <span className="shrink-0 text-muted-foreground/60">Output file:</span>
                <FileLink path={outputFile} className="min-w-0 truncate">
                  <span className="truncate">{outputFile.split('/').pop()}</span>
                </FileLink>
              </div>
            )}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
```

### 6. ContentBlockRenderer integration

**File:** `src/components/message-bubble.tsx`

Add handling for `task_notification` blocks in `ContentBlockRenderer`, right after the `teammate_message` case:

```tsx
import { TaskNotification } from '@/components/tool-call/task-notification';

// Inside the content.forEach loop:
if (block.type === 'task_notification') {
  items.push({
    kind: 'tool',
    key: `task-notif-${index}`,
    node: (
      <TaskNotification
        taskId={block.taskId}
        outputFile={block.outputFile}
        status={block.status}
        summary={block.summary}
      />
    ),
  });
  return;
}
```

Using `kind: 'tool'` ensures task notifications are grouped with adjacent tool calls in the `space-y-1` sections, not separated by the `space-y-4` gaps used between text blocks.

### 7. Copy support

**File:** `src/components/message-bubble.tsx`

Update `contentToString` to handle the new block type:

```typescript
if (block.type === 'task_notification') return `[Task ${block.status}] ${block.summary}`;
```

---

## Files Summary

| File | Change | Description |
|------|--------|-------------|
| `src/types.ts` | **Edit** | Add `TaskNotificationBlock` to `ContentBlock` union |
| `src/lib/task-notification.ts` | **New** | Parser: `parseTaskNotification`, `stripTaskNotificationTags` |
| `src/lib/streaming.ts` | **Edit** | Add `mergeTaskNotifications()` normalization function |
| `src/components/Chat.tsx` | **Edit** | Wire normalization pipeline + detect task notifications in live streaming handler |
| `src/components/tool-call/task-notification.tsx` | **New** | Collapsible tool-call row component |
| `src/components/message-bubble.tsx` | **Edit** | Handle `task_notification` in `ContentBlockRenderer` + `contentToString` |

---

## Implementation Order

1. Add `TaskNotificationBlock` type to `src/types.ts`
2. Create parser `src/lib/task-notification.ts`
3. Add `mergeTaskNotifications` to `src/lib/streaming.ts`
4. Create `TaskNotification` component in `src/components/tool-call/task-notification.tsx`
5. Update `ContentBlockRenderer` and `contentToString` in `src/components/message-bubble.tsx`
6. Wire pipeline + live handler in `src/components/Chat.tsx`
7. Verify build

---

## Edge Cases

| Case | Handling |
|------|----------|
| No preceding assistant message | Keep as user message (falls through to normal rendering with raw XML — rare edge case that only happens if notification is the very first message) |
| Multiple task notifications in sequence | Each merges into the last assistant message as separate blocks |
| Task notification between two assistant messages | Merged into the preceding (earlier) assistant message |
| Malformed `<task-notification>` XML | Regex won't match → falls through to normal user message rendering |
| Task notification with author prefix | `parseTaskNotification` strips system tags first; author prefix would prevent regex match → falls through to normal rendering (unlikely since notifications are SDK-generated, not user-typed) |
| `contentToString` for copy | New case in the `contentToString` switch handles it cleanly |
| Notification during active streaming | Live handler detects it before the meta-message fallback, adds as regular user message for normalization |

---

## Acceptance Criteria

- [ ] Task notifications render as collapsible tool-call rows (not user bubbles, not hidden)
- [ ] Collapsed summary shows the human-readable `<summary>` text from the XML
- [ ] Status dot is green for `completed`, red for `failed`/`error`
- [ ] Expanded state shows Status, Task ID, and Output file as `DetailRow` fields
- [ ] Output file path is a clickable `FileLink`
- [ ] Task notifications appear inline with the preceding assistant message (no `mt-6` gap)
- [ ] Same hover/chevron/animation behavior as all other tool calls
- [ ] Raw `<task-notification>` XML tags are never visible to the user
- [ ] Trailing "Read the output file..." instruction text is not shown
- [ ] Works in both history (JSONL load) and live streaming contexts
- [ ] Copying content produces clean `[Task completed] Summary...` text
- [ ] Regular user messages are unaffected
- [ ] Build passes cleanly
