# Task Notification Tool-Call Integration Plan (Technical Audit)

## Scope

This plan covers **technical behavior only** for task notifications:
- Parse SDK `<task-notification>` user messages
- Normalize them into assistant content blocks
- Render them as tool-call rows inline with assistant flow

This plan does **not** redefine visual design.

---

## Goal

Task notifications must:
1. Render like assistant tool calls (not user bubbles)
2. Stay inline with assistant flow (no user-message spacing break)
3. Work for both history load (JSONL) and live streaming
4. Never expose raw `<task-notification>` XML to users

---

## Current Behavior (Validated)

1. History path:
- `src/lib/chat-jsonl-parser.ts` keeps task notifications as normal `role: "user"` messages.
- They render as user bubbles with raw XML.

2. Live path:
- In `src/components/Chat.tsx`, non-`tool_result` SDK `user` events are stored as `isMeta: true`.
- `visibleMessages` filters meta messages, so task notifications are hidden.

3. Existing normalization:
- `normalizeToolResultMessages` and `mergeTeammateMessages` already use the correct pattern for converting user-role protocol artifacts into assistant-rendered blocks.

---

## Technical Findings From Audit

1. Parser in previous draft was too brittle
- Required strict tag order/shape.
- Could break if SDK adds/reorders tags.

2. Previous fallback conflicted with requirements
- It allowed raw XML user bubbles when no preceding assistant message existed.
- That violates “never show raw XML.”

3. Previous live-handler change was unnecessary risk
- Special-casing task notifications in the SDK event branch adds complexity.
- We can reuse existing meta-message ingest and solve this entirely in normalization.

4. Type guard gap
- `isContentBlock` in `Chat.tsx` must include any new content-block type to avoid future parse regressions.

---

## Recommended Architecture

Use the same 3-layer architecture as teammate messages:
1. Parse notification payload
2. Normalize user notification messages into assistant message blocks
3. Render notification block as a tool-call row

Key implementation choice:
- **Do not change live SDK event handling logic.**
- Keep current `sdkEvent.type === 'user'` behavior.
- Add normalization pass that consumes both normal and meta user notifications.

---

## Data Model Changes

**File:** `src/types.ts`

Add:

```ts
export interface TaskNotificationBlock {
  type: 'task_notification';
  taskId: string;
  outputFile: string;
  status: string;
  summary: string;
}
```

Extend:

```ts
export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | TeammateMessageBlock
  | TaskNotificationBlock;
```

Also update type guards that enumerate block types:
- `src/components/Chat.tsx` (`isContentBlock`)

---

## Parser

**New file:** `src/lib/task-notification.ts`

Required API:
- `parseTaskNotification(rawContent: string): ParsedTaskNotification | null`
- `parseTaskNotificationFromContent(content: string | ContentBlock[]): ParsedTaskNotification | null`

Implementation rules:
1. Strip `<chiridion system message>...</chiridion system message>`.
2. Require a `<task-notification>...</task-notification>` envelope.
3. Allow optional trailing SDK instruction line:
   - `Read the output file to retrieve the result: ...`
4. Reject messages that have unrelated leading/trailing text to avoid false positives.
5. Parse tags independently (`task-id`, `output-file`, `status`, `summary`) instead of relying on a single strict regex.
6. Normalize status to lowercase for rendering logic.

Minimal parser shape:

```ts
interface ParsedTaskNotification {
  taskId: string;
  outputFile: string;
  status: string;
  summary: string;
}
```

---

## Normalization

**File:** `src/lib/streaming.ts`

Add:
- `mergeTaskNotifications(messages: Message[]): Message[]`

Behavior:
1. Iterate through messages.
2. For each `role: 'user'` message, attempt parse with `parseTaskNotificationFromContent(msg.content)`.
3. If not a notification, keep as-is.
4. If notification:
   - Remove the original user/meta message from output.
   - Append `{ type: 'task_notification', ... }` to the nearest preceding assistant message content.
5. If no preceding assistant message exists:
   - Create a synthetic assistant message with only the `task_notification` block.
   - Use original `thread_id` and `created_at`.
   - This prevents raw XML from ever rendering.

Pseudo-flow:

```ts
normalized = normalizeToolResultMessages(messages);
normalized = mergeTeammateMessages(normalized);
normalized = mergeTaskNotifications(normalized);
```

Do not mutate `normalizeToolResultMessages` behavior.

---

## Chat Pipeline Wiring

**File:** `src/components/Chat.tsx`

Update normalized pipeline only:

```ts
const normalizedMessages = useMemo(
  () => mergeTaskNotifications(mergeTeammateMessages(normalizeToolResultMessages(messages))),
  [messages]
);
```

No live-handler special case required for task notifications.

Rationale:
- Live notifications are already inserted into `messages` (currently as meta user messages).
- Normalization runs before `visibleMessages` filtering and can consume them there.

---

## Rendering

### 1. Task notification row component

**New file:** `src/components/tool-call/task-notification.tsx`

Requirements:
- Use existing tool-call row structure/classes (`tool-call`, `group/toolcall`, collapsible behavior).
- Display summary in collapsed state.
- Dot color derived from status:
  - green: `completed`/`success`
  - red: `failed`/`error`
  - neutral fallback: unknown status
- Expanded details show:
  - Status
  - Task ID
  - Output file path (via `FileLink` when usable, plain text fallback otherwise)

### 2. Content renderer integration

**File:** `src/components/message-bubble.tsx`

Add `task_notification` case in `ContentBlockRenderer` with `kind: 'tool'`.

### 3. Copy support

**File:** `src/components/message-bubble.tsx`

Update `contentToString`:

```ts
if (block.type === 'task_notification') return `[Task ${block.status}] ${block.summary}`;
```

---

## Tests (Required)

Add focused unit tests so handoff implementation is safe:

1. `tests/task-notification-parser.test.ts`
- Parses valid SDK payload with trailing “Read the output file...” line
- Rejects unrelated wrapper text (false-positive guard)
- Handles multiline summary

2. `tests/task-notification-merge.test.ts`
- Merges user notification into preceding assistant message
- Merges meta notification (`isMeta: true`) into preceding assistant message
- Synthesizes assistant message when no preceding assistant exists
- Leaves regular user messages unchanged

3. `tests/message-bubble-content-to-string.test.ts`
- Add serialization case for `task_notification` block

Run:
- `bun run test:run`
- Optional targeted run for new tests first

---

## Edge Cases and Handling

| Case | Handling |
|---|---|
| Notification arrives as meta user message in live stream | Normalizer consumes it before `visibleMessages` filter |
| No preceding assistant message | Create synthetic assistant message with one `task_notification` block |
| Malformed XML | Parser returns null; message follows existing behavior |
| User intentionally pastes literal XML snippet | False-positive guard rejects unless shape matches SDK notification payload |
| Multiple notifications in sequence | Each appends as an additional block to the same preceding assistant message |
| Unknown status value | Neutral dot color + raw status in details |

---

## File Change Summary

| File | Change |
|---|---|
| `src/types.ts` | Add `TaskNotificationBlock`; extend `ContentBlock` union |
| `src/lib/task-notification.ts` | New parser utility |
| `src/lib/streaming.ts` | Add `mergeTaskNotifications` |
| `src/components/Chat.tsx` | Add merge pass to normalization pipeline; update `isContentBlock` guard |
| `src/components/tool-call/task-notification.tsx` | New render component |
| `src/components/message-bubble.tsx` | Render new block + copy serialization |
| `tests/task-notification-parser.test.ts` | New |
| `tests/task-notification-merge.test.ts` | New |
| `tests/message-bubble-content-to-string.test.ts` | Add case |

---

## Implementation Order

1. Types + parser utility
2. `mergeTaskNotifications` normalizer
3. Wire Chat pipeline
4. Add task-notification component
5. Integrate into `message-bubble.tsx`
6. Add/update tests
7. Run tests and typecheck

---

## Acceptance Criteria

- [ ] Task notifications render as tool-call rows, not user bubbles
- [ ] Task notifications are visible in both history and live streaming
- [ ] Task notifications do not interrupt assistant flow spacing
- [ ] Raw `<task-notification>` XML is never shown to end users
- [ ] Expanded details include status, task ID, and output-file path
- [ ] Notifications serialize cleanly in copy output
- [ ] Existing teammate-message and tool-result behavior remains unchanged
- [ ] Unit tests for parser and merge behavior are added and passing

