# P0 Chat Performance Audit And Fix Plan

> Superseded for implementation by
> `docs/chat-performance-p0-prescriptive-plan.md`. Keep this file as background
> audit detail only.

## Scope

This is an audit-only handoff for the slow chat scrolling / app-wide jank issue.
No production code was changed in this pass.

I validated the prior Biarritz audit against this `taipei-v1` worktree. The
core diagnosis still holds: this is not just a hover-state issue. The chat route
can repeatedly reload and reprocess the full transcript, while the browser keeps
the entire transcript mounted and rerenders through fragile object-identity
memo boundaries.

Current branch notes:

- The worktree started clean.
- There was no relevant source diff from `origin/main...` before this doc.
- The old audit was not copied verbatim; the findings below use current line
  references from this worktree.

## Executive Summary

The highest-confidence P0 cause is the combination of:

1. Same-route/global revalidations can rerun the active chat loader.
2. The active chat loader reads, parses, converts, and returns the full message
   history whenever `loadMessages` is true.
3. The client re-parses incoming loader messages and does deep
   `JSON.stringify` equality checks even when a revalidation is a no-op.
4. The transcript is not virtualized, so every historical message, markdown
   block, code block, tool call, and action row remains mounted.
5. Memoization depends heavily on object identity, which loader revalidation and
   normalization often break.
6. Chat group/status context lives above the whole app outlet and can rerender
   the active chat route for sidebar/status-only changes.

This looks like a React workload/design issue, not a React bug. The immediate
fix should stop avoidable transcript reloads; the durable fix should window the
message list and make message identity/versioning explicit.

Companion audit: `docs/chat-preview-html-renderer-performance-audit.md` covers
the preview-panel HTML/app iframe path. That path can amplify this P0 because
inactive preview tabs are currently mounted, so HTML/app iframes can keep doing
work while the chat transcript is scrolling.

## Validated Findings

### 1. Active Chat Has No Child `shouldRevalidate`

`src/routes/_app.chat.$id.tsx` does not export `shouldRevalidate`.

The parent app route explicitly keeps default revalidation behavior at
`src/routes/_app.tsx:31-42`, and the active chat route therefore participates in
global revalidation unless React Router decides otherwise.

This matters because the chat loader calls `buildChatData(...)`, which calls
`readThreadMessages(...)` when `loadMessages` is true:

- `src/routes/_app.chat.$id.tsx:160-225`
- `src/routes/_app.chat.$id.tsx:521-527`

The normal active-thread path sets `loadMessages: !useClientMessageCache`.
Because `chatCache=1` is only used for cached tab switches
(`src/routes/_app.chat.$id.tsx:707-717`, `src/routes/_app.chat.$id.tsx:778-797`),
same-route revalidations normally reload messages.

### 2. Full Transcript Reads Are Unbounded

The route history reader first asks the `ChatThreadDO` for all parsed Pi
messages:

- `src/lib/chat-history.server.ts:22-48`
- `src/lib/chat-do.server.ts:592-614`

The DO implementation loads every persisted Pi row, JSON parses every payload,
sanitizes every provider message, appends in-flight messages, and converts all
of them into UI messages:

- `workers/main/src/chat-thread-do.ts:2386-2417`
- `workers/main/src/chat-thread-do.ts:2763-2781`

The legacy path is also full-history:

- `src/lib/chat-history.server.ts:60-110`
- `src/lib/chat-do.server.ts:640-680`

There is already a bounded raw-row helper,
`ChatThreadDO.getPiCoreMessageRows(limit)`, at
`workers/main/src/chat-thread-do.ts:2030-2041`, but the active chat loader does
not use it.

### 3. Background Status Updates Can Still Reload The Active Transcript

The status socket avoids scheduling a revalidation for the active thread id:

- `src/hooks/use-chat-groups.tsx:332-339`

That is good, but it only guards the thread whose status frame triggered the
timer. A background thread completion still calls the global route revalidator,
and the active chat child route has no `shouldRevalidate` guard.

Relevant paths:

- Status snapshot / frame revalidation scheduling:
  `src/hooks/use-chat-groups.tsx:386-427`
- Status revalidation defaults on:
  `src/lib/chat-debug-flags.ts:10-15`
- Provider mounted above the app outlet:
  `src/routes/_app.tsx:217-233`

So a sidebar-only/background-thread status event can make the currently visible
chat route reload and parse the currently visible full transcript.

### 4. Turn Completion Revalidates Too Much

The chat WebSocket stream already updates message state live. Despite that, turn
completion still calls global revalidation:

- Codex `turn/completed`: immediate plus 1s and 3s delayed revalidations at
  `src/components/Chat.tsx:1966-1984`
- Claude `sdkEvent.type === "result"`: immediate revalidation at
  `src/components/Chat.tsx:2387-2419`
- Generic `data.type === "result"`: 1s and 3s delayed revalidations at
  `src/components/Chat.tsx:2487-2497`

These are the most suspicious app-wide jank amplifiers because they run right
after large streaming updates and can repeat work while the user is trying to
scroll.

### 5. "No-Op" Loader Updates Still Burn Browser CPU

The client maps every loader message and re-parses content whenever the
`initialMessages` array identity changes:

- `src/components/Chat.tsx:407-415`

Then the sync effect compares the entire current message list against the
incoming parsed list:

- `src/components/Chat.tsx:640-669`

The equality helper checks each message and calls `JSON.stringify(...)` on each
message's `content`:

- `src/components/Chat.tsx:251-270`

This means a revalidation can do substantial main-thread work even when
`setMessages(...)` is skipped.

### 6. The Transcript Is Fully Mounted

`Chat` renders one scroll container and passes all visible messages to
`ChatMessagesView`:

- `src/components/Chat.tsx:4062-4095`

`ChatMessagesView` groups all messages and maps all groups/messages into DOM:

- `src/components/chat-messages-view.tsx:95-139`
- `src/components/chat-messages-view.tsx:165-229`

Each message can render markdown, Shiki-highlighted code blocks, tool calls,
thinking blocks, teammate messages, and task notifications:

- `src/components/message-bubble.tsx:338-567`
- `src/components/markdown-renderer.tsx:156-184`
- `src/components/markdown-renderer.tsx:604-610`

The existing CSS containment in `src/components/chat-messages-view.tsx:18-20`
helps limit layout/paint damage, but it does not reduce mounted DOM, markdown
parse work, code highlighting, React reconciliation, or browser memory pressure.

No virtualization dependency is currently installed:

- `package.json` has no `@tanstack/react-virtual`, `react-window`, or
  `react-virtuoso` dependency.

### 7. Memo Boundaries Are Too Identity-Dependent

Memoization exists, but it mostly protects only stable object references:

- `ChatMessagesView` uses default `memo(...)` shallow comparison:
  `src/components/chat-messages-view.tsx:66`
- `MessageBubble` requires `prev.message === next.message`:
  `src/components/message-bubble.tsx:854-877`
- `MarkdownRenderer` requires identical `annotatedMentions` array references:
  `src/components/markdown-renderer.tsx:616-627`

But multiple paths recreate objects:

- Loader messages are mapped into new message objects:
  `src/components/Chat.tsx:407-415`
- Normalization/filtering rebuilds arrays when `messages` identity changes:
  `src/components/Chat.tsx:584-597`
- Skill-sheet lookup is rebuilt from all messages:
  `src/components/Chat.tsx:692-708`
- Text blocks call `prepareDisplayText(...)`, returning a fresh
  `annotatedMentions` array for markdown props:
  `src/components/message-bubble.tsx:134-145`,
  `src/components/message-bubble.tsx:350`,
  `src/components/message-bubble.tsx:384`

There is also a tool-heavy-message hot path:

- `src/components/message-bubble.tsx:465-467` does
  `content.slice(index + 1).some(...)` per tool-use block, which is quadratic
  for messages with many tool blocks.

### 8. Chat Group Context Broadens The Blast Radius

`ChatGroupsProvider` wraps the sidebar and entire outlet:

- `src/routes/_app.tsx:217-233`

The active chat route consumes the context:

- `src/routes/_app.chat.$id.tsx:633-644`

The provider replaces maps and returns a single context value containing groups,
active group id, running ids, snapshot state, and callbacks:

- `src/hooks/use-chat-groups.tsx:209-226`
- `src/hooks/use-chat-groups.tsx:415-425`
- `src/hooks/use-chat-groups.tsx:460-487`

`applyLiveRunningStatuses(...)` maps every group and every thread to new
objects:

- `src/hooks/use-chat-groups.tsx:149-185`

`markThreadIdle` depends on `liveThreadStatuses`, so its callback identity
changes when status state changes:

- `src/hooks/use-chat-groups.tsx:263-276`

This probably is not the primary cause of slow scroll by itself, but it makes
sidebar/status traffic feel app-wide and can rerender the active chat route
while the transcript is already expensive.

### 9. Snapshot Provider Is Not The Primary Trigger

The snapshot provider stores data in a ref-backed `Map`; writes do not set React
state:

- `src/hooks/use-chat-thread-snapshots.tsx:31-53`

One secondary issue: the parent route passes `onSnapshotChange` inline, so
`Chat`'s snapshot effect can run on parent rerenders even when messages did not
change:

- Parent prop: `src/routes/_app.chat.$id.tsx:925-928`
- Effect: `src/components/Chat.tsx:441-447`

This is lower priority than revalidation, full-history rendering, and
virtualization.

## Recommended Fix Order

### Phase 0: Reproduce And Measure

Goal: establish a baseline before changing behavior.

1. Use a long coding thread with hundreds of messages and many tool/code blocks.
2. Capture Chrome Performance and React Profiler traces for:
   - idle scroll up/down,
   - background thread status updates,
   - active turn completion,
   - tab switch with and without `chatCache=1`.
3. Confirm whether network responses include full `chatData.messages` during
   same-thread revalidations.
4. Record approximate:
   - active route loader count,
   - response payload size,
   - message count,
   - React commit duration,
   - long tasks over 50ms during scroll.

Expected current failure shape: revalidation/parse/React work overlaps with
scrolling, and long transcripts produce large layout/paint/reconciliation cost
even without active network work.

### Phase 1: Stop Avoidable Full-Transcript Revalidation

This is the first implementation target. It is lower risk than virtualization
and should give immediate relief.

1. Add `shouldRevalidate` to `src/routes/_app.chat.$id.tsx`.
   - Return `true` when navigating to a different thread id/path.
   - Return `true` when search params that affect loader behavior change
     (`adminReadonly`, `newThread`, `chatCache`, `group`).
   - Return `false` for same-thread, same-URL global revalidations.
   - Return `false` after `updateThreadModel`; `Chat` already handles the
     fetcher result locally.
   - Add focused tests for the guard.
2. Remove duplicate delayed completion revalidations from `Chat`.
   - Codex should not call immediate + 1s + 3s global revalidation after
     `turn/completed`.
   - Generic result handling should not schedule duplicate delayed global
     revalidations.
3. Replace global status revalidation with smaller updates.
   - Short-term containment: default `statusRevalidate` to false, or prevent it
     from calling the global route revalidator while this P0 is open.
   - Better target: status socket updates should patch chat-group context
     directly or load a small group/thread-summary resource, not reload the
     active chat route.
4. For title/model/sidebar metadata that still needs refresh, refresh only the
   smallest owner.
   - `thread_model_updated` already updates local model state.
   - `title_updated` should update local tab/sidebar state or trigger only a
     group-summary refresh.
   - Avoid using active-chat transcript reloads as a metadata refresh mechanism.

Acceptance for Phase 1:

- Same-thread `revalidator.revalidate()` does not call `readThreadMessages(...)`.
- Background thread status changes do not reload the active transcript.
- Active turn completion does not reload the full transcript unless an explicit
  manual refresh asks for it.

### Phase 2: Add Message History Versions And Bounded Loading

Phase 1 prevents unnecessary reloads. Phase 2 makes necessary loads cheaper.

1. Add a server-side message history version.
   - Expose a cheap `ChatThreadDO` method such as
     `getPiCoreHistoryState(threadId)` returning latest persisted index/count,
     updated timestamp or revision, and in-flight revision.
   - Prefer an explicit monotonically increasing revision over deriving equality
     from full payload JSON.
   - Include the version/hash on each UI message when possible.
2. Add a bounded UI-message endpoint for the active route.
   - Use the existing bounded row shape in
     `ChatThreadDO.getPiCoreMessageRows(limit)` as the starting point, but return
     parsed UI messages plus a `before` cursor.
   - Initial active load should fetch latest N visible messages, not all rows.
   - Older messages should load when the user scrolls near the top.
3. Keep legacy history working.
   - If legacy container streams cannot page yet, keep a compatibility path but
     avoid repeated same-route reloads from Phase 1.
   - Add pagination to legacy only if current production usage requires it.
4. Replace client deep equality.
   - Stop using `JSON.stringify(message.content)` for no-op checks.
   - Compare stable message id + server version/hash.
   - Reconcile incoming messages by id/version and reuse unchanged message
     objects.

Acceptance for Phase 2:

- Initial active chat load is bounded for Pi-core threads.
- Loader no-op detection is O(number of changed/new messages), not O(full
  transcript content size).
- Unchanged `Message` objects keep identity across loader refreshes.

### Phase 3: Virtualize The Transcript

This is the structural fix for slow scroll on long threads.

Recommended library: add `@tanstack/react-virtual`. It is a good fit for dynamic
row heights and an existing custom scroll container. `react-window` is less
comfortable here because chat message heights are highly variable.

Implementation shape:

1. Virtualize message groups/turns first, not individual content blocks.
   - `ChatMessagesView` already computes assistant turn groups at
     `src/components/chat-messages-view.tsx:95-139`.
   - Treat each group as a virtual row so assistant hover/action behavior remains
     turn-scoped.
2. Use `scrollContainerRef` from `Chat` as the virtualizer scroll element.
3. Render top/bottom spacer padding from the virtualizer instead of mounting all
   groups.
4. Preserve bottom anchoring.
   - Existing bottom/stickiness logic lives around
     `src/components/Chat.tsx:3088-3177`.
   - The active streaming assistant turn must stay mounted and measured.
   - Appending streamed content should not jump the viewport when the user is
     reading older messages.
5. Support older-message pagination.
   - When the virtualizer approaches the first loaded item, fetch older messages
     and preserve scroll offset after prepending.
6. Keep accessibility and anchors.
   - Preserve `data-message-id`.
   - Preserve refs for last user message, assistant measure, pending assistant,
     spacer, and bottom sentinel.

Acceptance for Phase 3:

- A 500+ message thread does not mount 500+ message DOM subtrees.
- Scroll remains smooth while idle, while a background status frame arrives, and
  while a completed turn settles.
- The latest streaming turn remains visible and stable at the bottom.
- Loading older messages above the viewport does not jump the scroll position.

### Phase 4: Make Memoization Durable

These changes complement virtualization and reduce remaining rerender cost.

1. Reconcile messages by id/version and keep unchanged object references.
2. Make `ChatMessagesView` resilient to stable-but-recreated arrays.
   - Either pass a structurally shared `visibleMessages` array, or add a custom
     comparator based on message ids/versions and relevant scalar props.
3. Keep `MessageBubble` comparisons based on message version/hash rather than
   object identity alone.
4. Avoid fresh empty annotation arrays.
   - Return a module-level `EMPTY_ANNOTATED_MENTIONS` when there are no
     annotations.
   - Or memoize prepared display text by message id/content version.
5. Replace the quadratic tool continuation scan.
   - Precompute "agent continued after this block" in one reverse pass.
   - Extract a helper and unit-test messages with many parallel tool calls.
6. Stabilize `onSnapshotChange`.
   - Use `useCallback` in `src/routes/_app.chat.$id.tsx`.
   - This is a small cleanup, not a primary P0 fix.

Acceptance for Phase 4:

- Parent route/context rerenders do not rerender unchanged message bubbles.
- Markdown blocks do not rerender solely because an empty annotation array was
  recreated.
- Tool-heavy messages render in linear time for continuation detection.

### Phase 5: Reduce Chat Group Context Churn

Do this after Phase 1 unless profiling shows it is the dominant trigger.

1. Preserve identity in `applyLiveRunningStatuses(...)`.
   - Return the original thread object if `status` and `is_unread` are
     unchanged.
   - Return the original group object if its open/closed thread arrays and group
     status are unchanged.
2. Avoid replacing `liveThreadStatuses` when a frame is a no-op.
   - `thread_status` currently creates a new `Map` even when the status is the
     same: `src/hooks/use-chat-groups.tsx:415-419`.
3. Make `markThreadIdle` stable.
   - Read `liveThreadStatusesRef.current` instead of closing over
     `liveThreadStatuses`.
4. Split context values.
   - Separate read-heavy group data from stable actions.
   - Consider a tab-bar-only consumer so the full `Chat` component is not
     parent-rerendered for sidebar-only status changes.
5. Memoize `Chat` or introduce a `MemoizedChat` boundary once props are stable.
   - `Chat` currently exports a plain function component:
     `src/components/Chat.tsx:336`.
   - The inline `onSnapshotChange` prop must be stabilized first.

Acceptance for Phase 5:

- No-op status frames do not update context.
- Sidebar-only status churn does not commit the full chat subtree.
- Existing chat group tests still pass and add identity-preservation cases.

## Test Plan

Focused unit/component tests:

- `src/routes/_app.chat.$id.tsx`
  - `shouldRevalidate` returns false for same-thread/same-URL revalidation.
  - It returns true for different thread id/path.
  - It returns true for search params that affect loader behavior.
  - It returns false for `updateThreadModel`.
- `src/hooks/use-chat-groups.tsx`
  - No-op status frames preserve `Map`/group/thread identity.
  - `markThreadIdle` remains referentially stable across live status changes.
  - Existing `applyLiveRunningStatuses` behavior from
    `tests/chat-groups-ui.test.tsx` still passes.
- `src/components/Chat.tsx`
  - Same-content loader refresh reuses unchanged message objects once versions
    exist.
  - Completion events do not call global revalidation repeatedly.
- `src/components/message-bubble.tsx`
  - Tool continuation precompute returns the same UI result as the current
    `slice(...).some(...)` logic.
  - Empty annotated mentions do not force markdown rerenders.
- Virtualized chat view
  - Renders only a window of message groups for a long thread.
  - Keeps last streaming assistant row mounted.
  - Preserves scroll offset when older messages are prepended.

Suggested commands:

```bash
bun run typecheck
bun run test:run -- tests/chat-groups-ui.test.tsx tests/message-bubble-streaming-indicator-order.test.tsx tests/message-bubble-touch-actions.test.tsx
bun run test:run -- tests/workspace-chat-messages-stream-api.test.ts tests/chat-admin-readonly-loader.test.ts
```

Add new tests near the files above rather than relying only on broad snapshots.

## Manual Verification Checklist

Use a long real coding thread.

1. Open Chrome DevTools Network.
   - Scroll the active chat.
   - Complete an active turn.
   - Trigger a background thread completion.
   - Confirm the active route is not repeatedly returning full
     `chatData.messages`.
2. Use React Profiler.
   - Scroll idle.
   - Trigger a status frame.
   - Confirm unchanged message bubbles do not commit.
3. Use Performance panel.
   - Watch for long tasks above 50ms during scroll.
   - Compare before/after with the same message count.
4. Temporarily cap visible messages to latest 50 as a diagnostic only.
   - If this makes scroll smooth, virtualization is confirmed as necessary.
5. Temporarily disable `statusRevalidate`.
   - If app-wide jank drops, broad revalidation is confirmed as a major
     amplifier.

## Non-Goals

- Do not treat hover actions as the root cause.
- Do not solve this by permanently capping history without pagination.
- Do not rely only on `React.memo` while the full transcript remains mounted.
- Do not silently drop metadata updates; route/group refreshes should become
  smaller and source-specific, not invisible.

## Hand-Off Priority

Recommended implementation order for the next agent:

1. Phase 1 route/revalidation containment.
2. Phase 4 low-risk memo hot spots that do not require new data contracts
   (`onSnapshotChange`, empty annotations, tool continuation pass).
3. Phase 3 virtualization with current full-history data if Phase 2 is not ready
   yet.
4. Phase 2 bounded history/versioning.
5. Phase 5 context identity cleanup.

The reason Phase 3 can precede full bounded history is pragmatic: virtualization
directly improves scroll even if the initial network payload is still too large.
But Phase 2 is still required for power efficiency and for long-term P0 quality.
