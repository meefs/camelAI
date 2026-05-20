# Chat Group Hover State — Plan

**Date:** 2026-05-19
**Scope:** end-to-end plan for the chat group hover popover. Backend sections (Backend Contract through Live Status Updates) define the data contract; the UI Implementation section defines the popover component, layout, behavior, and styling.

## Objective

Add enough reliable data to the existing chat group sidebar pipeline for a hover popover to show every chat in a group, sectioned as:

- `running` -> In progress
- `unread` -> Completed
- `idle` -> Quiet

The backend should provide titles, timestamps, status, latest user-message snippets for running chats, persisted completion summaries for unread completed chats, and membership information for click/open behavior. It should not make styling decisions.

## Current State

Relevant existing files:

- [src/lib/chat-groups.server.ts](../src/lib/chat-groups.server.ts) hydrates `ChatGroupView` for the app layout loader.
- [src/routes/_app.tsx](../src/routes/_app.tsx) loads `chatGroups` once for the authenticated layout.
- [src/hooks/use-chat-groups.tsx](../src/hooks/use-chat-groups.tsx) merges loader data with live workspace status socket state.
- [src/components/sidebar/chat-groups-list.tsx](../src/components/sidebar/chat-groups-list.tsx) renders group rows.
- [workers/main/src/auth.ts](../workers/main/src/auth.ts) stores thread records in `OrgDO` and per-user group membership/view timestamps in `UserDO`.
- [workers/main/src/workspace.ts](../workers/main/src/workspace.ts) broadcasts `thread_status` and `thread_status_snapshot` frames.
- [workers/main/src/durable-objects.ts](../workers/main/src/durable-objects.ts) records user-message activity and assistant completion.

What already exists:

- Per-user chat groups with open and closed member IDs.
- Per-thread viewed timestamps in `UserDO`.
- Workspace status socket updates for running/unread/idle.
- Thread title, model/provider, `updated_at`, `first_user_message`, and `user_message_count`.
- Assistant completion already updates thread activity and emits an unread status.

Missing for the hover:

- Latest user-sent message, not just first user message.
- Durable assistant completion timestamp distinct from generic `updated_at`.
- Durable completion summary for the completed/unread section.
- Thread membership (`open` vs `closed`) on the hydrated item.
- Local/live metadata overlay for `completedAt` and latest user message while loader data is stale.
- A future-compatible slot for the running timer without implementing the timer source in this PR.

## Backend Contract

Extend the sidebar group thread payload, keeping existing status names:

```ts
export interface ChatGroupThreadSummary {
  id: string;
  title: string;
  model: LlmModel;
  provider: ChatHarness;
  updated_at: number;
  status: "idle" | "running" | "unread";
  is_unread?: boolean;

  // New hover plumbing
  membership: "open" | "closed";
  last_active_at: number;
  latest_user_message: string | null;
  last_assistant_completed_at: number | null;
  last_assistant_summary: string | null;

  // Reserved for the separate running-duration work.
  running_started_at: null;
}
```

Mapping for UI:

- In progress section: `status === "running"`.
- Completed section: `status === "unread"`.
- Quiet section: `status === "idle"`.
- Completed timestamp source: `last_assistant_completed_at ?? updated_at`.
- Quiet timestamp source: `last_active_at`.
- In-progress subheader source: `latest_user_message`.
- Completed subheader source: `last_assistant_summary`.
- Total count source: existing `member_count`.

Sorting should use backend-provided timestamps:

- Running: sort by `last_active_at` descending for this PR. Replace with future running-start metadata when the timer work lands.
- Completed: sort by `last_assistant_completed_at ?? updated_at` descending.
- Quiet: sort by `last_active_at` descending.

Sectioning is derived inside the hover component (see UI Implementation > Sectioning) from the flat thread list. The backend only needs to supply stable fields.

## Data Model Changes

Add an `OrgDO` migration after current schema version 25:

```sql
ALTER TABLE threads ADD COLUMN last_user_message TEXT;
ALTER TABLE threads ADD COLUMN last_assistant_completed_at INTEGER;
ALTER TABLE threads ADD COLUMN last_assistant_summary TEXT;
```

Implementation notes:

- Bump `CURRENT_SCHEMA_VERSION` in `OrgDO.migrate()`.
- Add the same columns to `ensureThreadSchemaColumns()` so older/partially migrated DOs self-heal.
- Extend fresh `CREATE TABLE threads` definitions only where this file has canonical table creation blocks.
- Keep all fields nullable for old threads.
- Do not add per-user persistence. The group is personal, but these thread metadata fields are canonical thread metadata and can be reused anywhere thread summaries are shown.

## Thread Metadata Recording

### Latest User Message

Add an `OrgDO` method, or extend `touchThread`, so the user-message path can atomically update:

- `updated_at`
- `user_message_count`
- `last_user_message`

Suggested method:

```ts
recordThreadUserMessage(id: string, message: string): OrgThread | null
```

Behavior:

- Normalize with the existing `normalizeThreadPreviewUserMessage` path so system tags, connection annotations, and author prefixes do not leak into the sidebar snippet.
- Clamp stored text to the same 500-character ceiling used by `first_user_message`.
- Increment `user_message_count` once per real user message.
- Set `first_user_message` only through the existing first-message path.
- Keep AdminIndex thread upsert behavior equivalent to the current `touchThread` path.

Wire this from [workers/main/src/durable-objects.ts](../workers/main/src/durable-objects.ts), inside `updateThreadMetadataForUserMessage`, replacing the current plain `touchThread(context.threadId)` call.

Also set `last_user_message` during thread creation when `firstUserMessage` is supplied in `OrgDO.createThread`.

### Assistant Completion Timestamp And Summary

Add an `OrgDO` method for assistant completion:

```ts
recordThreadAssistantCompletion(
  id: string,
  input: {
    completedAt: number;
    summary: string | null;
  },
): boolean
```

Behavior:

- Persist `last_assistant_completed_at`.
- Persist `last_assistant_summary` when non-empty.
- Update `updated_at` using the same monotonic clamp as `touchThreadActivity`.
- Do not increment `user_message_count`.
- Dispatch AdminIndex thread upsert with the new metadata.

Wire this from the existing `ChatThreadDO` assistant completion path:

- In `agent_end`, `finalText` is already available.
- Normalize `finalText` into a short completion summary and pass it to `recordThreadAssistantCompletion`.
- Continue broadcasting unread status through `recordWorkspaceThreadStreaming(..., false, { completedAt })`.

Summary source decision:

- Use the assistant's final result text as the first summary source. It is already AI-generated, avoids an extra model call on the hot completion path, and keeps the hover from depending on a background summarizer.
- Add a helper such as `normalizeThreadCompletionSummary(finalText)` that strips empty text, collapses whitespace, removes obvious operational wrappers, and clamps length.
- If product later wants a separate summarization pass, add it behind this helper and keep the stored field/hover contract unchanged.

Do not log `last_user_message` or `last_assistant_summary` into observability events.

## Unread Semantics

Today, `hydrateChatGroups` treats a thread as unread when `thread.updated_at > viewed_at`.

For the hover, Completed specifically means "assistant finished and the user has not read it." Update unread computation to prefer assistant completion metadata:

```ts
const completedAt = thread.last_assistant_completed_at;
const isUnread = !isRunning && !isOptimisticNewThreadRunning
  ? completedAt !== null
    ? completedAt > (viewedAtByThreadId[threadId] ?? 0)
    : thread.updated_at > (viewedAtByThreadId[threadId] ?? 0)
  : false;
```

This preserves old-thread fallback behavior while preventing future title/model edits from looking like agent completions.

`markThreadViewed` can stay unchanged because it records a timestamp high-water mark per user/thread.

## Chat Group Hydration

Update [src/lib/chat-groups.server.ts](../src/lib/chat-groups.server.ts):

- Extend `hydrateThreads`/`toThreadSummary` to include the new thread metadata.
- Add `membership: "open"` for `open_thread_ids` and `membership: "closed"` for `closed_thread_ids`.
- Set `last_active_at` to `Math.max(thread.updated_at, thread.last_assistant_completed_at ?? 0)`.
- Keep `member_count` as open plus closed threads.
- Keep `status` priority unchanged (`running > unread > idle`).
- Keep `running_started_at: null` until the separate running timer capability is available.

Do not add a separate hover API route for the initial implementation. The layout loader already hydrates visible groups, and keeping the hover data in `ChatGroupsProvider` means the popover can open immediately after the hover delay.

If payload size becomes a measured issue, add a lazy `GET /api/chat-groups/:id/hover` later with the same response shape.

## Live Status Updates

Update [src/hooks/use-chat-groups.tsx](../src/hooks/use-chat-groups.tsx):

- Parse optional `completedAt` from `thread_status` frames. `WorkspaceDO` already sends this for unread completions.
- Maintain a small local metadata map keyed by thread id:
  - `status`
  - `completedAt`
  - `latestUserMessage`
- Overlay these local fields onto loader-provided thread summaries in `applyLiveRunningStatuses`.
- Schedule a debounced revalidation on `running` frames for non-active threads so `latest_user_message` can refresh after `ChatThreadDO` records it.
- Keep the existing revalidation on `idle`/`unread` frames so completion timestamps and summaries refresh after assistant completion.

Update the local browser event from [src/components/Chat.tsx](../src/components/Chat.tsx):

- Extend `dispatchLocalThreadStatus` to optionally include `latestUserMessage`.
- When sending a user message, pass the normalized user-visible text with the local `running` event.
- Keep this as an optimistic overlay only. The persisted `OrgDO` value remains authoritative after revalidation.

When `latest_user_message === null`, the hover row renders the title row only and omits the subheader. See UI Implementation > Per-item rows.

## Click/Open Behavior

The backend already has the needed write endpoint for closed group members:

- `POST /api/chat-groups/:id/members/:threadId/reopen`

Expose `membership` in each hover item so the click handler can distinguish:

- `open`: navigate to `/chat/:threadId?group=:groupId`.
- `closed`: call the existing reopen endpoint, then navigate to `/chat/:threadId?group=:groupId`.

See UI Implementation > Click behavior for the client helper, optimistic update, and error handling. No new backend route is required.

## UI Implementation

### File layout

Add:

- [src/components/sidebar/chat-group-hover-card.tsx](../src/components/sidebar/chat-group-hover-card.tsx) — popover content + per-item rows, exports `ChatGroupHoverCard`.
- [src/lib/chat-group-hover-time.ts](../src/lib/chat-group-hover-time.ts) — shared time formatters: `formatHoverRelativeTime(ts)` and `formatRunningElapsed(startedAt, now)`.

Modify:

- [src/components/sidebar/chat-groups-list.tsx](../src/components/sidebar/chat-groups-list.tsx) — wrap each `SidebarMenuItem` in `<HoverCard>` and render `<ChatGroupHoverCard group={group} ... />` inside `<HoverCardContent>`.

Do **not** introduce a new shadcn primitive; reuse `HoverCard` from [src/components/ui/hover-card.tsx](../src/components/ui/hover-card.tsx) and `ScrollArea` from [src/components/ui/scroll-area.tsx](../src/components/ui/scroll-area.tsx).

### Primitive choice and grace period

Use shadcn `HoverCard` (Radix HoverCard). Radix HoverCard handles the leave-grace-period natively: when the cursor leaves the trigger, it stays open for the `closeDelay` and stays open if the cursor enters the content. This matches the spec interaction model exactly — do not implement a custom timer.

Why not Popover: Popover requires click-to-open and is a focus trap. HoverCard opens on hover/focus and does not trap focus, which is what we want for a peek.

### Hover mechanics

```tsx
<HoverCard openDelay={250} closeDelay={150}>
  <HoverCardTrigger asChild>
    <SidebarMenuButton ... />
  </HoverCardTrigger>
  <HoverCardContent
    side="right"
    align="start"
    sideOffset={8}
    collisionPadding={8}
    className="w-[20rem] p-0"
  >
    <ChatGroupHoverCard group={group} onSelectThread={...} />
  </HoverCardContent>
</HoverCard>
```

- `openDelay={250}` matches the existing usage in [src/components/connection-mention-menu/composer-mention-overlay.tsx:323](../src/components/connection-mention-menu/composer-mention-overlay.tsx). Short enough that intentional hovers feel responsive, long enough that drag/scroll past doesn't open every popover.
- `closeDelay={150}` gives the user time to move the cursor from the row into the popover content.
- `side="right"` so the popover opens to the right of the sidebar. When the sidebar is `collapsible="icon"` (collapsed), the trigger is the small icon row and `side="right"` still works.
- `collisionPadding={8}` keeps the popover off viewport edges.
- The popover content overrides default padding/width (`p-0 w-[20rem]`) because the default `p-2.5 w-72` from [src/components/ui/hover-card.tsx:35](../src/components/ui/hover-card.tsx) is too narrow for two-line summaries and we want to control padding per-region (header, sections).

### ASCII layout sketch

The popover follows the prototype: large group header at top with right-aligned chat count, then sections (In progress / Completed / Quiet) each with a small uppercase label and rows.

```
┌────────────────────────────────────────────────┐
│                                                │
│  support ticket analysis           5 chats     │  <- group header
│                                                │
│  IN PROGRESS                                   │  <- section label (uppercase, muted)
│  ● Check Org LLM Provider Conf…    3m 23s      │  <- title + running-timer slot
│    does the org 097d6ad5-22ca-4e9e-8a27…       │  <- latest_user_message (1 line truncate)
│                                                │
│  ● Categorize Q4 support tickets   58s         │
│    go ahead and run the categorization…        │
│                                                │
│  COMPLETED                                     │
│  ● Custom domain tickets — comm…   12m ago     │
│    Found 3 patterns: apex/root domain          │  <- summary, line-clamp-2
│    attempts (52%), missing CNAME (31%)…        │
│                                                │
│  QUIET                                         │
│    BYOK error rate analysis        2h ago      │  <- no dot, no subheader
│    Spanish-speaking user volume    yesterday   │
│                                                │
└────────────────────────────────────────────────┘

[ all-quiet variant ]                            [ single-in-progress variant ]
┌─────────────────────────────────────────┐      ┌────────────────────────────────────┐
│ investor follow-ups       4 chats       │      │ billing migration     2 chats      │
│                                         │      │                                    │
│ QUIET                                   │      │ IN PROGRESS                        │
│   Draft reply to a16z partner   3d ago  │      │ ● Stripe per-workspace…   1m 08s   │
│   Series A deck feedback        4d ago  │      │   model out pricing assuming…      │
│   YC demo day prep              1w ago  │      │                                    │
│   Tom Blomfield check-in note   1w ago  │      │ QUIET                              │
└─────────────────────────────────────────┘      │   BYOK provider setup docs  1h ago │
                                                 └────────────────────────────────────┘
```

### Component structure

```tsx
// src/components/sidebar/chat-group-hover-card.tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import type { ChatGroupThreadSummary, ChatGroupView } from "@/types";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  formatHoverRelativeTime,
  formatRunningElapsed,
} from "@/lib/chat-group-hover-time";

interface ChatGroupHoverCardProps {
  group: ChatGroupView;
  onSelectThread: (thread: ChatGroupThreadSummary) => void | Promise<void>;
}

export function ChatGroupHoverCard({ group, onSelectThread }: ChatGroupHoverCardProps) {
  const sections = useMemo(() => splitThreadsBySection(group), [group]);
  const total = group.member_count;
  const noun = total === 1 ? "chat" : "chats";

  return (
    <div className="flex flex-col">
      {/* Header */}
      <div className="flex items-baseline justify-between gap-3 px-3 pt-3 pb-2">
        <div className="min-w-0 flex-1 truncate text-sm font-semibold text-popover-foreground">
          {group.name}
        </div>
        <div className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {total} {noun}
        </div>
      </div>

      <ScrollArea className="max-h-[26rem]" viewportClassName="px-1 pb-2">
        {sections.inProgress.length > 0 && (
          <HoverSection label="In progress">
            {sections.inProgress.map((t) => (
              <InProgressRow key={t.id} thread={t} onSelect={onSelectThread} />
            ))}
          </HoverSection>
        )}
        {sections.completed.length > 0 && (
          <HoverSection label="Completed">
            {sections.completed.map((t) => (
              <CompletedRow key={t.id} thread={t} onSelect={onSelectThread} />
            ))}
          </HoverSection>
        )}
        {sections.quiet.length > 0 && (
          <HoverSection label="Quiet">
            {sections.quiet.map((t) => (
              <QuietRow key={t.id} thread={t} onSelect={onSelectThread} />
            ))}
          </HoverSection>
        )}
        {total === 0 && (
          <div className="px-2 py-3 text-xs text-muted-foreground">
            No chats in this group yet.
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
```

### Sectioning

Inside the popover, derive sections from a flat list of threads (open + closed) by `status`. Closed threads are eligible for any section — they keep showing up after closing so users can peek at them.

```ts
function splitThreadsBySection(group: ChatGroupView) {
  const all = [...group.open_threads, ...group.closed_threads];
  const inProgress = all
    .filter((t) => t.status === "running")
    .sort((a, b) => b.last_active_at - a.last_active_at);
  const completed = all
    .filter((t) => t.status === "unread")
    .sort(
      (a, b) =>
        (b.last_assistant_completed_at ?? b.updated_at) -
        (a.last_assistant_completed_at ?? a.updated_at),
    );
  const quiet = all
    .filter((t) => t.status === "idle")
    .sort((a, b) => b.last_active_at - a.last_active_at);
  return { inProgress, completed, quiet };
}
```

Sort directions match the backend plan. Empty sections are omitted (the `length > 0` guards above).

### Section label

```tsx
function HoverSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="px-2 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="flex flex-col">{children}</div>
    </div>
  );
}
```

### Per-item rows

All three row variants share a common skeleton: a clickable button row, two columns (title row + timestamp slot), and an optional subheader. The wrapper is a `<button>` for keyboard activation.

```tsx
function HoverRow({
  onClick,
  isPending,
  children,
}: {
  onClick: () => void;
  isPending?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isPending}
      className={cn(
        "group/hover-row flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left",
        "transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
        isPending && "opacity-60",
      )}
    >
      {children}
    </button>
  );
}
```

**In progress** row:

```tsx
function InProgressRow({ thread, onSelect }: RowProps) {
  return (
    <HoverRow onClick={() => onSelect(thread)}>
      <div className="flex items-center gap-2">
        <StatusDot status="running" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-popover-foreground">
          {thread.title || "New chat"}
        </span>
        <RunningTimerSlot startedAt={thread.running_started_at} />
      </div>
      {thread.latest_user_message && (
        <div className="pl-4 truncate text-xs text-muted-foreground">
          {thread.latest_user_message}
        </div>
      )}
    </HoverRow>
  );
}
```

**Completed** row:

```tsx
function CompletedRow({ thread, onSelect }: RowProps) {
  const ts = thread.last_assistant_completed_at ?? thread.updated_at;
  return (
    <HoverRow onClick={() => onSelect(thread)}>
      <div className="flex items-center gap-2">
        <StatusDot status="unread" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-popover-foreground">
          {thread.title || "New chat"}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {formatHoverRelativeTime(ts)}
        </span>
      </div>
      {thread.last_assistant_summary && (
        <div className="pl-4 line-clamp-2 text-xs leading-snug text-muted-foreground">
          {thread.last_assistant_summary}
        </div>
      )}
    </HoverRow>
  );
}
```

**Quiet** row (no dot, no subheader):

```tsx
function QuietRow({ thread, onSelect }: RowProps) {
  return (
    <HoverRow onClick={() => onSelect(thread)}>
      <div className="flex items-center gap-2">
        {/* Reserve same indent as dotted rows so titles align across sections */}
        <span aria-hidden className="size-1.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
          {thread.title || "New chat"}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {formatHoverRelativeTime(thread.last_active_at)}
        </span>
      </div>
    </HoverRow>
  );
}
```

Notes:

- Title text color: full `text-popover-foreground` for in-progress/completed (active items); `text-muted-foreground` for quiet (de-emphasized per the spec).
- `pl-4` on subheaders visually aligns text under the title, not under the dot.
- `truncate` for the running-row subheader (single line, ellipsis); `line-clamp-2` for the completed-row summary (up to two lines, then ellipsis).
- `tabular-nums` on every right-aligned timestamp/timer prevents the digits from jittering as values tick.
- The dotted/undotted indent must match so titles line up across sections. Use the same `size-1.5` width.

### Status dots

Match existing tokens — running and unread already have established colors in [chat-groups-list.tsx:71-87](../src/components/sidebar/chat-groups-list.tsx) (blue Loader2 + red dot) and [chat-tab-bar.tsx:98-114](../src/components/chat-tab-bar.tsx) (same).

In the hover, use **static dots** rather than the spinner. Multiple spinners stacked vertically would be visually noisy, and the running-timer column on the right already conveys activity.

```tsx
function StatusDot({ status }: { status: "running" | "unread" }) {
  if (status === "running") {
    return (
      <span
        aria-label="Agent is working"
        className="size-1.5 shrink-0 rounded-full bg-blue-500"
      />
    );
  }
  return (
    <span
      aria-label="Awaiting your review"
      className="size-1.5 shrink-0 rounded-full bg-red-500"
    />
  );
}
```

- `bg-blue-500` reuses the existing `running` color (text-blue-500 on the Loader2 in [chat-tab-bar.tsx:101](../src/components/chat-tab-bar.tsx)).
- `bg-red-500` reuses the existing `unread` color from [chat-groups-list.tsx:80](../src/components/sidebar/chat-groups-list.tsx).
- The prototype screenshots show green/blue dots; we deliberately diverge to keep the hover consistent with the rest of the sidebar (per spec: "Adapt the visual treatment to fit our existing component library and design tokens").
- `size-1.5` (6px) matches the existing sidebar right-slot dot.

### Running timer slot

`running_started_at` is always `null` in this PR. The slot must still occupy the layout so it doesn't reflow when the real timer lands.

```tsx
function RunningTimerSlot({ startedAt }: { startedAt: number | null }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (startedAt === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);

  return (
    <span
      className="shrink-0 text-xs text-muted-foreground tabular-nums"
      // Reserve enough width for "Xm YYs" / "Xh YYm" without reflow when the timer wires up.
      style={{ minWidth: "3.25rem", textAlign: "right" }}
    >
      {startedAt === null ? "—" : formatRunningElapsed(startedAt, now)}
    </span>
  );
}
```

- Renders `—` (em dash) while the underlying capability is missing. Don't render "Working…" — it duplicates the section label and adds noise.
- Ticks every 1s only when a real `startedAt` is provided. When `null`, no interval is set, so we don't burn cycles in the common case.
- The `min-width` reservation prevents layout shift when the timer wires up. Tune the width to fit "Xm YYs".

### Time formatting

Add [src/lib/chat-group-hover-time.ts](../src/lib/chat-group-hover-time.ts):

```ts
export function formatHoverRelativeTime(timestamp: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - timestamp);
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);

  if (seconds < 45) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (weeks < 5) return `${weeks}w ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function formatRunningElapsed(startedAt: number, now: number = Date.now()): string {
  const total = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return `${hours}h ${String(rem).padStart(2, "0")}m`;
}
```

Output examples (match screenshots): `58s`, `1m 08s`, `3m 23s`, `12m ago`, `2h ago`, `yesterday`, `3d ago`, `1w ago`.

Do **not** reuse `formatRelativeTime` in [src/components/history/chat-row.tsx:36](../src/components/history/chat-row.tsx) — that version uses long-form ("Yesterday", "3 days ago") which is wrong for this dense layout. Leave it as is.

### Click behavior

Inside the hover, every row click delegates to a single `onSelectThread(thread)` callback owned by `ChatGroupsList` (which already has access to `useNavigate`/`useRevalidator` via [src/components/sidebar/app-sidebar.tsx:38](../src/components/sidebar/app-sidebar.tsx) parent).

In [src/components/sidebar/chat-groups-list.tsx](../src/components/sidebar/chat-groups-list.tsx), add an `onSelectThread` prop to the component and pipe through:

```tsx
// in chat-groups-list.tsx
interface ChatGroupsListProps {
  // ...
  onSelectThread: (groupId: string, thread: ChatGroupThreadSummary) => void;
}
```

In [src/components/sidebar/app-sidebar.tsx](../src/components/sidebar/app-sidebar.tsx) parent, implement:

```tsx
const handleSelectThreadFromHover = async (
  groupId: string,
  thread: ChatGroupThreadSummary,
) => {
  const href = `/chat/${encodeURIComponent(thread.id)}?group=${encodeURIComponent(groupId)}`;
  if (thread.membership === "open") {
    navigate(href);
    return;
  }
  // Closed thread: reopen first so the chat-tab-bar shows it as an open tab.
  try {
    const response = await fetch(
      `/api/chat-groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(thread.id)}/reopen`,
      { method: "POST" },
    );
    if (!response.ok) {
      console.error("Failed to reopen chat group member", await response.text());
    }
  } catch (error) {
    console.error("Failed to reopen chat group member", error);
  }
  revalidator.revalidate();
  navigate(href);
};
```

Decisions:

- **Closed-member reopen failure**: log the error, still navigate to the thread. Failing the click on a transient network error would surprise the user. The navigation surface (chat page) will revalidate and show the correct membership state from the server on next loader run.
- **Pending state during reopen**: render the row with `opacity-60` and `disabled` while the reopen `fetch` is in flight. Manage the pending thread id inside `ChatGroupHoverCard` (`const [pendingThreadId, setPendingThreadId] = useState<string | null>(null);`).
- **Hover dismissal on click**: control the `HoverCard` `open` state from the trigger side so a click on a row closes the popover immediately. Pass `open` / `onOpenChange` to the per-group `<HoverCard>` and set `open=false` in the click handler before navigating.

### Empty/missing data handling

- `latest_user_message === null` (running thread): omit the subheader entirely. Do not render placeholder copy like "Working on it…" — the row is already labeled by the In progress section.
- `last_assistant_summary === null` (completed thread): omit the subheader. The completion timestamp on the title row is enough signal.
- `latest_user_message` / `last_assistant_summary` blank after trim: treat as null (don't show empty whitespace).
- Group with 0 chats (shouldn't happen in normal use): render the header and a single `"No chats in this group yet."` row inside the scroll area; no section labels.

### Wiring into ChatGroupsList

```tsx
// src/components/sidebar/chat-groups-list.tsx, inside the .map((group) => ...)
<SidebarMenuItem key={group.id}>
  <HoverCard openDelay={250} closeDelay={150}>
    <HoverCardTrigger asChild>
      <SidebarMenuButton ... existing props ... />
    </HoverCardTrigger>
    <HoverCardContent
      side="right"
      align="start"
      sideOffset={8}
      collisionPadding={8}
      className="w-[20rem] p-0"
    >
      <ChatGroupHoverCard
        group={group}
        onSelectThread={(thread) => onSelectThread(group.id, thread)}
      />
    </HoverCardContent>
  </HoverCard>
  <SidebarMenuAction ... existing X close button ... />
</SidebarMenuItem>
```

Important details:

- The `SidebarMenuAction` (close X) stays a sibling of the trigger, outside the `HoverCardTrigger`. The popover opens to the right and does not visually overlap the X.
- Keep the existing `onClick={() => onSelectGroup(group.id)}` on `SidebarMenuButton` — clicking the row itself still navigates to the group landing page. The hover is additive.
- `HoverCardTrigger asChild` must wrap exactly one child; do not place the X inside it.

### Sidebar collapsed state

When the sidebar is collapsed (`group-data-[collapsible=icon]`), each group is a small square icon. The HoverCard still works because it triggers off the same element. Two things to verify:

- Radix HoverCard side="right" still renders correctly relative to the small icon. With `sideOffset={8}` and `collisionPadding={8}` it should clear the rail.
- The existing tooltip on `SidebarMenuButton` (`tooltip={group.name}`) and our `HoverCardTrigger` will both fire. This is fine — the tooltip is short, the hover card is richer, and they appear on opposite sides (`Tooltip` renders to the right by default for sidebar icons, same as the hover card). Mitigation: when the sidebar is collapsed, prefer the HoverCard. Drop the `tooltip` prop when `state === "collapsed"` is detected; or omit the HoverCard while collapsed, letting the tooltip stay. Implementation: read `state` from `useSidebar()` and render `tooltip={state === "collapsed" ? undefined : group.name}` on `SidebarMenuButton`. Default to keeping the HoverCard active in both states.

### Mobile / touch

`HoverCard` is hover-only and does not open on tap. On touch devices, the hover popover is effectively disabled, which is what we want — tapping a sidebar group row should navigate, not show a peek. No special handling needed.

Do not add a click-to-open fallback for the hover on mobile. The chat-tab-bar already gives mobile users tab-level visibility, and the spec is clear that the hover is a peek for desktop hover patterns.

### Accessibility

- The hover popover is keyboard-accessible via focus: when the sidebar group button is focused with Tab, Radix HoverCard opens the content. Verify with `bun run dev` + tabbing through the sidebar.
- Each row inside the popover is a `<button type="button">` so it is in the tab order once focus reaches it (Radix HoverCard does not portal focus into the content automatically, but focusable elements inside are still reachable with Tab).
- Status dots get `aria-label` ("Agent is working" / "Awaiting your review"); the quiet section's invisible spacer is `aria-hidden`.
- Timestamp text is decorative shorthand. Wrap it in a `<time dateTime={new Date(ts).toISOString()}>` element so screen readers read the absolute time:

```tsx
<time dateTime={new Date(ts).toISOString()} className="...">
  {formatHoverRelativeTime(ts)}
</time>
```

- The running-timer slot is decorative (it would announce a number that ticks every second otherwise). Wrap it in `<span aria-hidden="true">` when `startedAt !== null`. When `startedAt === null`, the em-dash is silent for screen readers anyway.
- The section labels ("IN PROGRESS", "COMPLETED", "QUIET") use plain `<div>` with visual styling; do not use `<h3>` — the popover is not a landmark region and headings would add noise.

### Theming / tokens

Use existing tokens only:

- Popover container: shadcn HoverCardContent already provides `bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10`. Do not override the surface.
- Title text: `text-popover-foreground` (active rows), `text-muted-foreground` (quiet rows + all subheaders).
- Section labels: `text-muted-foreground` + `tracking-wider` + `text-[10px]` + `uppercase` + `font-medium`. Matches the existing `SidebarGroupLabel` look in [src/components/sidebar/app-sidebar.tsx:104](../src/components/sidebar/app-sidebar.tsx).
- Row hover: `hover:bg-accent`. Avoid `bg-sidebar-accent` here — the popover is a portal, not the sidebar.
- Status dot colors: `bg-blue-500` and `bg-red-500` as documented above.

No custom CSS, no inline colors beyond the dot tokens. Dark mode is automatic via the popover token.

### Performance

- The popover content only renders while open (Radix portals it conditionally). No need to lazy-load.
- Section computation is `useMemo`'d on the group identity. Cheap.
- The running timer interval only runs when the popover is open AND `running_started_at !== null`. With current backend stub, no timers run.
- Avoid running a `formatHoverRelativeTime` interval. It is computed once per render; if the user keeps the popover open for a long time, the labels will look stale by at most a minute, which is acceptable.

### Out of scope (do not implement)

- Real running-timer source (`running_started_at` stays `null`; another engineer wires it up).
- Click-to-pin the popover. Hover-only per spec.
- Multi-select or bulk actions inside the popover. Single click → open is the only action.
- Search/filter inside the popover.

## Implementation Steps

1. Extend thread types in [src/types.ts](../src/types.ts), `OrgThread` in [workers/main/src/auth.ts](../workers/main/src/auth.ts), and `toThread` in [src/lib/chat-do.server.ts](../src/lib/chat-do.server.ts).
2. Add `OrgDO` V26 thread metadata migration and self-healing column checks.
3. Add `recordThreadUserMessage` and `recordThreadAssistantCompletion` to `OrgDO`.
4. Wire browser/external user-message paths in `ChatThreadDO.updateThreadMetadataForUserMessage`.
5. Wire assistant completion summary/timestamp persistence in the existing `agent_end` completion path.
6. Update `hydrateChatGroups` to include hover metadata, membership, and assistant-completion-aware unread logic.
7. Update `useChatGroups` live overlays for `completedAt` and optimistic/latest user snippets.
8. Pass optimistic latest-user text through `dispatchLocalThreadStatus` from `Chat.tsx`.
9. Add [src/lib/chat-group-hover-time.ts](../src/lib/chat-group-hover-time.ts) with `formatHoverRelativeTime` + `formatRunningElapsed`.
10. Add [src/components/sidebar/chat-group-hover-card.tsx](../src/components/sidebar/chat-group-hover-card.tsx) exporting `ChatGroupHoverCard` per UI Implementation > Component structure.
11. Wrap each `SidebarMenuItem` row in [src/components/sidebar/chat-groups-list.tsx](../src/components/sidebar/chat-groups-list.tsx) with `HoverCard` / `HoverCardTrigger` / `HoverCardContent` per UI Implementation > Wiring into ChatGroupsList. Add `onSelectThread` prop and pipe through.
12. Implement `handleSelectThreadFromHover` in [src/components/sidebar/app-sidebar.tsx](../src/components/sidebar/app-sidebar.tsx) per UI Implementation > Click behavior; pass to `<ChatGroupsList onSelectThread={...} />`.
13. In collapsed-sidebar mode, suppress `SidebarMenuButton tooltip` so the HoverCard is the single hover surface (see UI Implementation > Sidebar collapsed state).

## Tests

Worker/DO tests:

- [workers/main/tests/auth-do.test.ts](../workers/main/tests/auth-do.test.ts)
  - Migrates/adds new thread metadata columns.
  - `createThread(..., firstUserMessage)` stores both first and latest user message.
  - `recordThreadUserMessage` increments count and updates latest user message.
  - `recordThreadAssistantCompletion` updates completion timestamp/summary without incrementing user count.
  - Completion timestamp is monotonic when given a stale `completedAt`.

- [workers/main/tests/user-do-chat-groups.test.ts](../workers/main/tests/user-do-chat-groups.test.ts)
  - Existing group membership/open/closed behavior remains unchanged.

App/unit tests:

- [tests/thread-preview.test.ts](../tests/thread-preview.test.ts)
  - Add coverage for any shared message-summary/snippet normalizer.

- [tests/chat-groups-ui.test.tsx](../tests/chat-groups-ui.test.tsx)
  - `applyLiveRunningStatuses` preserves new hover fields.
  - Local `completedAt` overlays a stale loader timestamp.
  - Local `latestUserMessage` overlays stale loader data while a thread is running.
  - Group status priority remains `running > unread > idle`.

- `tests/chat-group-hover-time.test.ts` (new)
  - `formatHoverRelativeTime`: `0s → "just now"`, `90s → "1m ago"`, `3600s → "1h ago"`, `1 day → "yesterday"`, `3 days → "3d ago"`, `7 days → "1w ago"`, ≥5 weeks → locale date.
  - `formatRunningElapsed`: `45 → "45s"`, `68 → "1m 08s"`, `3623 → "1h 00m"`. Confirm zero-padding on seconds and minutes.

- `tests/chat-group-hover-card.test.tsx` (new)
  - Renders header with group name and `N chats` count.
  - Omits sections that have no threads (single-in-progress and all-quiet scenarios from the spec).
  - Sorts each section by the correct timestamp field (most recent first).
  - Running rows render the StatusDot, latest user message, and `—` placeholder in the timer slot when `running_started_at === null`.
  - Completed rows render the StatusDot, summary clamped to two lines (`line-clamp-2` class), and the relative timestamp from `last_assistant_completed_at ?? updated_at`.
  - Quiet rows render no dot, no subheader, and the relative timestamp from `last_active_at`.
  - Clicking an `open`-membership row calls navigate with `/chat/:id?group=:groupId` and does not call the reopen endpoint.
  - Clicking a `closed`-membership row posts to `/api/chat-groups/:groupId/members/:threadId/reopen`, then navigates and triggers revalidate.
  - Clicking a `closed` row with a network failure still navigates (logged error, no throw).

Recommended commands:

```bash
bun run typecheck
bun run test:workers -- workers/main/tests/auth-do.test.ts workers/main/tests/user-do-chat-groups.test.ts
bun run test:run -- tests/thread-preview.test.ts tests/chat-groups-ui.test.tsx tests/chat-group-hover-time.test.ts tests/chat-group-hover-card.test.tsx
```

## Risks And Constraints

- Sidebar payload size grows by a few short strings per hydrated thread. Keep stored snippets/summaries clamped.
- Summary quality depends on final assistant text. This is acceptable for initial backend plumbing; the stored field can later be populated by a dedicated summarizer without changing the hover contract.
- Running duration is intentionally stubbed. Do not infer or expose a real running timer in this work.
- Do not fetch full chat transcripts during sidebar hydration. Persist the small metadata needed for hover instead.
- Keep hover metadata out of observability payloads.
