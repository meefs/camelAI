# Chat Groups Implementation Review - r4

## Scope

Reviewed the latest chat-groups diff against `origin/main`, focusing on fork behavior, tab switching, thread snapshot caching, and the areas that could make message ordering feel worse. The sent-but-unacknowledged replay bug was investigated here, but it reproduces on `main`, so it is intentionally excluded from this implementation feedback.

## Audit Summary

The main-branch duplicate-send issue is out of scope for this patch.

Forking is still broken and should remain a P0. The UI now sends `groupId`, the route can add the fork to the source group, and the focused route tests pass, but the tests mock away the real sandbox-host fork call. A live "Not found" error is still plausible through the unmocked `/chat/fork` path, either because the sandbox host route is missing/stale in the target environment or because the requested message id does not exist in the host Pi session files.

The other risk introduced by this diff is that the new thread snapshot cache treats any cached message array as useful, including local optimistic/pending messages and streaming partials. That can make tab switches render stale local state immediately and skip a background fetch that would otherwise reconcile the cache with server history.

## Findings

### P0 - Forking still fails with "Not found"

Refs:

- `src/components/Chat.tsx:4675`
- `src/components/Chat.tsx:4681`
- `src/components/Chat.tsx:4686`
- `src/routes/api/workspaces.$id.chat.$threadId.fork.ts:52`
- `src/routes/api/workspaces.$id.chat.$threadId.fork.ts:131`
- `src/routes/api/workspaces.$id.chat.$threadId.fork.ts:136`
- `src/routes/api/workspaces.$id.chat.$threadId.fork.ts:167`
- `workers/main/src/workspace-container.ts:922`
- `workers/main/src/workspace-container.ts:935`
- `workers/main/src/workspace-container.ts:946`
- `services/sandbox-host/internal/app/server.go:333`
- `services/sandbox-host/internal/app/server.go:346`
- `services/sandbox-host/internal/app/server.go:351`
- `services/sandbox-host/internal/app/pi_session_fork.go:58`
- `services/sandbox-host/internal/app/pi_session_fork.go:63`
- `services/sandbox-host/internal/app/pi_session_fork.go:94`
- `services/sandbox-host/internal/app/pi_chat.go:330`
- `services/sandbox-host/internal/app/pi_chat.go:334`
- `tests/chat-fork-route.test.ts:13`
- `tests/chat-fork-route.test.ts:101`

Observed bug: clicking "Fork from here" shows `Not found`.

The app-side route now has the expected group behavior on paper, but the actual fork is still gated on this call:

```ts
const forkResult = await container.forkThreadSession({
  sourceThreadId,
  targetThreadId: targetThread.id,
  entryId: messageId,
});
```

`WorkspaceContainer.forkThreadSession()` calls sandbox-host `/chat/fork` and forwards the returned error text. If the sandbox host does not have that endpoint, `server.go` returns plain `Not found`. The API route catches that, deletes the newly-created thread, and returns the same message to the client, so the user sees `Not found`.

Even when `/chat/fork` exists, the sandbox implementation only forks from host Pi session files. It does not share the broader history fallback used by `/chat/messages`, which first tries host Pi history and then scans legacy Claude/Codex history. Legacy migration happens inside `hostPiBridge.start()` when a Pi bridge starts; the fork endpoint itself does not start that bridge or migrate the source session. For an existing thread that can render messages through legacy fallback but has no host Pi session yet, `forkHostPiSession()` returns `source Pi session not found`.

There is also a message-id fragility. The button passes `message.id` directly. The fork code then searches the raw Pi session for that entry id. If the displayed message id came from a grouped/merged UI message, cached history, or legacy history rather than the raw Pi entry id, the sandbox fork fails with `entry "<id>" not found in source Pi session`.

The current tests do not cover the failure. `tests/chat-fork-route.test.ts` mocks `WorkspaceContainer.forkThreadSession()` and makes it succeed, so the route can pass while the unmocked sandbox path returns `Not found` in real usage.

Recommendation:

- First reproduce with the actual response body/status from `POST /api/workspaces/:workspaceId/chat/:threadId/fork`. If the API response is `{"error":"Not found"}`, confirm whether it came from a sandbox-host 404 on `/chat/fork`.
- Add logging around `forkThreadSession()` failures that includes the sandbox status/code and normalized error. Right now the route erases the distinction between "sandbox endpoint missing", "source session missing", and "entry id missing".
- Make fork support the same history sources that message rendering supports. The sandbox fork endpoint should either migrate legacy history before calling `forkHostPiSession()` or expose a fork implementation that can fork from legacy Claude/Codex history directly. It should not be possible for a thread to render messages but fail to fork because only `/chat/messages` knows about the fallback history.
- Pass a stable fork target id, not blindly `message.id`. Add an explicit `forkEntryId?: string`/`forkTargetId?: string` to `Message`, preserve it when parsing host Pi history and runtime `turn/completed`, and send that id from the fork button. Keep display ids and fork ids separate.
- If the sandbox-host route may be absent in some environments, gate the feature on a capability/preflight check or make the API return a specific actionable error instead of surfacing `Not found`.
- After a successful fork, keep the required product behavior: add the fork to the same group, return `{ thread, groupId }`, revalidate/update group state, and navigate to the fork as the active tab.

Tests to add:

- API route test where `forkThreadSession()` returns `{ success: false, error: "Not found" }`; assert the route reports a clear sandbox fork failure and deletes the target thread.
- API/worker integration test that does not mock `WorkspaceContainer.forkThreadSession()` and verifies `/chat/fork` is actually available on the sandbox-host service binding used by the app.
- Sandbox-host test for forking a rendered legacy thread whose messages are available through `/chat/messages` fallback but whose host Pi session does not exist yet.
- Component test that verifies the fork button sends `forkEntryId` when present, not just the rendered `message.id`.
- End-to-end test for the product path: click fork inside a chat group, the forked chat appears in the same group, becomes the active tab, and no `Not found` toast appears.

### P1 - Local optimistic snapshots are treated as fresh thread history

Refs:

- `src/components/Chat.tsx:2049`
- `src/components/Chat.tsx:2051`
- `src/routes/_app.chat.$id.tsx:192`
- `src/routes/_app.chat.$id.tsx:543`
- `src/routes/_app.chat.$id.tsx:683`
- `src/routes/_app.chat.$id.tsx:693`
- `src/routes/_app.chat.$id.tsx:701`
- `src/hooks/use-chat-thread-cache.tsx:20`
- `src/hooks/use-chat-thread-cache.tsx:102`
- `src/hooks/use-chat-thread-cache.tsx:168`
- `src/hooks/use-chat-thread-cache.tsx:189`
- `src/components/Chat.tsx:2685`
- `src/components/Chat.tsx:2692`

The snapshot callback writes the entire current `messages` array into the thread cache whenever messages change. That includes optimistic user messages, local pending messages, and streaming partials. The snapshot type has no metadata that says whether the messages came from server history, local optimistic state, or an active stream.

The route then considers a snapshot useful if `snapshot.messages.length > 0`. `prefetchMessages()` also returns an existing snapshot immediately when it has any messages. This means a cache entry containing only local optimistic M is treated as warm canonical history.

That matters for tab correctness because the normal `fetchMessages()` path reconciles server history with local messages. If a local-only snapshot prevents prefetch/revalidation, the UI can keep rendering optimistic data as canonical and hide fresher server state during tab switches.

Recommendation:

- Add provenance/freshness fields to `ChatThreadSnapshot`, for example `historyState: "server" | "local" | "streaming"` or explicit booleans such as `hasServerHistory`, `hasPendingLocalMessages`, and `hasActiveStream`.
- Make `hasUsefulSnapshot()` require a server-hydrated snapshot for route/tab switching, or allow local snapshots only when their local/streaming state is represented explicitly.
- Make `prefetchMessages()` revalidate local-only, pending, stale, or streaming snapshots instead of returning them solely because `messages.length > 0`.
- Consider filtering local-only optimistic messages out of the thread history cache entirely. If the cache keeps them, it must preserve metadata that distinguishes them from server history.
- Add a test where the cache contains only a local optimistic user message. Prefetching that thread should still fetch server history.

### P2 - Snapshot updates should identify their own thread

Refs:

- `src/components/Chat.tsx:191`
- `src/components/Chat.tsx:2049`
- `src/routes/_app.chat.$id.tsx:693`
- `src/routes/_app.chat.$id.tsx:701`

`onThreadSnapshotChange` does not include `threadId`; the parent writes the snapshot under its current `displayThreadId`. With keyed remounts this is probably not the primary issue, but it is brittle in a feature that now relies on fast cross-thread state handoff.

Recommendation:

- Include `workspaceId` and `threadId` in the snapshot payload emitted by `Chat`.
- Have the parent either write using those ids or assert they match the active mounted thread before writing.
- Add a small invariant test around rapid tab switches so messages from thread A cannot be written under thread B's cache key.

### P2 - The current tests do not cover local snapshot revalidation

Refs:

- `tests/chat-thread-cache.test.ts:4`
- `tests/chat-groups-ui.test.tsx:89`
- `tests/chat-midstream-followup-order.test.tsx:160`
- `tests/chat-draft-persistence.test.tsx:213`

The new cache test only covers LRU behavior, and the chat-group UI tests cover tab controls rather than cache freshness or server revalidation. There are existing WebSocket mock patterns in other `Chat` tests, so this class of tab-switch regression is testable without a full e2e harness.

Recommendation:

- Add one route/cache test proving an optimistic local snapshot does not block server revalidation.
- Add a focused component test using the existing `MockWebSocket` pattern that mounts `Chat` inside the cache/group route shape, switches between tabs, and verifies the cache does not serve local-only snapshots as canonical history.
- Add an e2e test only after the component-level transport tests exist; the component test will catch this class of duplicate-send regression much faster.

## Verification Run

Passed during this audit:

- `bun run test:run -- tests/chat-fork-route.test.ts`
- `go test ./internal/app -run 'TestFork|Fork'` from `services/sandbox-host`

Recommended commands after the implementation patch:

- `bun run typecheck`
- `bun run test:run -- tests/chat-thread-cache.test.ts tests/chat-groups-ui.test.tsx tests/chat-midstream-followup-order.test.tsx tests/chat-draft-persistence.test.tsx`
- New fork regression tests listed above.
- New regression test for local optimistic snapshot -> tab switch -> server revalidation still runs.

## Suggested Next Patch

Fix forking first. Treat the live `Not found` as a release blocker until the API can distinguish sandbox endpoint absence, missing source session, and missing entry id, and until fork can operate on every rendered chat history source. Then update the thread snapshot cache so local optimistic or streaming snapshots are not treated as fully fresh server history.
