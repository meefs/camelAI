# Chat Groups Implementation Review - r8

## Scope

Reviewed the current working tree diff against `origin/main`, with extra attention on the round 7 status changes and the reported bug where the sidebar and tab-bar indicators stay on running instead of moving to unread after the agent finishes.

## Findings

### P1 - Completed background turns have no live unread transition, so the UI can stay stale after running clears

Refs:

- `src/hooks/use-chat-groups.tsx:64`
- `src/hooks/use-chat-groups.tsx:74`
- `src/hooks/use-chat-groups.tsx:76`
- `src/hooks/use-chat-groups.tsx:152`
- `src/lib/chat-groups.server.ts:103`
- `src/lib/chat-groups.server.ts:106`
- `workers/main/src/routes/websocket.ts:238`
- `workers/main/src/routes/websocket.ts:352`
- `workers/main/src/workspace.ts:346`
- `workers/main/src/workspace.ts:360`
- `workers/main/src/auth.ts:4883`
- `src/routes/_app.chat.$id.tsx:628`
- `src/components/Chat.tsx:3519`
- `src/components/Chat.tsx:2323`

The r7 sandbox-host change now emits `streaming_state`, which is the right direction. The remaining problem is that the client only receives a live running set. It does not receive a live "this thread completed and is now unread" signal.

`WorkspaceDO` broadcasts only `running` / `idle`. `useChatGroups()` handles that by adding/removing ids from `runningThreadIds`. Then `applyLiveRunningStatuses()` tries to infer the final display status from the old loader snapshot: if the old loader thread was `running`, it becomes `thread.is_unread ? "unread" : "idle"`.

That cannot work for the common background completion path:

1. User sends in tab A. `recordStreaming(true)` makes tab A/group running.
2. The user switches to tab B.
3. Tab A finishes. `recordStreaming(false)` removes the running bit.
4. The only remaining source for unread is `thread.is_unread` from the last app loader result.
5. That loader result was produced before the assistant completion, so `is_unread` is usually still false.

There is also no durable assistant-completion activity timestamp in this path. `OrgDO.touchThread()` runs on user send and increments `user_message_count`, but it is not called for assistant completion. The unread calculation is `thread.updated_at > viewed_at`, so a completion cannot become unread after a user-send-era `mark-viewed` unless the thread is touched again when the assistant finishes.

This explains why the UI cannot reliably move from spinner to unread. Depending on timing, it either remains loader-derived running, or it clears to idle instead of unread.

Recommendation:

- Persist assistant completion as thread activity without incrementing `user_message_count` (for example a new `touchThreadActivity(threadId)`/`markThreadAssistantCompleted(threadId)` OrgDO method), and touch the chat group at the same completion time.
- On `streaming_state:false` / `turn/completed`, broadcast enough live state for the frontend to render immediately, e.g. `{ type: "thread_status", threadId, status: "unread", completedAt }` for non-active threads, or maintain a `completedThreadIds` / `liveUnreadThreadIds` set in `useChatGroups()`.
- Revalidate chat groups after completion or after an idle status event so the durable `updated_at` / `viewed_at` state catches up.
- Add a regression where tab A is running, active tab is B, tab A receives `thread_status idle`, and the sidebar group plus tab A render `unread`, not running or idle.

### P1 - `thread_status` frames do not become authoritative unless the snapshot was received

Refs:

- `src/hooks/use-chat-groups.tsx:140`
- `src/hooks/use-chat-groups.tsx:143`
- `src/hooks/use-chat-groups.tsx:152`
- `src/hooks/use-chat-groups.tsx:156`
- `src/hooks/use-chat-groups.tsx:171`

`hasStatusSnapshot` only flips to true when a `thread_status_snapshot` frame arrives. Individual `thread_status` frames update `runningThreadIds`, but they do not mark the live status channel as authoritative.

If the app loader has a stale `thread.status === "running"` and the client misses, delays, or reconnects before the snapshot, an incoming `{ status: "idle" }` frame deletes the id from `runningThreadIds` but leaves `hasStatusSnapshot === false`. `applyLiveRunningStatuses()` then refuses to override the stale loader-derived running status.

This is another direct way to get the "stuck running" symptom even after the worker has recorded idle.

Recommendation:

- Treat any well-formed `thread_status` frame as authoritative by setting `hasStatusSnapshot(true)`.
- Better: replace `runningThreadIds + hasStatusSnapshot` with a `Map<threadId, liveStatus>` that can represent explicit `idle`, `running`, and `unread` overrides independent of the loader snapshot.
- Add a unit test where source loader data says `running`, no snapshot has arrived, then a `thread_status idle` frame arrives; expected result should not remain running.

### P2 - Active-tab unread suppression conflicts with the reported expected state

Refs:

- `src/hooks/use-chat-groups.tsx:81`
- `src/hooks/use-chat-groups.tsx:84`
- `src/components/chat-tab-bar.tsx:229`
- `tests/chat-groups-ui.test.tsx:360`

The current code explicitly prevents the active thread from displaying unread. `applyLiveRunningStatuses()` turns active unread into idle, and `ChatTabBar` also maps active unread tabs to idle before rendering the right slot.

That may be the right product decision if "unread" only means "completed while I was looking elsewhere." But it conflicts with the latest report if the desired behavior is for the active tab itself to switch from spinner to "awaiting review" when the assistant finishes.

Recommendation:

- Clarify the rule. If active tabs should show awaiting-review after a turn completes, remove the active-unread suppression and update `tests/chat-groups-ui.test.tsx:360`.
- If active tabs should not show unread, add a test for the intended background case instead: active tab B, tab A finishes, tab A and the group show unread.

### P2 - Opening a group can reorder it because selection updates `chat_groups.updated_at`

Refs:

- `src/routes/_app.chat.$id.tsx:406`
- `src/lib/chat-groups.server.ts:197`
- `workers/main/src/auth.ts:1345`
- `workers/main/src/auth.ts:1367`
- `workers/main/src/auth.ts:1371`
- `workers/main/tests/user-do-chat-groups.test.ts:43`

The sidebar list is ordered by `chat_groups.updated_at`. The route loader calls `ensureGroupForThread()` for the active thread. For an existing group, `UserDO.ensureGroupForThread()` updates `chat_groups.updated_at` when it sets `last_active_thread_id`.

That means simply opening an old chat group can move it to the top of the sidebar as if it had new message activity. The test name says groups should order by last user message activity rather than selection, but the test uses a future timestamp and does not catch the real navigation case.

Recommendation:

- Split "last active thread" from "activity ordering"; do not update `updated_at` for selection-only changes.
- Keep `updated_at` changes for actual message/fork/move activity.
- Add a worker test that creates two groups, touches group A for message activity, then calls `ensureGroupForThread()` on group B and asserts A still sorts first.

### P3 - Sidebar chat count includes dismissed tabs

Refs:

- `src/components/sidebar/chat-groups-list.tsx:34`
- `src/components/sidebar/chat-groups-list.tsx:148`
- `src/lib/chat-groups.server.ts:143`
- `src/types.ts:51`

The sidebar count currently uses `group.member_count`, and `hydrateChatGroups()` defines that as `openThreads.length + closedThreads.length`. That makes the sidebar count include dismissed/closed tabs even though those chats no longer appear in the visible tab bar.

The dismissed chats are still part of the group and are available from the closed-tabs/history affordance in the tab bar, but the sidebar number should represent the visible open chats in the group.

Recommendation:

- Change the sidebar display to use `group.open_threads.length`, or redefine/augment the view model with `open_member_count` if other surfaces still need total membership.
- Update the aria label in `ChatGroupRightSlot` to match the open-count meaning.
- Add a UI test with one open tab and one closed tab and assert the sidebar count is `1`, not `2`.

## Notes

- The r7 sandbox-host lifecycle fix is a meaningful improvement. `beginActiveTurn()`, `endActiveTurn()`, and init now emit `streaming_state`, including the inactive reconnect case.
- The status tests validate worker recording, but they stop at `recordWorkspaceThreadStreaming(false)`. They do not validate the user-facing transition from running to unread in `useChatGroups()`.

## Verification Run

Passed:

- `bun run typecheck`
- `bun run test:run -- tests/chat-fork-route.test.ts tests/chat-thread-cache.test.ts tests/chat-groups-ui.test.tsx tests/compact-message.test.tsx tests/message-bubble-suppress-finalized-state.test.tsx tests/Chat.test.tsx tests/chat-message-merge.test.ts`
- `bun run test:workers -- workers/main/tests/chat-runner-websocket-status.test.ts workers/main/tests/workspace-do-thread-status.test.ts workers/main/tests/user-do-chat-groups.test.ts workers/main/tests/sandbox-runtime.test.ts`
- `go test ./internal/app -run 'TestHostPiBridge|TestFork|TestParsePi|TestReadHostPi|TestParseClaude'` from `services/sandbox-host`

Not run:

- Full Vitest suite.
- Full worker suite.
- Playwright e2e.
