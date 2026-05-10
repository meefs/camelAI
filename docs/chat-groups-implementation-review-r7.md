# Chat Groups Implementation Review - r7

## Scope

Reviewed the current working tree diff against `origin/main`, including the uncommitted round 6 follow-up changes. I focused on the full chat-groups PR surface: tab switching/cache behavior, fork behavior, drag/drop, thread running status, and the new tests.

## Findings

### P1 - Running status can still stick if a turn completes while its tab is detached

Refs:

- `src/components/Chat.tsx:3379`
- `src/components/Chat.tsx:4338`
- `workers/main/src/routes/websocket.ts:238`
- `workers/main/src/routes/websocket.ts:287`
- `workers/main/src/routes/websocket.ts:352`
- `workers/main/src/routes/websocket.ts:360`
- `workers/main/src/routes/websocket.ts:373`
- `services/sandbox-host/internal/app/pi_chat.go:178`
- `services/sandbox-host/internal/app/pi_chat.go:185`
- `services/sandbox-host/internal/app/pi_chat.go:1011`
- `services/sandbox-host/internal/app/pi_chat.go:1035`
- `services/sandbox-host/internal/app/pi_chat.go:1110`
- `services/sandbox-host/internal/app/pi_chat.go:1152`
- `services/sandbox-host/internal/app/pi_chat.go:1167`
- `services/sandbox-host/internal/app/pi_chat.go:1641`
- `services/sandbox-host/internal/app/pi_chat.go:1717`
- `workers/main/tests/chat-runner-websocket-status.test.ts:117`

The r6 worker change correctly stopped treating browser tab cleanup as authoritative agent completion. However, that exposes the other half of the lifecycle: if the browser bridge is closed while the host Pi turn continues, nothing reliably records `idle` when that detached turn finishes.

The sequence I think still fails:

1. User sends in tab A. The worker records running at `workers/main/src/routes/websocket.ts:238`.
2. User switches to tab B. `Chat` closes the runner websocket during cleanup at `src/components/Chat.tsx:4338`.
3. The worker now sets `closingBecauseClientDisconnected` and suppresses `recordStreaming(false)` on the runner close at `workers/main/src/routes/websocket.ts:373`.
4. Sandbox host detaches the client but keeps the host Pi bridge/turn alive at `services/sandbox-host/internal/app/pi_chat.go:1110`.
5. The turn finishes while no worker bridge is attached. Host Pi buffers `turn/completed`/`result` events at `services/sandbox-host/internal/app/pi_chat.go:1641`, but no worker receives those terminal frames, so no `recordStreaming(false)` runs.
6. If the user later reconnects after the turn is inactive, host Pi skips replay at `services/sandbox-host/internal/app/pi_chat.go:1717` and only sends `session`/`ready` at `services/sandbox-host/internal/app/pi_chat.go:185`. The stale WorkspaceDO running row remains until the TTL or another event clears it.

The new worker test does not catch this because it asserts synthetic runner `streaming_state` frames at `workers/main/tests/chat-runner-websocket-status.test.ts:117`. I could not find any `streaming_state` emission in `services/sandbox-host/internal/app`; `beginActiveTurn()` / `endActiveTurn()` only update an in-memory boolean.

Recommendation:

- Make sandbox host emit an authoritative status event on init, e.g. `{ type: "streaming_state", isStreaming: active }`, before or alongside `ready`.
- Emit/buffer `streaming_state: true` from `beginActiveTurn()` and `streaming_state: false` from `endActiveTurn()`, including when no browser client is attached.
- Keep the worker-side client-close suppression, but make reconnect after inactive completion clear the WorkspaceDO row.
- Add a regression that models the real host behavior: message starts, browser disconnects, host finishes detached, reconnect happens after `active=false`, and WorkspaceDO receives `recordWorkspaceThreadStreaming(false)`.

### P2 - Long-running turns can disappear from the status snapshot after 10 minutes

Refs:

- `workers/main/src/workspace.ts:35`
- `workers/main/src/workspace.ts:300`
- `workers/main/src/workspace.ts:307`
- `workers/main/src/workspace.ts:330`
- `workers/main/src/routes/websocket.ts:238`
- `workers/main/src/routes/websocket.ts:352`

`thread_streaming_status` rows are pruned after 10 minutes, and `updated_at` is only refreshed by discrete `recordThreadStreaming(true)` calls. In the current real path, that is the initial user send; the host does not emit periodic or lifecycle `streaming_state` events.

A coding-agent turn can reasonably exceed 10 minutes. If the user refreshes, reconnects the status socket, or hydrates chat groups after the TTL, `listStreamingThreadIds()` prunes the still-running thread and the sidebar/tab status can fall back to idle.

Recommendation:

- Add a low-frequency heartbeat while a turn is active, or refresh `updated_at` from authoritative host lifecycle events.
- If heartbeat is not practical, make the TTL substantially longer and treat it only as crash cleanup. It should not be short enough to hide normal long-running work.

### P3 - Status websocket reconnects can briefly resurrect stale loader-derived statuses

Refs:

- `src/hooks/use-chat-groups.tsx:171`
- `src/hooks/use-chat-groups.tsx:177`
- `src/hooks/use-chat-groups.tsx:69`

On status socket `close` or `error`, the provider clears `hasStatusSnapshot` and `runningThreadIds`. That makes `applyLiveRunningStatuses()` trust loader-derived `thread.status` again until the next snapshot arrives.

If the latest authoritative snapshot had already cleared a stale running status, a transient socket reconnect can briefly show the old loader status again. This is lower severity than the lifecycle bug above, but it makes status indicators feel flickery and can mask whether the P1 fix is actually working.

Recommendation:

- Keep the last authoritative snapshot during reconnect and only replace it when a new snapshot arrives.
- Track connection state separately from snapshot freshness if the UI needs to know the status socket is reconnecting.

## Notes

- The r6 cache overwrite fix looks correct. `handleResolved()` no longer writes empty preview data as server history, and `upsertThreadSnapshot()` preserves existing server messages when it receives an empty server payload.
- The fork fallback fixes from r6 look materially addressed. Missing fork targets now roll back instead of silently forking the full transcript, and fallback JSONL preserves meta/compact-summary fields.
- The file drag/drop fix looks correct. `isFileDrag()` excludes `application/x-camelai-thread-id`, and there are focused tests proving tab drags do not show the upload overlay.

## Verification Run

Passed:

- `bun run typecheck`
- `bun run test:run -- tests/chat-fork-route.test.ts tests/chat-thread-cache.test.ts tests/chat-groups-ui.test.tsx tests/compact-message.test.tsx tests/message-bubble-suppress-finalized-state.test.tsx tests/Chat.test.tsx`
- `bun run test:run -- tests/chat-message-merge.test.ts`
- `bun run test:workers -- workers/main/tests/chat-runner-websocket-status.test.ts workers/main/tests/workspace-do-thread-status.test.ts workers/main/tests/user-do-chat-groups.test.ts workers/main/tests/sandbox-runtime.test.ts`
- `go test ./internal/app -run 'TestFork|TestParsePi|TestReadHostPi|TestParseClaude'` from `services/sandbox-host`

Not run:

- Full Vitest suite.
- Full worker suite.
- Playwright e2e.
