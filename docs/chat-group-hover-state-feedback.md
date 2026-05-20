# Chat Group Hover State Implementation Feedback

## Findings

### 1. Completed-chat summaries are raw assistant text, not generated summaries

**Severity:** Blocking

Completed rows currently render `last_assistant_summary`, but the value is produced by taking the latest assistant/result text and running it through a string normalizer:

- [workers/main/src/durable-objects.ts](../workers/main/src/durable-objects.ts#L8983) passes Pi `finalText` directly as `summary`.
- [workers/main/src/durable-objects.ts](../workers/main/src/durable-objects.ts#L9376) uses `latestAssistantText || streamingText` directly.
- [workers/main/src/durable-objects.ts](../workers/main/src/durable-objects.ts#L9404) uses `event.result` directly.
- [src/lib/thread-preview.ts](../src/lib/thread-preview.ts#L57) only strips wrappers/collapses whitespace/truncates; it does not summarize.
- [workers/main/src/auth.ts](../workers/main/src/auth.ts#L5464) persists that normalized raw text.

This does not satisfy the spec. Completed chats need an AI-generated summary of what the agent did, capped for a two-line UI treatment. The current implementation can show a verbose final answer, a partial stream buffer, or unrelated result text.

**Recommended fix:**

- Add a dedicated completion-summary generator, parallel to [src/lib/thread-title-generation.server.ts](../src/lib/thread-title-generation.server.ts), using the same Cloudflare AI Gateway/OpenAI client pattern.
- Add a prompt that summarizes completed coding-agent work into one short user-facing summary. It should explicitly avoid transcript-like detail, tool noise, and raw output dumps.
- Persist completion immediately with `last_assistant_completed_at` and `last_assistant_summary = null`, then run summary generation in `waitUntil` and fill `last_assistant_summary` with a summary-only update once ready. Do not block unread/status broadcast on the model call.
- Keep `normalizeThreadCompletionSummary` only as a final sanitizer/clamp for generated output, not as the source of truth.

For the source text, do not summarize the whole transcript. Extract the final conclusion artifact first:

- Prefer the final user-visible conclusion from the current turn's persisted JSONL/message history, scanning from the tail.
- Ignore reasoning, tool calls, and intermediate tool output.
- If the final JSONL item is a tool result that represents the agent's final conclusion, extract that tool result content and feed only that content to the summarizer.
- For Pi, use the already available final `event.messages` / `pi_core_messages` shape rather than `this.piAssistantText` alone.
- For legacy Claude/Codex, reuse the existing JSONL/message parsing path (`readThreadMessagesStream` / parsed messages) or add a focused helper that can read the last meaningful assistant/tool-result item by session id.

Add tests that fail with the current implementation:

- The completion path calls the summary generator and stores generated text, not raw final text.
- Tail extraction skips tool-call noise and selects the final conclusion/tool result.
- A missing/failed summary generation leaves the chat completed/unread with `last_assistant_summary = null` and does not break status updates.

### 2. Closed-thread hover clicks navigate even when reopen fails

**Severity:** Medium

In [src/components/sidebar/app-sidebar.tsx](../src/components/sidebar/app-sidebar.tsx#L86), the closed-thread path logs a failed reopen response but still revalidates and navigates at lines 98-99. If the reopen endpoint fails because of stale membership, permissions, or a network issue, the user lands on `/chat/:threadId?group=:groupId` while the thread can still be closed in that group.

**Recommended fix:** only navigate after `response.ok`. On failure, keep the user where they are and surface/log the failure. At minimum, `return` after logging a non-OK response.

### 3. The backend plan doc was expanded into UI/style guidance

**Severity:** Low

[docs/chat-group-hover-state-backend-plan.md](./chat-group-hover-state-backend-plan.md) was originally meant to be backend-only with UI gaps. It now includes detailed UI implementation and styling guidance. If this doc is included in the PR, either revert it to the backend-only version or move the UI section into a separate UI plan owned by the UI agent.

### 4. Quiet-row title font is too large

**Severity:** Medium

In [src/components/sidebar/chat-group-hover-card.tsx:209](../src/components/sidebar/chat-group-hover-card.tsx), the quiet row title uses `text-sm`. The subheader text (running snippets, completed summaries) and all timestamps use `text-xs`. The quiet section should read as visually de-emphasized — its title should match the smaller `text-xs` size, not the prominent `text-sm` of the active sections.

**Recommended fix:**

In `QuietRow`, change the title span:

```tsx
// before
<span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
  {thread.title || "New chat"}
</span>

// after
<span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
  {thread.title || "New chat"}
</span>
```

Leave `InProgressRow` and `CompletedRow` titles at `text-sm font-medium` — those sections stay prominent.

### 5. Subheader and quiet-row indents are wrong

**Severity:** Medium

Three related alignment bugs in [src/components/sidebar/chat-group-hover-card.tsx](../src/components/sidebar/chat-group-hover-card.tsx):

- Line 171 (`InProgressRow` subheader) uses `pl-4`, indenting the latest-user-message snippet under the title text.
- Line 196 (`CompletedRow` subheader) uses `pl-4`, indenting the summary under the title text.
- Line 208 (`QuietRow`) renders a `size-1.5 shrink-0` invisible spacer to reserve the dot-column. Quiet rows should have no dot column at all.

Intended layout:

- The status dot is the only thing that indents — and only on the **title row** of in-progress and completed items.
- The **subheader** (latest user message / summary) returns to the row's left edge, in line with the section label ("IN PROGRESS" / "COMPLETED").
- **Quiet rows** are completely flush left — no dot, no spacer, no indent. The title aligns with the section label.

ASCII before/after:

```
[ current (wrong) ]                 [ target ]

IN PROGRESS                         IN PROGRESS
  ● Title                3m 23s       ● Title                  3m 23s
    something user said             something user said

COMPLETED                           COMPLETED
  ● Title                12m ago      ● Title                  12m ago
    Found 3 patterns:               Found 3 patterns:
    apex/root domain…               apex/root domain…

QUIET                               QUIET
    BYOK error rate       2h ago    BYOK error rate            2h ago
    Spanish-speaking       1d ago   Spanish-speaking           1d ago
```

**Recommended fix:**

In `InProgressRow`, drop `pl-4`:

```tsx
// before
{thread.latest_user_message && (
  <div className="truncate pl-4 text-xs text-muted-foreground">
    {thread.latest_user_message}
  </div>
)}

// after
{thread.latest_user_message && (
  <div className="truncate text-xs text-muted-foreground">
    {thread.latest_user_message}
  </div>
)}
```

In `CompletedRow`, drop `pl-4`:

```tsx
// before
{thread.last_assistant_summary && (
  <div className="line-clamp-2 pl-4 text-xs leading-snug text-muted-foreground">
    {thread.last_assistant_summary}
  </div>
)}

// after
{thread.last_assistant_summary && (
  <div className="line-clamp-2 text-xs leading-snug text-muted-foreground">
    {thread.last_assistant_summary}
  </div>
)}
```

In `QuietRow`, delete the invisible spacer entirely:

```tsx
// before
<div className="flex items-center gap-2">
  <span aria-hidden className="size-1.5 shrink-0" />
  <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
    {thread.title || "New chat"}
  </span>
  ...

// after
<div className="flex items-center gap-2">
  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
    {thread.title || "New chat"}
  </span>
  ...
```

(Apply this together with finding #4's `text-sm` → `text-xs` change.)

Update [tests/chat-group-hover-card.test.tsx](../tests/chat-group-hover-card.test.tsx) to assert:

- Subheaders no longer carry `pl-4`.
- Quiet rows do not render the `size-1.5` spacer span.
- Quiet titles are `text-xs`.

### 6. Sidebar chat-group row: chat count placement and hover behavior

**Severity:** Medium

Today, in [src/components/sidebar/chat-groups-list.tsx](../src/components/sidebar/chat-groups-list.tsx), each group row reserves space for the X close button (via the shadcn `SidebarMenuButton` rule `group-has-data-[sidebar=menu-action]/menu-item:pr-8` in [src/components/ui/sidebar.tsx:473](../src/components/ui/sidebar.tsx)). The chat count from `ChatGroupRightSlot` sits inside that available space, so it appears ~32px from the actual right edge, with the X close button to its right (visible on hover).

The chat count is also redundant — the hover popover always shows `N chats` in its header, so we don't need to show the same number twice in the sidebar.

Intended behavior:

- The chat count is **right-aligned to the row edge** (no reserved gutter for the X).
- On row hover, the X close button **occludes / replaces the count** in the same visual slot. The X does not push the count or sit next to it.
- The status indicator (Loader2 for running, red dot for unread) stays where it is — only the numeric count is affected.

**Recommended fix:**

Two changes in [src/components/sidebar/chat-groups-list.tsx](../src/components/sidebar/chat-groups-list.tsx):

1. Override the reserved `pr-8` on the `SidebarMenuButton` so the right-slot content sits flush with the row edge. Add `!pr-2` (or equivalent) to the existing className passed in around line 173:

```tsx
className={cn(
  "group/chat-group cursor-pointer gap-2 select-none !pr-2", // <- add !pr-2
  "group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:[&_*]:pointer-events-none group-data-[collapsible=icon]:[&_*]:cursor-pointer",
  dragOverGroupId === group.id && "bg-sidebar-accent/50",
  dragOverGroupId === group.id &&
    "group-data-[collapsible=icon]:bg-sidebar-accent group-data-[collapsible=icon]:ring-2 group-data-[collapsible=icon]:ring-blue-500 group-data-[collapsible=icon]:ring-offset-1",
)}
```

2. Fade the count out on row hover so the X (which is `absolute right-1 top-1`) appears in the same space. In `ChatGroupRightSlot` ([chat-groups-list.tsx:80-97](../src/components/sidebar/chat-groups-list.tsx)), add a hover-fade on the count span only — keep the status indicator visible:

```tsx
// before
<span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs tabular-nums text-muted-foreground group-data-[collapsible=icon]:hidden">
  {status === "running" ? (
    <Loader2 ... />
  ) : status === "unread" ? (
    <span ... />
  ) : null}
  <span className="tabular-nums" aria-label={countLabel}>
    {count}
  </span>
</span>

// after
<span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs tabular-nums text-muted-foreground group-data-[collapsible=icon]:hidden">
  {status === "running" ? (
    <Loader2 ... />
  ) : status === "unread" ? (
    <span ... />
  ) : null}
  <span
    className="tabular-nums transition-opacity group-hover/menu-item:opacity-0 group-has-[[data-state=open]]/menu-item:opacity-0"
    aria-label={countLabel}
  >
    {count}
  </span>
</span>
```

Notes:

- `group-hover/menu-item:opacity-0` matches the existing pattern that reveals the X via `group-hover/menu-item:opacity-100` ([chat-groups-list.tsx:226](../src/components/sidebar/chat-groups-list.tsx)).
- Add `group-has-[[data-state=open]]/menu-item:opacity-0` so the count also hides while the hover popover is open (so the X sits cleanly over the slot during the hover-into-popover flow).
- Do not hide the running spinner / unread dot — those are status signals, not the numeric count. The X overlaps them visually but they're informative even when partially covered, and they only render when there's something to show.
- `aria-label` on the count remains for screen readers; opacity-0 keeps it in the accessibility tree.
- Sanity-check the collapsed sidebar state (`group-data-[collapsible=icon]`): the right slot is already hidden via `group-data-[collapsible=icon]:hidden`, so the count fade is a no-op in collapsed mode — no regression risk.

## Verification Run

These passed locally:

```bash
bun run test:run -- tests/thread-preview.test.ts tests/chat-groups-ui.test.tsx tests/chat-group-hover-card.test.tsx tests/chat-group-hover-time.test.ts
bun run test:workers -- workers/main/tests/auth-do.test.ts
bun run typecheck
```
