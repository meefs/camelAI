# Chat Groups Implementation Review - r5

## Scope

Reviewed the latest diff against `origin/main`, focusing on the implemented fork fix, the sandbox-host fallback path, and the remaining chat-thread cache changes. I did not review the parallel UI-only refinements in depth.

## Summary

Forking is materially improved and the user-visible `Not found` failure has a plausible fix now: the route can fall back to renderable message history when sandbox `/chat/fork` cannot fork from a host Pi session. I did not find a new P0 in the click-to-fork path.

I do see two P1 correctness issues in the fallback path. They may not show up while the direct host Pi fork succeeds, but they matter because this fallback exists specifically for the environments/history states that were failing before.

## Findings

### P1 - Fallback fork can silently fork the entire thread when the selected target is not found

Refs:

- `src/routes/api/workspaces.$id.chat.$threadId.fork.ts:87`
- `src/routes/api/workspaces.$id.chat.$threadId.fork.ts:95`
- `src/routes/api/workspaces.$id.chat.$threadId.fork.ts:100`
- `src/routes/api/workspaces.$id.chat.$threadId.fork.ts:168`
- `tests/chat-fork-route.test.ts:306`

`selectMessagesForFork()` returns the full message list when neither `forkEntryId` nor `renderedMessageId` matches the renderable history:

```ts
if (index < 0) return messages;
```

That makes the fallback path succeed with the wrong fork boundary. If the selected assistant message id cannot be found, the route should not silently create a fork containing later user and assistant turns. That violates "fork from here" semantics and can be hard to notice because the operation returns 200.

Recommendation:

- Make a missing target an explicit fallback failure, for example `Selected fork target not found in source history`.
- Only allow full-history fallback if the user explicitly asked for "fork latest" or if the selected target is positively identified as the last renderable message.
- Add a test where `messageId`/`renderedMessageId` are absent from renderable history and assert that the route rolls back the target thread instead of writing the full transcript.

### P1 - Fallback history drops hidden/meta message metadata

Refs:

- `src/routes/api/workspaces.$id.chat.$threadId.fork.ts:104`
- `src/routes/api/workspaces.$id.chat.$threadId.fork.ts:123`
- `services/sandbox-host/internal/app/chat_jsonl_parser.go:148`
- `services/sandbox-host/internal/app/chat_jsonl_parser.go:183`
- `services/sandbox-host/internal/app/chat_jsonl_parser.go:201`
- `services/sandbox-host/internal/app/chat_jsonl_parser.go:219`
- `src/components/message-bubble.tsx:519`
- `src/components/message-bubble.tsx:523`

`buildClaudeFallbackHistory()` serializes each user message with only `type`, `uuid`, `timestamp`, and `message.content`. It does not preserve `isMeta`, `sourceToolUseID`/`parentToolUseID`, or `isCompactSummary`.

Those flags are meaningful. The Claude parser restores meta messages and compact summaries only when those fields exist, and the UI hides meta/source-tool messages while rendering compact summaries specially. A fallback-created fork can therefore turn previously hidden meta/tool context into visible user messages, and compact summaries can lose their special rendering.

Recommendation:

- Preserve metadata when writing fallback history:
  - write `isMeta`/`is_meta` for `message.isMeta`;
  - write `sourceToolUseID` or `parentToolUseID` for `message.sourceToolUseID`;
  - write `isCompactSummary` for compact summaries.
- Add a route test whose fallback source history includes a meta message and a compact summary, then parse the written fallback JSONL and assert those fields survive.
- Consider skipping non-rendered meta messages from fallback history only if that is confirmed safe for agent context. Otherwise preserve the metadata so they stay hidden but remain available.

### P2 - The direct and fallback fork paths still need one end-to-end regression

Refs:

- `tests/chat-fork-route.test.ts:306`
- `workers/main/tests/sandbox-runtime.test.ts:125`
- `services/sandbox-host/internal/app/pi_session_messages_test.go:9`

The new unit tests cover the route fallback and sandbox parsing pieces, which is good. The remaining gap is a full product-path test that proves both successful paths land in the same group and open as the active tab:

- direct host Pi fork succeeds;
- fallback renderable-history fork succeeds after `/chat/fork` returns 404 or source-session-missing;
- the target thread is added to the same chat group;
- navigation lands on the forked thread without a `Not found` toast.

This can be component-level with mocked fetches, or Playwright if the app already has enough local chat harness support.

## Verification Run

Passed:

- `bun run typecheck`
- `bun run test:run -- tests/chat-fork-route.test.ts tests/chat-thread-cache.test.ts tests/message-bubble-suppress-finalized-state.test.tsx tests/chat-groups-ui.test.tsx`
- `go test ./internal/app -run 'TestFork|TestParsePi|TestReadHostPi|TestParseClaude'` from `services/sandbox-host`

Not run:

- Full Vitest suite.
- Full worker suite.
- Playwright e2e.

## Suggested Next Patch

Keep the current fork fix, but tighten the fallback path before calling it done: fail when the selected fork target cannot be found, and preserve hidden/meta message metadata in fallback JSONL. Then add one regression that exercises the real fork UI flow into the same chat group.
