# Chat Steer Ordering — Implementation Review Feedback

**July 10, 2026.** Review of the working-tree implementation of `docs/chat-steer-ordering-plan.md`, plus a storage-level diagnosis of the 2/10 manual test runs that "got stuck". Verified: `bun run typecheck` clean; 98 client tests + 314 worker tests pass (`tests/steer-split.test.ts`, `pi-chunk-encoder`, `ui-message-adapter`, `chat-working-indicator`, `chat-messages-view-collapsed-turn`, `runtime-message-overlay`; `workers/main/tests/chat-thread-pi-{turn,stream-bridge}.test.ts`).

**Verdict: the implementation is faithful to the plan and works — including in the stuck runs.** The stuck behavior is a pre-existing runtime gap the test scenario exposed (item 0), not a defect in this diff. Three small code changes are requested (items 1–3); the rest are confirmations and notes.

---

## 0. The 2/10 "stuck" runs — diagnosed from DO storage; NOT caused by this change

Inspected the stuck thread `26038e31-8389-45ea-a507-34d4f361a54f` directly in local dev DO storage (`.wrangler/state/v3/do/chiridion-app-ChatThreadDO/227e32a6….sqlite`). The persisted state proves the fix did its job:

- The steer bubble row carries `sentDuringStreaming: true` and its clientMessageId id.
- The turn row `01bf3127…` has parts `[step-start, reasoning, tool-JavaScript(output-available), data-pi-steer-marker(pi:steer:client_1783709622150…), data-pi-user-stop]` — the marker is exactly at the seam, `acceptedAtMs` = the send time (18:53:42).
- Turn metadata has `turnDurationMs: 604312`, `completedAtMs` present; `pi_turn_journal` is empty and no `piActiveTurn` marker is stranded. The settled thread renders correctly and the camel clears.

The timeline is the story:

| Time | Event |
| --- | --- |
| ~18:53:29 | Model starts `js_exec` running the `while(true)` loop with `timeoutMs = 600000` |
| 18:53:42 | Steer accepted; marker emitted; skeleton persisted; `piSession.steer()` delivered |
| 18:58:38 | User gives up waiting and presses **Stop** (`pi_user_stop_1783709918467`) |
| 19:03:33 | `js_exec` hits its 600s cap ("JavaScript execution timed out after 600000ms"), the run finally reaches a yield point; the queued steer folds into pi_core, the stop finalizes, `turn/completed` fires |

**Root cause: pi has no steering point while a tool call is in flight. A steer — and even a user Stop — waits for the running tool to return.** The infinite-loop exec only returns at its 600s timeout, so the turn was genuinely running the whole time; every indicator was honestly reporting that. The 8 passing runs will be the ones where the model's exec finished quickly (or the steer landed between items); whether this reproduces depends entirely on the `timeoutMs` the model picks.

Follow-ups (separate work items, do not fold into this diff):

1. **Preemption (the real fix):** on user Stop — and ideally on steer — abort the in-flight `js_exec`/command in the project runtime (plumb the pi session's stop/steer through `ProjectRuntimeServiceVmBridge` to kill the running exec) so the run reaches its yield point immediately. Stop taking ~5 minutes to take effect is the worst part of this timeline and predates this change.
2. **Queued-steer affordance (small UI, optional):** while a steer is accepted but not yet drained (bubble present, live slice below it still empty), the empty live group under the bubble reads as dead air. A one-line muted hint in that group — reuse the existing `TurnSummaryBar` region, text like `Queued — the agent will see this when the current action finishes` — would make the wait legible. Only render it when the final slice is empty AND the previous part is a running tool.

## 1. Replace the module-level `splitCache` Map with a WeakMap (should fix)

`src/lib/steer-split.ts:23-24` keeps `const splitCache = new Map<string, SplitCacheEntry>()` at module level with a 512-entry LRU. Chat renders during SSR, so this executes in the Worker isolate and retains up to 512 threads' slice arrays across requests — exactly the "module-level mutable Map in Worker code" pattern AGENTS.md forbids. (The plan's "cache keyed by source message id" spec led here — the shape below is strictly better.)

Replace with object-identity keying:

```ts
const splitCache = new WeakMap<UIMessage, Omit<SplitCacheEntry, 'sourceRef'>>();
// lookup: splitCache.get(message) → validate streaming flag + sameRefs(consumedBubbleRefs)
```

Same hit rate (a valid hit already requires `sourceRef === message`), self-evicting with the message objects, no cross-request retention, and the LRU bookkeeping (`cacheSlices`, `SPLIT_CACHE_LIMIT`, the delete/re-set dance at `:180-182`) is deleted. No test changes needed beyond identity assertions already present.

## 2. Segment emptiness should ignore `step-start` parts (should fix)

`splitAssistantMessage` (`steer-split.ts:86-95`) judges emptiness by raw part count. The encoder emits `step-start` at the head of every turn, so a steer accepted **before any visible content** yields `segments[0] = [step-start]` — "non-empty" — and renders as a contentless assistant chunk (a `worked · 0 steps` stub) *above* the bubble, where the plan called for the leading empty segment to be dropped.

Fix: count only renderable parts when deciding whether a segment is empty (treat `step-start` — and any part the adapter maps to zero blocks, e.g. a stray marker — as insignificant). When a segment holds only insignificant parts, drop it like an empty one but carry its parts into the next kept segment so nothing is lost from the raw message.

While in there, add the symmetric hardening: if **no** segments survive on a settled message (theoretically possible when a turn's only parts are markers), keep the final segment anyway — the original id and `pi.completedAtMs`/`turnDurationMs` must always land on some emitted slice, or the duration badge and the `deriveTurnSettled` clamp silently lose their anchor. Cover both with unit tests in `tests/steer-split.test.ts` (steer-before-first-content; marker-only settled message).

## 3. Make the synchronous marker push best-effort (hardening)

The steer branch now calls `this.pushChatEvent({ type: "steer-marker", … })` synchronously inside the send RPC (`chat-thread-do.ts:9065-9069`). `enqueuePiStreamChunks` writes to the reply-stream writer with no try/catch, so a stream cancelled in exactly that instant (stall-disposal race) would throw out of `sendRunnerCommand` **after** the steer was journaled: the client reports delivery failure and asks the user to resend, while the journal re-delivers the original on the next resume — a duplicate steer if they comply.

The marker is best-effort by design (an absent marker degrades to array order in the split). Wrap the push:

```ts
try {
  this.pushChatEvent({ type: "steer-marker", steerMessageId: steeredSkeleton.id, acceptedAtMs: Date.now() });
} catch (error) {
  console.error("[ChatThreadDO] steer marker emit failed (continuing without seam)", error);
}
```

Existing sync `pushChatEvent` callers (user-stop, agent_end) run inside the stream fiber where a write failure is already the turn's problem; this is the only call on an RPC accept path.

## 4. Confirmations (no action)

- **Live tool output does not freeze across the split.** `mergeLiveToolOutput` is applied to every adapted slice (`use-pi-chat-stream.ts:349-350`), so a running command's streamed output keeps ticking in the pre-steer slice; only the `isStreaming` flag is id-gated to the final slice. Verified against the stuck thread's shape (tool part in slice A.1, live output riding transient chunks).
- **Phase 2 fold rebuild is correct.** Hand-traced and covered by the new `chat-thread-pi-stream-bridge` test: same-stamp groups fold across interposed user rows, synthetic markers resolve `steerMessageId` via existing-skeleton id → user-row stamp → converted id, `forkEntryIds` merge, no same-id clobber; `pi-message-export.ts` now surfaces user-row `renderMessageId` to feed it.
- **DO steer branch matches the plan**: skeleton stamped `sentDuringStreaming`, persist-first ordering, `emitChatError` on failure, no-teardown invariant retested; the queued-prompt path (`:9618-9623`) was correctly left marker-free.
- **Chat.tsx**: `bridgeMessages` slice-gathering via `isSteerSliceIdOf`, and the `!turnSettled` gate on `assistantTurnActive`, both as specced.

## 5. Notes (accepted behavior, documenting so nobody chases them)

- Derived slice ids shift when a later steer arrives mid-stream (the segment that was the live tail becomes `::steerN` once a new final segment opens), causing a one-tick React remount of that block. Cosmetic, bounded to the streaming turn, accepted in the plan.
- During the optimistic window (send → skeleton broadcast) the bubble still renders at the tail before snapping to its seam — bounded by one persist round-trip, per the plan.
- Consider the plan's cuttable observability one-liner (`pi_steer_accepted` with `marked` / `raced_completion` status): after item 0, having a metric that separates "marker emitted" from "steer raced turn end" would have shortened this diagnosis. Optional.
