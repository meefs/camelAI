# Chat Groups Implementation Review

**Date:** 2026-05-07
**Scope:** Review of the current uncommitted chat-groups implementation against `origin/main`, with special attention to the active-chat rendering regressions reported during manual testing.

## Summary

The backend shape is promising and the core UserDO model is moving in the right direction. TypeScript passes, and the two new focused Worker test files pass. However, the implementation is not ready to hand to users yet.

The most urgent issue is a layout regression introduced by wrapping `<Chat />` in a non-flex block in both chat routes. `Chat.tsx` assumes its top-level `flex-1` container is inside a flex column parent. The new wrapper breaks that contract, which explains the active-chat composer moving into the middle of the page, scrolling outside the frame, and the screen appearing blank/out-of-frame after input re-renders.

## Findings

### P0 - Active Chat Layout Contract Is Broken

**Files:**

- `src/routes/_app.chat.$id.tsx:616-640`
- `src/routes/_app.chat._index.tsx:565-588`
- `src/components/Chat.tsx:6242-6301`

Both chat routes now render:

```tsx
<div className="flex h-full min-h-0 flex-col">
  <ChatTabBar ... />
  <div className="min-h-0 flex-1">
    <Chat ... />
  </div>
</div>
```

The inner wrapper is a block element, not a flex column. `Chat.tsx` renders a root container with `className="flex-1 min-h-0 relative flex flex-col"` and then relies on nested `flex-1 min-h-0` scroll containers and `ResizablePanelGroup` to consume the available height. Before this change, that root was effectively inside the app shell flex column. Now its `flex-1` has no flex parent, so the chat body and sticky composer fall back into normal document sizing.

This is the likely cause of both reported UI bugs:

- active chat composer renders in the center / outside the frame after first send;
- typing causes the active chat/group screen to appear blank because the re-rendered content is no longer constrained to the visible frame.

**Required fix:**

Make the immediate parent of `<Chat />` a flex column with bounded height in both routes:

```tsx
<div className="flex min-h-0 flex-1 flex-col">
  <Chat ... />
</div>
```

Then manually verify:

- `/chat/:id` active chat with no preview panel;
- `/chat/:id` active chat with a preview panel;
- `/chat?group=:id` placeholder/new-tab welcome flow;
- first-send transition from `/chat` to `/chat/:id`.

Add a UI or e2e regression test that asserts the composer remains visible after typing and after first send.

### P1 - Close/Reopen Tab APIs Validate the Group Exists, but Not That the Thread Belongs to That Group

**Files:**

- `src/routes/api/chat-groups.$id.members.$threadId.ts:26-32`
- `src/routes/api/chat-groups.$id.members.$threadId.reopen.ts:26-32`

Both endpoints validate that the requested group belongs to the current user/workspace, but then call:

```ts
await userStub.closeThreadTab(threadId);
await userStub.reopenThreadTab(threadId);
```

Those UserDO methods find the group by `threadId`, not by the `groupId` from the URL. A request can therefore name any valid group the user owns while closing/reopening a thread that belongs to a different group for that user.

**Required fix:**

Before mutating, verify the membership is exactly `(groupId, threadId)`, or change the UserDO RPCs to accept both `groupId` and `threadId` and no-op/throw when the pair does not match.

Add route tests for mismatched `groupId`/`threadId` close and reopen attempts.

### P1 - Chat History Navigates Even When "Open as New Group" Fails

**File:** `src/components/pages/history/history-client.tsx:332-340`

`openThreadAsNewGroup` catches network errors but ignores non-OK responses and always navigates:

```ts
await fetch("/api/chat-groups/move-thread", ...).catch(...);
navigate(`/chat/${id}`);
```

If the move request returns 400/403/500, the user still opens the thread. The `/chat/:id` loader then calls `ensureGroupForThread`, which may preserve an existing group instead of forcing the Chat History rule: "open from history -> brand-new group."

This is especially risky on the cross-workspace path, where the code switches workspace and immediately posts the move request.

**Required fix:**

Check `response.ok`. If it fails, show an error and do not navigate, or navigate only after a successful move. Add tests for:

- same-workspace history open creates a new group;
- already-grouped thread from history moves into a fresh group;
- failed move does not navigate into the old group;
- cross-workspace history open performs the move after workspace switch.

### P1 - Testing Is Still Far Below the Plan's Required Bar

**Files currently added:**

- `workers/main/tests/user-do-chat-groups.test.ts`
- `workers/main/tests/workspace-do-thread-status.test.ts`

The new Worker tests pass, but they are only a small slice of the coverage requested in `docs/chat-groups-plan.md`. There are no route/action tests, no component/hook tests, and no e2e coverage for the workflows most likely to regress.

Missing high-value tests:

- `/chat` first-send with and without `groupId`;
- `_app.chat.$id` loader ensuring/touching groups and preserving admin read-only behavior;
- close/reopen/reorder/move API authorization and mismatched group/thread handling;
- Chat History opening into a new group;
- fork route grouping and rollback;
- `<ChatTabBar />`, `<ChatGroupsList />`, `useChatGroups`;
- composer-visible regression after typing and after first send;
- preview-panel separation regression;
- Playwright happy path for new group, new tab, close/reopen, move, history open, fork.

**Required fix:**

Before this is considered implementation-complete, add the missing tests from the plan's testing matrix. At minimum, add:

- `tests/chat-groups-routes.test.ts`
- `tests/chat-groups-ui.test.tsx`
- a Playwright chat-groups workflow spec

### P2 - `useChatGroups` Opens a Workspace Status WebSocket Per Caller

**Files:**

- `src/hooks/use-chat-groups.ts:47-67`
- `src/components/sidebar/app-sidebar.tsx:30-37`
- `src/components/sidebar/workspace-switcher.tsx:25-29`

`useChatGroups()` owns the status WebSocket connection. It is called by both `AppSidebar` and `WorkspaceSwitcher`, so the app opens at least two workspace-status sockets for the same active workspace.

This is not the cause of the reported rendering issue, but it diverges from the plan's "one workspace-level WS per active workspace" requirement and can create duplicate status traffic.

**Recommended fix:**

Move the WebSocket connection into one provider/context mounted once under `_app.tsx`, then let `AppSidebar` and `WorkspaceSwitcher` consume the same context state.

## Verification Run

Passed:

```bash
bun run typecheck
bun run test:workers -- workers/main/tests/user-do-chat-groups.test.ts
bun run test:workers -- workers/main/tests/workspace-do-thread-status.test.ts
bun run test:run -- tests/Chat.test.tsx
```

Not run:

- full `bun run test:run`
- full `bun run test:workers`
- `bun run test:e2e`

Those should run after the P0 layout fix and before final handoff.

## Recommended Next Steps

1. Fix the chat route wrappers so `<Chat />` remains inside a bounded flex column.
2. Add a regression test for typing in active chat and first-send transition.
3. Fix close/reopen membership validation.
4. Fix Chat History so failed `move-thread` does not navigate.
5. Add the missing route, UI, hook, and e2e tests before continuing feature polish.
