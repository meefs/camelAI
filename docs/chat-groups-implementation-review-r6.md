# Chat Groups Implementation Review - r6

## Scope

Reviewed the current diff against `origin/main`, with extra attention on the latest chat group/tab switching work, message-history caching, status indicators, drag/drop behavior, and the fork fallback path. UI-only styling changes were not treated as blockers unless they introduced behavior risk.

## Summary

The chat group UI is in better shape and the focused tests are passing. I still see two P1 issues that can make the new tabbed chat experience feel unreliable:

- the route-level preview resolver can overwrite a warmed message-history cache with an empty "server" snapshot;
- workspace-level running status can be cleared by tab switches/reconnects rather than by an authoritative runner state.

The fork fallback concerns from r5 are also still present in this diff.

## Findings

### P1 - Preview resolution can erase warmed thread-history cache entries

Refs:

- `src/routes/_app.chat.$id.tsx:256`
- `src/routes/_app.chat.$id.tsx:549`
- `src/routes/_app.chat.$id.tsx:559`
- `src/routes/_app.chat.$id.tsx:563`
- `src/hooks/use-chat-thread-cache.tsx:101`
- `src/hooks/use-chat-thread-cache.tsx:136`

`buildPreviewChatDataPromise()` returns preview metadata with `messages: []`. `handleResolved()` then writes that empty array into the chat-thread cache and marks it as `historyState: "server"`.

That means this sequence can still make a hot tab go cold:

1. `prefetchMessages()` or `onThreadSnapshotChange()` stores a real server snapshot with messages.
2. The route preview promise resolves.
3. `handleResolved()` overwrites the cached `messages` with `[]`.
4. `hasServerThreadHistory()` now rejects the cache because `messages.length === 0`.
5. The next tab selection cannot use the optimistic in-memory snapshot and falls back to route/remount/fetch behavior again.

This undermines the "chat group feels like one application" goal. The preview loader should not be allowed to replace a full message-history cache entry with an empty preview-only payload.

Recommendation:

- Split preview state from message-history state, or write preview fields without passing `messages` / `historyState`.
- If keeping one snapshot object, preserve existing `messages` and `historyState` when the incoming resolver payload is known to be preview-only.
- Add a regression to `tests/chat-thread-cache.test.ts` or a route/component test: seed a server snapshot with messages, apply a preview-only update, and assert the snapshot remains warm.

### P1 - Tab switching/reconnects can publish idle status for a still-running chat

Refs:

- `src/components/Chat.tsx:3379`
- `src/components/Chat.tsx:4338`
- `workers/main/src/routes/websocket.ts:237`
- `workers/main/src/routes/websocket.ts:287`
- `workers/main/src/routes/websocket.ts:327`
- `workers/main/src/routes/websocket.ts:351`
- `workers/main/src/routes/websocket.ts:377`

The direct runner bridge records workspace status as running only when this browser sends a new `message`. It records `idle` on client close, runner close/error, terminal events, and immediately during bridge init. It does not persist runner `streaming_state` payloads even though it explicitly recognizes them for logging.

That creates a bad tab-switching path:

1. User sends a message in tab A, so `recordStreaming(true)` runs.
2. User switches to tab B; the Chat component closes tab A's runner websocket during cleanup.
3. The bridge records `recordStreaming(false)` on client close.
4. If the sandbox turn continues, the sidebar/top tab now show idle while the chat is still working.
5. Switching back to tab A opens a new runner bridge, which sends and records another synthetic `idle` before runner state is known.

If closing the runner socket actually cancels the turn, then this is an even larger product problem for tab groups: switching tabs interrupts an active chat. Either way, the status write should not treat browser tab cleanup/reconnect as authoritative completion.

Recommendation:

- Do not call `recordStreaming(false)` for bridge initialization.
- Do not treat client websocket close as terminal agent completion unless the close is known to stop/cancel the turn.
- Persist `recordStreaming(Boolean(payload.isStreaming))` when the runner sends an authoritative `streaming_state` event.
- Add a test around `bridgeChatSocket` or the status layer proving reconnect/init does not clear an already-running thread and that runner `streaming_state: true` updates `WorkspaceDO`.

### P1 - Fallback fork still silently forks the full thread when the selected target is missing

Refs:

- `src/routes/api/workspaces.$id.chat.$threadId.fork.ts:87`
- `src/routes/api/workspaces.$id.chat.$threadId.fork.ts:100`
- `src/routes/api/workspaces.$id.chat.$threadId.fork.ts:168`
- `tests/chat-fork-route.test.ts:306`

This r5 finding still appears unresolved. `selectMessagesForFork()` returns the full message list if neither the runtime `forkEntryId` nor rendered message id is found:

```ts
if (index < 0) return messages;
```

The fallback exists for environments where the direct host fork cannot be used, so it needs to be strict about the fork boundary. Returning a successful fork with the whole transcript is worse than failing because it silently violates "fork from here" semantics.

Recommendation:

- Return a fallback error when the requested target cannot be found.
- Add a test where `messageId` and `renderedMessageId` are absent from the renderable history and assert the target thread is rolled back.

### P2 - Fallback fork still drops hidden/meta message metadata

Refs:

- `src/routes/api/workspaces.$id.chat.$threadId.fork.ts:104`
- `src/routes/api/workspaces.$id.chat.$threadId.fork.ts:123`
- `src/routes/api/workspaces.$id.chat.$threadId.fork.ts:128`
- `services/sandbox-host/internal/app/chat_jsonl_parser.go:183`
- `services/sandbox-host/internal/app/chat_jsonl_parser.go:201`
- `services/sandbox-host/internal/app/chat_jsonl_parser.go:219`

This r5 finding also still appears unresolved. `buildClaudeFallbackHistory()` serializes user messages with only `type`, `uuid`, `timestamp`, and `message.content`. It does not preserve `isMeta`, `sourceToolUseID`, or `isCompactSummary`.

The parser has explicit logic to restore compact summaries and hidden meta/source-tool messages only when those fields exist. A fallback-created fork can therefore make hidden context visible as ordinary user messages or lose compact-summary rendering.

Recommendation:

- Preserve `isMeta` / `is_meta`, `sourceToolUseID` or `parentToolUseID`, and `isCompactSummary` when writing fallback JSONL.
- Add a fallback route test with meta and compact-summary source messages and assert the written JSONL keeps those fields.

## Verification Run

Passed:

- `bun run typecheck`
- `bun run test:run -- tests/chat-fork-route.test.ts tests/chat-thread-cache.test.ts tests/chat-groups-ui.test.tsx tests/compact-message.test.tsx tests/message-bubble-suppress-finalized-state.test.tsx tests/Chat.test.tsx`
- `bun run test:workers -- workers/main/tests/workspace-do-thread-status.test.ts workers/main/tests/user-do-chat-groups.test.ts workers/main/tests/sandbox-runtime.test.ts`
- `go test ./internal/app -run 'TestFork|TestParsePi|TestReadHostPi|TestParseClaude'` from `services/sandbox-host`

Not run:

- Full Vitest suite.
- Full worker suite.
- Playwright e2e.

## Suggested Next Patch

Fix the cache overwrite first because it directly affects the perceived speed of tab switching. Then tighten workspace status so tab cleanup/reconnects cannot publish false idle states. After that, close out the two fork fallback correctness issues from r5 with targeted regression tests.
