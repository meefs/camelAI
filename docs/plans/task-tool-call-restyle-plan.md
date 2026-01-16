# Task Tool Call Restyle Plan

## Overview

Restyle the Task tool call so streaming and refreshed views match, and so streaming results do not flood the UI. The plan aligns the streaming message model with the persisted JSONL grouping logic, then adds a Task-specific summary + progress display that stays minimal and consistent with the existing tool-call UX.

Using the shadcn-components skill because this plan defines UI changes using shadcn primitives.

---

## Problem Summary

- Streaming view shows repeated tool_result entries as separate tool calls, crowding the chat.
- After refresh, tool calls collapse into a clean, grouped assistant message.
- The streaming UI and refreshed UI diverge because tool_use and tool_result blocks are not consistently grouped during streaming.

---

## Goals

1. Streaming and refreshed messages render identically.
2. Task tool calls show a calm, single-line summary; no spammy tool_result list.
3. Progress updates are tied to the Task tool call (count + latest preview), not separate tool calls.

## Non-goals

- No changes to the Claude SDK behavior.
- No new backend APIs.
- No rework of non-Task tool call layouts.

---

## UI Proposal (ASCII)

### Collapsed Task Tool Call (streaming)

+---------------------------------------------------------------------+
| o Agent: Explore codebase structure                    3 results  > |
+---------------------------------------------------------------------+

### Collapsed Task Tool Call (complete)

+---------------------------------------------------------------------+
| o Agent: Explore codebase structure                    5 results  > |
+---------------------------------------------------------------------+

### Expanded Task Tool Call (complete)

+---------------------------------------------------------------------+
| o Agent: Explore codebase structure                    5 results  v |
|   Agent: Explore                                                    |
|   Description: Explore codebase structure                            |
|   Prompt: Explore the current working directory...                   |
|                                                                     |
|   Results (5 total)                                                  |
|   Latest result: "Found 6 projects under /home/claude"               |
|                                                                     |
|   Result                                                            |
|   +---------------------------------------------------------------+ |
|   | Full result text (scrollable, truncated preview by default)   | |
|   +---------------------------------------------------------------+ |
+---------------------------------------------------------------------+

### Message Grouping (streaming vs refresh)

Before (streaming):
  Assistant A: [tool_use task_1]
  Assistant B: [tool_use task_2]
  User:        [tool_result task_1]
  User:        [tool_result task_2]
  -> UI shows 4 tool entries (spam)

After (normalized):
  Assistant A (grouped):
    [tool_use task_1, tool_use task_2, tool_result task_1, tool_result task_2]
  -> UI shows 2 tool calls, each with its own result

---

## Behavior Requirements

- Streaming view uses the same tool_use + tool_result grouping as the refreshed JSONL path.
- Task tool_result blocks are always attached to their matching tool_use, even when they arrive as separate user events.
- If multiple Task tool_result updates arrive (progress), show only:
  - Count label in the summary line (plain text, no badge).
  - Latest result preview in details.
  - Full list only on explicit expand (optional, capped to last N).

---

## Data and Grouping Plan

### 1) Build a Task tool call view model

Create a derived view model that unifies tool_use + tool_result + progress updates:

ToolCallView:
  - tool_use_id
  - tool (ToolUseBlock)
  - result (ToolResultBlock | null)
  - progressCount (number)
  - latestProgressText (string | null)

This keeps rendering consistent for streaming and persisted messages.

### 2) Normalize streaming events to match refresh grouping

Mirror the grouping logic from `workers/main/src/rpc-service.ts#getMessages`:

- When a tool_result arrives, append it to the most recent assistant segment or to the assistant message that owns the tool_use_id.
- Do not render tool_result-only blocks as separate tool calls if a tool_use exists anywhere in the current assistant group.
- Use this normalization step in `Chat.tsx` so the streaming UI matches the refreshed UI exactly.

---

## Component and Styling Plan (shadcn/ui)

Use existing primitives where possible:

- Collapsible (already used in ToolCall)
- ScrollArea (optional for long result previews)
- Separator (lightweight section divider inside expanded details)
- Tooltip (optional for "3 results" hover)

No new component installs required.

---

## File-Level Implementation Plan

### Phase 1: Normalize tool call grouping

1. Add a message normalization helper (client-side):
   - Suggested file: `src/lib/streaming.ts` or a new `src/lib/tool-call-normalize.ts`.
   - Input: Message[] (streaming state).
   - Output: Message[] or ToolCallView[] with tool_use + tool_result merged.

2. Update `Chat.tsx` streaming event handling:
   - On tool_result, attach to the correct assistant message by tool_use_id.
   - If not found, attach to the most recent assistant message (match server grouping behavior).

3. Update `MessageBubble` rendering:
   - When rendering tool_result blocks, suppress standalone Task tool_result items if a matching Task tool_use exists in the same assistant group.

### Phase 2: Task tool call summary restyle

1. Update `src/components/tool-call/tool-call.tsx`:
   - Allow Task-specific summary content (inline results count text).
   - Keep default minimal layout for other tools.

2. Update `src/components/tool-call/tool-summary.ts`:
   - For Task: add results count label and "Agent: {description}" summary.
   - Keep existing summary logic for all other tools.

3. Update `src/components/tool-call/details/task-details.tsx`:
   - Add "Results (count)" row + "Latest result" preview.
   - Keep result output in OutputBlock.
   - Cap preview length (e.g., first 3-6 lines) to avoid huge details.

### Phase 3: Visual polish + consistency

1. Ensure summary line truncation:
   - Description should truncate before pushing the results count off-screen on mobile.

2. Ensure status alignment:
   - Status is conveyed only via the existing dot (pulsing blue while running, static green when complete).
   - No running/complete badges or extra status labels.
   - Results count sits immediately left of the chevron, in muted text (faded).

---

## Acceptance Criteria

- Streaming and refreshed views match for the same thread (no tool_result spam).
- Task tool calls show a single summary line with "X results" count.
- Task tool call details show latest result + final result without flooding.
- Non-Task tool calls remain unchanged.
- No status badges appear; status uses the existing dot only.

---

## Suggested Test Pass

1. Reproduce the parallel Task tool call scenario.
2. Verify streaming view has:
   - 1 assistant message with multiple Task tool calls.
   - No separate tool_result-only entries.
3. Refresh page and confirm identical layout.
4. Expand Task tool call and confirm:
   - "Updates (X)" count.
   - Latest preview shown.
   - Result block present and scrollable.
