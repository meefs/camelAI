# Teammate Message Spacing & Flow Plan

## Problem

Teammate messages arrive as `role: "user"` messages. In `Chat.tsx`, each message gets its own wrapper `<div>`:

```tsx
<div
  key={msg.id}
  className={cn("group", msg.role === 'user' ? "mt-6 mb-1" : "")}
>
  <MessageBubble ... />
</div>
```

This causes two problems:

1. **Spacing**: User messages get `mt-6 mb-1`, creating a large visual gap that "slices up" the assistant's response stream. The user sees a continuous flow of assistant work (text → tool calls → text → teammate update → text), but the teammate update injects a jarring gap.

2. **Hover actions**: The wrapper `<div className="group">` enables `group-hover:opacity-100` on the message action row (timestamp, copy button). Teammate messages rendered by `<TeammateMessage>` don't have these actions, but the `group` class still creates a hover target that reveals... nothing. Worse, it can interfere with the hover behavior of adjacent messages.

```
CURRENT BEHAVIOR:
┌─────────────────────────────────────────────────────────┐
│ Assistant text block                                    │  ← assistant div (no extra margin)
│ ● Read file.tsx                                         │
│ ● Edited file.tsx                                       │
└─────────────────────────────────────────────────────────┘
                                                             ← mt-6 gap from user div
┌─────────────────────────────────────────────────────────┐
│ ● Received update from team-lead                      ▸ │  ← user div (mt-6 mb-1 + group hover)
└─────────────────────────────────────────────────────────┘
                                                             ← gap before next assistant div
┌─────────────────────────────────────────────────────────┐
│ The team has finished the animation work...              │  ← assistant div
└─────────────────────────────────────────────────────────┘

DESIRED BEHAVIOR:
┌─────────────────────────────────────────────────────────┐
│ Assistant text block                                    │
│ ● Read file.tsx                                         │
│ ● Edited file.tsx                                       │
│ ● Received update from team-lead                      ▸ │  ← feels like another tool call
│ The team has finished the animation work...              │
└─────────────────────────────────────────────────────────┘
```

---

## Options

### Option A: Detect teammate messages in Chat.tsx and suppress user styling

**Approach**: In the `visibleMessages.map()` rendering loop in Chat.tsx, detect when a user message is a teammate message and skip the `mt-6 mb-1` spacing and `group` class.

**Implementation**:
1. Export `parseTeammateMessage` from `message-bubble.tsx` (or move to a shared util)
2. In Chat.tsx, add the import and use it in the render loop:
   ```tsx
   const isTeammateMsg = msg.role === 'user' && isTeammateMessage(msg);
   <div
     key={msg.id}
     className={cn(
       msg.role === 'user' && !isTeammateMsg ? "group mt-6 mb-1" : "",
       msg.role !== 'user' ? "group" : ""
     )}
   >
   ```

**Pros**:
- Minimal change (3-5 lines in Chat.tsx, 1 export)
- No architectural changes
- TeammateMessage component unchanged

**Cons**:
- Requires parsing the message content twice (once in Chat.tsx for detection, once in MessageBubble for rendering)
- Adds teammate-specific knowledge to Chat.tsx which currently doesn't know about message content types
- The detection function needs to duplicate or import the regex/parsing from message-bubble.tsx

---

### Option B: Add an `isTeammateMessage` flag to the Message type

**Approach**: When messages arrive (from initial load or SDK events), detect teammate messages and flag them on the Message object. Chat.tsx uses the flag for styling.

**Implementation**:
1. Add `isTeammateMessage?: boolean` to the `Message` interface in `types.ts`
2. In Chat.tsx `parsedInitialMessages` useMemo, detect and flag teammate messages
3. In Chat.tsx SDK event handler for `user` type events, detect and flag
4. In the rendering loop, use the flag:
   ```tsx
   className={cn(
     "group",
     msg.role === 'user' && !msg.isTeammateMessage ? "mt-6 mb-1" : ""
   )}
   ```

**Pros**:
- Detection happens once per message, not on every render
- Chat.tsx uses a simple boolean check, no content parsing in the render loop
- Flag available for any future teammate-specific behavior

**Cons**:
- Modifies the shared `Message` type for a UI-only concern
- Must detect in multiple places (initial load + streaming)
- More moving parts than Option A

---

### Option C: Merge teammate messages into the preceding assistant message (Recommended)

**Approach**: In the message normalization pipeline (`normalizeToolResultMessages` or a new step), when a user message is detected as a teammate message, remove it from the message list and instead append a synthetic `tool_use` block (or a special content block) to the preceding assistant message. This way the teammate message is rendered as part of the assistant's content, just like tool calls.

**Implementation**:
1. Create a new normalization function `mergeTeammateMessages(messages: Message[]): Message[]` that:
   - Iterates through messages
   - When it finds a user message that matches the teammate-message regex:
     - Removes it from the list
     - Appends a `{ type: 'teammate_message', teammateId, content }` block to the preceding assistant message's content array
   - Returns the modified message list
2. Add `TeammateMessageBlock` to the `ContentBlock` union type (or use a tagged object approach)
3. In Chat.tsx, pipe through the new normalizer: `normalizeToolResultMessages(messages)` → `mergeTeammateMessages(result)`
4. In `MessageBubble`, handle the new block type in the assistant content rendering loop (right where `tool_use`, `tool_result`, and `thinking` blocks are handled)
5. Remove the teammate detection from the user-message branch of MessageBubble

**Pros**:
- Teammate messages genuinely become part of the assistant message — no spacing hack needed
- Hover actions on the assistant message naturally cover the teammate update
- Follows the existing `normalizeToolResultMessages` pattern (user-role tool results are already merged into assistant messages)
- The rendering in MessageBubble becomes simpler: teammate blocks are just another content block type alongside tool_use/tool_result/thinking
- No content parsing in the render loop

**Cons**:
- More invasive: touches the type system, normalization pipeline, and rendering
- Adds a new content block type (though this is well-scoped)
- Need to handle the edge case where there's no preceding assistant message

---

### Option D: Use the existing `isMeta` pattern

**Approach**: Mark teammate messages as `isMeta` so they're filtered out of `visibleMessages`, then attach them to the preceding assistant message's rendering via a different mechanism (similar to how skill sheet meta messages work).

**Implementation**:
1. In Chat.tsx SDK event handler, detect teammate messages and set `isMeta: true`
2. For initial messages, add a normalization step that flags them
3. Modify the rendering to include teammate messages inline with the preceding assistant message

**Pros**:
- Reuses existing `isMeta` infrastructure

**Cons**:
- `isMeta` currently means "hidden entirely" — teammate messages should be visible, not hidden
- Would need significant changes to how `isMeta` messages are surfaced
- Overloads the meaning of `isMeta`

---

## Recommendation: Option C

Option C is the cleanest solution because it mirrors what already works for tool results. The existing `normalizeToolResultMessages` already moves user-role messages (containing tool results) into assistant messages so they render inline. Teammate messages are exactly the same pattern: a user-role message that should appear inline with the assistant's work.

The key insight: **tool result messages are `role: "user"` but render inside assistant messages. Teammate messages should follow the exact same pattern.**

---

## Detailed Design for Option C

### 1. New content block type

Add to `src/types.ts`:

```typescript
export interface TeammateMessageBlock {
  type: 'teammate_message';
  teammateId: string;
  content: string;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock | TeammateMessageBlock;
```

### 2. Normalization function

New function in `src/lib/streaming.ts`:

```typescript
export function mergeTeammateMessages(messages: Message[]): Message[] {
  const result: Message[] = [];

  for (const msg of messages) {
    if (msg.role !== 'user') {
      result.push(msg);
      continue;
    }

    // Extract raw text to check for teammate message
    const rawText = typeof msg.content === 'string'
      ? msg.content
      : msg.content
          .map(block => (block.type === 'text' ? block.text : ''))
          .filter(Boolean)
          .join('\n');

    const parsed = parseTeammateMessage(rawText);
    if (!parsed) {
      result.push(msg);
      continue;
    }

    // Find the last assistant message to attach to
    const lastAssistantIndex = findLastIndex(result, m => m.role === 'assistant');
    if (lastAssistantIndex === -1) {
      // No preceding assistant message — render as standalone
      // (unlikely in practice, but safe fallback)
      result.push(msg);
      continue;
    }

    // Append teammate block to the assistant message's content
    const assistantMsg = result[lastAssistantIndex];
    const existingContent = Array.isArray(assistantMsg.content)
      ? assistantMsg.content
      : [{ type: 'text' as const, text: assistantMsg.content }];

    const teammateBlock: TeammateMessageBlock = {
      type: 'teammate_message',
      teammateId: parsed.teammateId,
      content: parsed.content,
    };

    result[lastAssistantIndex] = {
      ...assistantMsg,
      content: [...existingContent, teammateBlock],
    };
  }

  return result;
}
```

### 3. Chat.tsx pipeline change

```typescript
const normalizedMessages = useMemo(
  () => mergeTeammateMessages(normalizeToolResultMessages(messages)),
  [messages]
);
```

### 4. MessageBubble rendering

In the assistant content rendering loop (where `tool_use`, `tool_result`, `thinking` are handled), add:

```tsx
case 'teammate_message':
  return (
    <TeammateMessage
      key={`teammate-${index}`}
      teammateId={block.teammateId}
      content={block.content}
    />
  );
```

### 5. Clean up MessageBubble user branch

Remove the teammate message detection from the user-message branch of `MessageBubble` since teammate messages will no longer arrive as user messages in `visibleMessages`.

Keep the `parseTeammateMessage` and `stripTeammateMessageTags` functions — move `parseTeammateMessage` to a shared location since it's now used by both `message-bubble.tsx` (for `contentToString`) and `streaming.ts` (for normalization).

### 6. Files changed

| File | Change |
|------|--------|
| `src/types.ts` | Add `TeammateMessageBlock` to `ContentBlock` union |
| `src/lib/streaming.ts` | Add `mergeTeammateMessages()` function |
| `src/components/Chat.tsx` | Pipe through `mergeTeammateMessages` in useMemo |
| `src/components/message-bubble.tsx` | Handle `teammate_message` block in assistant rendering, remove user-branch detection, export/move `parseTeammateMessage` |
| `src/lib/teammate-message.ts` | **New** — shared `parseTeammateMessage` + `stripTeammateMessageTags` (moved from message-bubble.tsx) |

### 7. Edge cases

| Case | Handling |
|------|----------|
| No preceding assistant message | Keep as user message (falls through to normal rendering with stripped XML) |
| Multiple teammate messages in sequence | Each gets merged into the last assistant message as separate blocks |
| Teammate message between two assistant messages | Merged into the preceding (earlier) assistant message |
| `contentToString` for copy | Still uses `stripTeammateMessageTags` — unchanged behavior |
| `isTeammateMessage` content blocks in type guards | Add `'teammate_message'` to the `isContentBlock` check in Chat.tsx |

### 8. Acceptance criteria

- [ ] Teammate messages appear inline with the preceding assistant message (no extra spacing)
- [ ] No `mt-6 mb-1` gap around teammate messages
- [ ] No orphaned hover action row on teammate messages
- [ ] Teammate messages still expand/collapse identically to before
- [ ] Regular user messages unaffected
- [ ] Copy functionality still strips teammate XML tags
- [ ] Build passes cleanly
