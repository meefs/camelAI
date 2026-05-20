# P0 Chat Performance Audit

## Summary

This does not look like a hover-card-only issue. The hover work can amplify the problem, but the expensive path already exists on `main`: chat route refreshes and chat history rendering are both unbounded by transcript size.

The likely root cause is the combination of:

- Broad route revalidation that can reload the active chat route for status/sidebar updates.
- Full transcript reads/parsing on each active chat loader run.
- Browser-side full transcript parsing plus deep `JSON.stringify` equality checks even when the revalidation is a no-op.
- An unvirtualized chat transcript that keeps every message, markdown block, code block, and tool row mounted.
- Memo boundaries that only work when message object identity survives, which route reloads and normalization often break.

## Highest-Confidence Findings

### 1. Active Chat Revalidation Reloads Full Chat History

The active chat route has no `shouldRevalidate` guard of its own. When React Router revalidates this route, the loader can reload the whole current transcript:

- `src/routes/_app.chat.$id.tsx:217-224` calls `readThreadMessages(...)` when `loadMessages` is true.
- `src/routes/_app.chat.$id.tsx:521-526` sets `loadMessages: !useClientMessageCache` for normal active chat loads.
- `src/lib/chat-history.server.ts:34-48` calls `chatDO.getPiCoreMessages(...)` and returns all Pi messages.
- `workers/main/src/chat-thread-do.ts:2391-2421` converts all stored Pi messages plus in-flight messages into UI messages.
- `workers/main/src/chat-thread-do.ts:2768-2786` loads every `pi_core_messages` row and `JSON.parse`s every payload.
- Legacy history has the same shape: `src/lib/chat-history.server.ts:60-74` reads the full legacy stream and maps all messages.

There are multiple sources of broad revalidation:

- Workspace status socket scheduling: `src/hooks/use-chat-groups.tsx:435-442`, `src/hooks/use-chat-groups.tsx:553-555`.
- Codex completion handling: `src/components/Chat.tsx:1968-1985` calls `revalidator.revalidate()` immediately and again after 1s and 3s.
- Claude result handling: `src/components/Chat.tsx:2389-2420`.
- Generic result handling: `src/components/Chat.tsx:2489-2498` schedules two delayed revalidations.

Impact: a background thread status update or turn completion can make the active chat route reload and serialize a large transcript. That work happens before any UI hover code is involved.

### 2. "No-Op" Revalidations Still Burn Main-Thread CPU

`Chat` tries to avoid replacing local message state if incoming loader messages are identical, but the guard itself is expensive:

- `src/components/Chat.tsx:410-416` maps every `initialMessages` entry and calls `parseMessageContent(...)`.
- `src/components/Chat.tsx:642-664` runs the sync effect whenever `initialMessages` identity changes.
- `src/components/Chat.tsx:253-267` compares all messages and `JSON.stringify`s each message's `content`.

That means every same-route loader refresh can still deserialize a large loader payload, parse message content, and stringify every content block on the browser main thread. On long coding threads with many tool blocks, this can produce visible scroll jank even if `setMessages(...)` is skipped.

### 3. The Transcript Is Not Virtualized

The current chat view renders the entire visible transcript:

- `src/components/chat-messages-view.tsx:95-139` groups all `visibleMessages`.
- `src/components/chat-messages-view.tsx:165-229` maps every group and every message to mounted DOM.
- `src/components/message-bubble.tsx:338-567` renders every content block in a message.
- `src/components/markdown-renderer.tsx:604-610` reparses markdown for rendered text blocks.
- `src/components/markdown-renderer.tsx:156-184` can run async Shiki highlighting per code block.

`contain: layout paint style` in `src/components/chat-messages-view.tsx:18-20` helps limit layout damage, but it does not reduce DOM size, markdown parse work, code highlighting, or browser paint cost. Long chats will scroll poorly even without a popover if enough transcript DOM is mounted.

There is also a smaller tool-heavy-message hot path: `src/components/message-bubble.tsx:465-467` calls `content.slice(index + 1).some(...)` for each tool block, which is quadratic for messages with many tool uses.

### 4. Memoization Is Too Identity-Dependent

Memoization helps only when object identity is preserved:

- `src/components/chat-messages-view.tsx:66` uses `memo(...)`, but the default shallow check rerenders when `visibleMessages` identity changes.
- `src/components/message-bubble.tsx:864-877` requires `prev.message === next.message`.
- `src/components/markdown-renderer.tsx:616-627` requires stable `annotatedMentions`, but `ContentBlockRenderer` creates fresh annotation arrays while rendering text blocks at `src/components/message-bubble.tsx:350` and `src/components/message-bubble.tsx:384`.
- `src/components/Chat.tsx:586-599` normalizes and filters all messages when `messages` identity changes.
- `src/components/Chat.tsx:694-710` rebuilds `skillSheetsByToolId` when `messages` identity changes.

When route data or normalization recreates message objects, the expensive children do not get protected by `memo`. The intended optimization is fragile because the code relies on object identity instead of stable message versions/content hashes.

### 5. Chat Group Context Churn Amplifies App-Wide Renders

This is probably not the root cause of slow chat scrolling by itself, but it broadens the blast radius:

- `src/routes/_app.tsx:217-233` places `ChatGroupsProvider` above the sidebar and the whole app outlet.
- `src/hooks/use-chat-groups.tsx:189-260` maps every group/thread and returns new objects from `applyLiveRunningStatuses(...)`.
- `src/hooks/use-chat-groups.tsx:524-534` replaces `liveThreadStatuses` with a new `Map` on status frames.
- `src/hooks/use-chat-groups.tsx:339-356` makes `markThreadIdle` depend on `liveThreadStatuses`, so its callback identity changes with status updates.
- `src/hooks/use-chat-groups.tsx:608-614` exposes one context value for groups, active group, running IDs, snapshot state, and the callback.

Consumers like the sidebar and chat routes rerender together when this context changes. That makes status traffic feel like a whole-app update, especially while the active chat is already expensive.

## Less Likely As Primary Causes

- The snapshot provider is not the root render trigger. `src/hooks/use-chat-thread-snapshots.tsx` stores snapshots in a ref-backed `Map`; snapshot writes do not set React state.
- The new hover timer is not currently the main cause because `running_started_at` is still stubbed as `null`. When real running timers are wired, they should use a shared clock instead of one interval per row.
- Chat `onScroll` is simple and React should bail when `showScrollButton` stays unchanged. It can still be affected by the oversized DOM and concurrent revalidation work.

## Recommended Fix Order

### Immediate Containment

1. Stop status/sidebar refreshes from revalidating the active chat transcript. Status socket data should update sidebar/group state directly or refresh a small resource endpoint, not the whole chat route.
2. Add a `shouldRevalidate` guard to `src/routes/_app.chat.$id.tsx` so same-thread metadata/status refreshes do not reload messages.
3. Remove duplicate delayed `revalidator.revalidate()` calls after turn completion. The WebSocket already has the live transcript; completion should refresh only metadata that was not streamed.
4. Add a temporary kill switch or default-off path for `statusRevalidate` while this is being fixed. The existing debug flag in `src/lib/chat-debug-flags.ts` can help isolate this quickly.

### Data Pipeline

1. Add a cheap chat history version to `ChatThreadDO` such as latest message index plus updated timestamp. If the client already has that version, do not send the transcript again.
2. Change active chat loading to latest-N messages plus cursor pagination. `ChatThreadDO.getPiCoreMessageRows(limit)` already has a bounded query shape at `workers/main/src/chat-thread-do.ts:2035-2047`; the active route should not use the all-row `loadPiCoreMessages()` path.
3. Move away from browser-side `JSON.stringify` transcript equality. Use stable message ids plus server-provided content hashes/history versions.

### React/Memo Work

1. Reconcile incoming loader messages into existing message state by id/version and reuse unchanged message objects.
2. Keep `visibleMessages` structurally shared when the message list is unchanged.
3. Make `MessageBubble` either receive stable message objects or compare stable message versions instead of object identity alone.
4. Avoid fresh `annotatedMentions` arrays for text blocks with no annotations, or memoize prepared display text by message id/content hash.
5. Replace the `content.slice(...).some(...)` tool-block scan with a single reverse pass that precomputes whether an agent continued after each block.

### Structural Rendering Fix

Implement message virtualization/windowing for the chat transcript. This is the fix that directly addresses slow scrolling on long threads. The virtualizer needs to preserve bottom anchoring, keep the active streaming turn mounted, and support loading older messages above the viewport.

### Context Cleanup

1. Split chat group context into narrower contexts/selectors so active chat routes do not rerender for every sidebar-only status detail.
2. Preserve object identity in `applyLiveRunningStatuses(...)` for groups and threads whose resolved fields did not change.
3. Make `markThreadIdle` stable by reading `liveThreadStatusesRef.current` instead of depending on `liveThreadStatuses`.
4. Equality-check status socket updates before replacing `liveThreadStatuses`.

## Verification Plan

Use three quick isolation checks before and after fixes:

1. Disable status revalidation and repeat the slow-scroll case. If app-wide jank drops, broad route revalidation is a major amplifier.
2. Temporarily cap rendering to the latest 50 visible messages. If scroll becomes smooth, transcript DOM size is the primary scroll bottleneck.
3. Profile turn completion on a long thread. Look for loader JSON parse, `parsedInitialMessages`, `messagesHaveSameContent`, markdown rendering, and code highlighting long tasks.

The current evidence is enough to prioritize the full-history revalidation path and unvirtualized transcript as the P0 cause. The hover implementation should not proceed as if this is isolated to hover state; it is sitting on top of an already expensive chat route.
