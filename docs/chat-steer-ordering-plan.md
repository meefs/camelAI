# Chat Steer Ordering + Stuck Working Indicator — Implementation Plan

**July 10, 2026** — supersedes the July 9 draft (never implemented); re-verified against main at `eeda0c263`, after the transcript-simplification Phases A/B (#975, #979, #982, #987) landed. All file/line references below are current.

---

## TL;DR

Two user-visible bugs when a message is sent **while the agent is streaming** (an "interrupt", technically a *steer*):

1. **Wrong order:** the steered user bubble renders at the bottom of the transcript and the agent's new tool calls / text keep streaming in **above** it; on other paths (reload, or once the persisted skeleton broadcast lands) the bubble instead jumps **above the entire turn**, including content that predates it. The correct rendering pins the bubble at the moment it was sent: pre-steer content above, post-steer content below. (The send animation itself is fine — do not touch it.)
2. **Stuck camel:** after a steered turn completes, the camel working indicator can spin forever even though the reply is done.

Root cause for both: since the ai-chat migration, **a whole turn streams into ONE render message** (one `UIMessage`, id = turnId), and the steered user bubble is a *sibling row*. Nothing anywhere maintains an ordering invariant between the bubble and the turn's content — the rendered order is an accident of optimistic-echo placement, persist timing, broadcast timing, and the upstream `ai`/`agents` replace-last-or-push merge. And because a steered turn's transcript then **ends on a user message**, the working indicator loses its natural "an assistant reply is now last" off-switch, so any laggy busy flag spins the camel with no backstop.

The fix makes ordering **metadata-driven instead of timing-driven**:

- **Server:** when a steer is accepted, emit a durable **`data-pi-steer-marker` part into the streaming turn message** at the current stream position (same pattern as the existing durable `data-pi-user-stop` / `data-pi-error` parts). The marker records which user bubble belongs at that spot.
- **Client:** a new pure module **splits the turn's message at its markers** and slots each steered bubble into its seam. Live view, reload, tab-switch resume, and second tabs all derive the same order from the same persisted parts.
- **Indicator:** with ordering fixed, a completed steered turn ends on an assistant message again; additionally clamp `assistantTurnActive` off whenever the transcript ends on a **completed** assistant message (it carries `pi.completedAtMs`), so a stuck/laggy busy flag can no longer spin the camel forever.

This reproduces the multi-chunk turn view (`A.1 / user / A.2`) that `chat-messages-view.tsx` still fully supports (`turnKey` grouping keyed on `sentDuringStreaming`), but server-authoritative and deterministic.

**No new UI components, no style changes, no changes to pi_core** (the model-side transcript and the same-content-same-id invariant from `docs/chat-transcript-simplification.md` are untouched).

---

## Background: what actually happens on a steer today

Read this first; the natural assumption (the steer bubble is inserted "after what has streamed so far, before what comes next") is **wrong** — nothing maintains that.

### One turn = one render message

- `ChatThreadDO.onChatMessage` mints one encoder per turn: `new PiChunkEncoder({ messageId: turnId })` (`workers/main/src/chat-thread-do.ts:9544-9545`); the encoder emits a single `start {messageId: turnId}` (`src/lib/pi-chunk-encoder.ts:233-240`). Every text delta / tool call / thinking block of the whole turn streams into that one `UIMessage`.
- Turn completion metadata (`pi.turnDurationMs`, `pi.completedAtMs`) is attached once by `encodeTurnCompleted` (`pi-chunk-encoder.ts:325-340`) at `turn/completed`.
- Chunks pushed before the ai-chat stream writer attaches are buffered and flushed after `encoder.start()` (`chat-thread-do.ts:9580-9589`), so event → chunk order is preserved even in the pre-attach window.

### The steer path (server) — `chat-thread-do.ts:9043-9083`

`sendRunnerCommand`'s `"message"` branch reads `wasStreaming = this.piSession.state.isStreaming` (`:9011`). When true:

1. The pi_core copy of the user message carries `metadata.sentDuringStreaming: true` (`:9023-9025`).
2. `steeredSkeleton = buildUserUiSkeleton({...})` (`:9050-9055`) — the durable render bubble. **Its id is the client's `clientMessageId`** (`buildUserUiSkeleton`, `:10114-10139`), which is how the client's optimistic echo reconciles. The skeleton does **not** carry `sentDuringStreaming` today.
3. The pi_core copy is stamped with the skeleton's id (`withPiRenderMessageId`, `:9056-9059`) — Phase A's same-content-same-id invariant, now covering user rows.
4. The steer is journaled durably (`recordPiTurnJournalSteerMessage`, `:9060`), then `waitUntil(async: refreshPiSessionModel() → piSession.steer(...) → persistMessages([...this.messages, steeredSkeleton]))` (`:9061-9081`).

Two properties of step 4 matter:

- The skeleton persist runs **last**, after an awaited model refresh; if `refreshPiSessionModel()` throws, the skeleton is never persisted and the failure only hits `console.error` (`:9075-9080`) — the user's message silently disappears from render history on the next reload. (The turn itself survives — asserted by `workers/main/tests/chat-thread-pi-turn.test.ts:10357`.)
- `this.messages` is ai-chat's **persisted** list. The in-flight assistant row is normally only persisted at stream end, but several paths persist or update it mid-turn (ai-chat recovery commits; `trimIncompleteLiveAssistantParts` / `stampLiveAssistantForkEntryIds`, `chat-thread-do.ts:4085-4157`), so the bubble-vs-turn-row `created_at` order is not guaranteed either way.

**A second, separate steer entry point** exists and needs **no** change: a fresh send that lands while the active-turn marker is already open is journaled + queued (`:9107-9125`), and `onChatMessage` prompts the first queued message and steers the rest **at stream start** (`:9618-9623`). Those bubbles are persisted via `saveMessages` *before* the turn's render message exists, so their array order (above the whole turn) is already deterministic and correct. Do not add markers there.

### The steer path (client)

- `Chat.tsx sendMessage` marks `wasSentDuringStreaming = assistantTurnActive` (`src/components/Chat.tsx:3916`) and appends the optimistic echo (with `sentDuringStreaming: true`, `:3965-3973`) to the committed-history echo list (`:3975-3989`) and the pending overlay (`:3996-4007`). Steers intentionally skip the spacer + forced scroll (`shouldRenderSpacer` excludes `sentDuringStreaming`, `:2905-2909`) — this is the send animation that already works; keep it.
- The display pipeline is `piChat.messages` → `baseMessages` (+ tab-switch bridge, `:968-974`) → `displayMessages = mergeOverlay(baseMessages, optimistic)` (`:977-992`). `mergeOverlay` (`src/lib/runtime-message-state.ts:20-45`) inserts non-steer additions *above* the trailing run of `sentDuringStreaming` echoes — its doc comment (`:12-18`) literally encodes the old design: steer echoes "must render below" the live assistant. So until the skeleton broadcast lands, the bubble is pinned at the tail while content grows above it.
- When the skeleton's persist broadcast arrives, `useAgentChat` replaces its message array with the server list and re-merges the in-flight stream accumulator by id: found → replace **in place**; not found → **append at the end**. So the final order depends on whether the turn row happened to be persisted before the steer — if it was, every subsequent chunk keeps growing it **above** the bubble for the rest of the turn.
- `dedupeUiMessagesById` (`src/lib/use-pi-chat-stream.ts:123`) survives as an id-identity safety net for the upstream replace-last-or-push defect (see `docs/chat-transcript-simplification.md` § Upstream defects); the comment at `:298-299` already acknowledges "a steering user skeleton can land below [the streaming assistant] mid-turn".

### Why the order breaks — no invariant, three accidents

| Path | Resulting order | Sticky? |
| --- | --- | --- |
| Optimistic window (send → skeleton broadcast lands; today that waits behind the model refresh) | bubble at tail, content streams **above** it | until broadcast lands |
| Broadcast lands, turn row **not** yet persisted (common) | accumulator re-appends the turn row at the tail → bubble jumps **above the whole turn**, including pre-steer content | yes — and reload shows the same (`created_at`: skeleton mid-turn < turn row at turn end) |
| Turn row **was** persisted mid-turn (recovery commit, transient-retry commit, resume trim) | broadcast has `[…, turn, skeleton]`; in-place merge keeps all subsequent content streaming **above** the bubble | yes — for the rest of the turn and settled |
| `refreshPiSessionModel()` throws | skeleton never persisted; echo orphaned client-side; message gone from history on reload | yes |

None of these is the designed `A.1 / bubble / A.2` interleave. Settled order is just `created_at` insert order, so whatever accident happened is what a reload shows.

### Why the camel sticks

`showGlobalAssistantIndicator = assistantTurnActive && !isCompacting` (`Chat.tsx:2896`), where (`:2890-2895`):

```ts
const assistantTurnActive =
  loading ||                                // Chat.tsx local send state
  isStreaming ||                            // useAgentChat stream state (stall-clamped)
  isAwaitingAssistant ||                    // deriveIsAwaitingAssistant(...)
  activeAssistantMessageId !== null ||      // = piChat.streamingMessageId
  activeThreadRunningState.isRunning;       // sidebar chat-groups running flag
```

The designed off-switch is "the transcript now ends on an assistant message" (`deriveIsAwaitingAssistant` / `isAssistantLikeMessage`, `src/lib/chat-working-indicator.ts:31-45`). After a steer the transcript ends on the **user bubble**, so that guard never trips and the camel's fate rests entirely on all five flags clearing promptly. Known failure modes:

- A steer creates **no ai-chat turn** (the DO uses `persistMessages`, not `saveMessages`). `sendMessage` sets `loading = true` unconditionally (`Chat.tsx:4027/4037`), but `loading` is only cleared by the busy→idle transition effect (`:2802-2828`, `setLoading(false)` at `:2820`). If the send lands when no busy window subsequently opens and closes on this client (stream already dead, lost terminal frames, stalled resume), nothing ever clears it.
- `isStreaming`: lost terminal frames strand it until the 12-minute stall clamp (`STREAM_PROGRESS_STALE_MS`, `use-pi-chat-stream.ts:36`, clamp at `:295`).
- `activeThreadRunningState.isRunning`: server-fed with its own liveness-lease/alarm-sweep self-heal (#969) — expected to be stale sometimes.

So bug 2 = bug 1's ordering damage (no assistant-last fallback) + any laggy busy flag. Fix both sides: restore the ordering, and add an explicit "turn settled" clamp that doesn't depend on the flags.

---

## Design

### Target rendering

One turn, steered once, mid-stream ("┄" = still streaming). Everything below uses **existing components as-is** — `MessageBubble` for user bubbles, `TurnSummaryBar` for chunk summaries, the existing camel working indicator; no new components, no styling changes:

```
┌──────────────────────────────────────────────┐
│                        ┌───────────────────┐ │
│                        │ user: build an app│ │   original prompt
│                        └───────────────────┘ │
│  ▸ worked · 3 steps · show work              │   turn slice A.1 (settled chunk)
│                        ┌───────────────────┐ │
│                        │ user: use sqlite  │ │   steer — pinned AT ITS SEAM
│                        └───────────────────┘ │
│  ● Running command bun add better-sqlite3 ┄  │   turn slice A.2 (live, BELOW bubble)
│  🐫 0:42                                     │   camel + elapsed at the bottom
└──────────────────────────────────────────────┘
```

After `turn/completed`:

```
│  ▸ worked · 3 steps · show work              │   slice A.1  (no duration — intermediate)
│                        ┌───────────────────┐ │
│                        │ user: use sqlite  │ │   steer
│                        └───────────────────┘ │
│  ▸ worked for 2:31 · 9 steps · show work     │   slice A.2 = FINAL chunk: duration badge
│  Done — the app now uses SQLite. …           │   final answer text
│                                              │   (camel gone: last message is assistant)
```

This is exactly the multi-chunk layout `chat-messages-view.tsx` already renders: chunks before/after a `sentDuringStreaming` bubble share one `turnKey` (`src/components/chat-messages-view.tsx:167-169` + `:181-186/:229-234` — steer bubbles don't advance `lastFreshPromptUserMessageId`), `isFinalChunkOfTurn` (`:320-323`) selects the last chunk, and only the final chunk renders the final answer + duration badge via the `completedTurns` prop (`:406-413`; `useCompletedTurns` keys on the assistant message id carrying `turnDurationMs`, `src/hooks/use-completed-turns.tsx:53-67`). Intermediate chunks render `TurnSummaryBar` without an action row (`:462-468`).

### Data flow

```
steer accepted (DO, sendRunnerCommand wasStreaming branch — all sync until waitUntil)
  ├─ journal steer (existing, :9060)
  ├─ pushChatEvent({type:'steer-marker', steerMessageId: skeleton.id,        ← NEW
  │                 acceptedAtMs})
  │     └─ writePiStreamChunks relay → encoder.encodeSteerMarker(...)
  │        → chunk {type:'data-pi-steer-marker', id:`pi:steer:${skeletonId}`,
  │                 data:{steerMessageId, acceptedAtMs}}   (non-transient →
  │                 persists inside the turn UIMessage's parts, in stream order)
  └─ waitUntil: persistMessages(skeleton) FIRST, then refresh + steer()      ← reordered
       └─ on failure: emitChatError(...)                                     ← new signal

client render (usePiChatStream)
  chat.messages ──dedupe──▶ uiMessages(raw) ──split──▶ displayUiMessages ──adapt──▶ renderer
                                │  turn parts: [p1 p2 | marker(u2) | p3 p4]
                                │  bubbles anywhere in array: u1, u2
                                └─ output: u1, A#0(p1 p2), u2, A(p3 p4)
                                   (LAST EMITTED slice keeps original id + metadata)
  raw uiMessages / streamingMessageId stay exposed unsplit (seeds, loader
  reconciliation, snapshot capture, bridge expiry all key on the raw id)
```

Because the marker is a **persisted part inside the turn message**, the order no longer depends on row `created_at`, broadcast timing, accumulator merge position, or overlay placement — every surface (live, reload, resume replay, second tab, snapshot seed) derives the same interleave from the same bytes. The one residual gap: between send and the skeleton broadcast, the optimistic echo still renders at the tail (the marker has no matching bubble yet, so the split holds). Reordering the persist to run first shrinks that to one persist round-trip; it then snaps to the seam.

### Key invariants preserved

- pi_core is untouched; `renderMessageId` stamping is untouched. The turn still folds into ONE durable `UIMessage` — same-content-same-id holds. The split is a **render-layer view** of that message.
- The **last emitted slice keeps the original UIMessage id** (turnId) **and full metadata**. Earlier slices get derived ids (`${id}::steer${index}`). Consequences (all deliberate):
  - `streamingMessageId` (last assistant in **raw** `uiMessages`, `use-pi-chat-stream.ts:300-306`) equals the rendered final slice's id → `activeAssistantMessageId`, streaming-flag application in the adapt memo (`:338-344`), and action-row placement keep working unchanged.
  - `completedTurns` is keyed by the message id carrying `turnDurationMs` → the final slice gets the duration badge; intermediate slices have no entry and `isFinalChunkOfTurn` is false for them anyway.
  - Fork/copy anchors on the final chunk are unchanged.
- Seeds and snapshots stay **raw/unsplit**: the snapshot captures `piChat.uiMessages` raw (`Chat.tsx:775-792`), `resolveDisplayChatData` excludes the raw streaming id from the seed (`src/lib/chat-thread-display.ts:34-54`), and loader reconciliation compares raw lists (`Chat.tsx:1062-1076`). The split happens strictly between dedupe and adaptation.

---

## Implementation

### Phase 1 — required

#### 1. Encoder: `data-pi-steer-marker` part — `src/lib/pi-chunk-encoder.ts`

- Next to the existing part-id exports (`:151-156`), add:

```ts
export const PI_STEER_MARKER_PART = 'data-pi-steer-marker';
export const piSteerMarkerPartId = (steerMessageId: string) => `pi:steer:${steerMessageId}`;
export interface PiSteerMarkerData { steerMessageId: string; acceptedAtMs: number; }
```

- Extend the `PiUiMessageChunk` union (`:141-145`) with `{ type: 'data-pi-steer-marker'; id: string; data: PiSteerMarkerData }`.
- Add a public method mirroring the `userStop` branch (`:367-375`):

```ts
encodeSteerMarker(steerMessageId: string, acceptedAtMs: number): PiUiMessageChunk[] {
  if (this.finished) return [];
  const chunks = this.closeOpen();      // clean split point: close open text/reasoning slots
  chunks.push({
    type: 'data-pi-steer-marker',
    id: piSteerMarkerPartId(steerMessageId),
    data: { steerMessageId, acceptedAtMs },
  });
  return chunks;
}
```

Unlike `data-pi-user-stop` (fixed part id, one per turn), the part id is **per-steer** — multiple steers in one turn produce distinct parts, and a re-delivered/replayed marker chunk replaces its own part in place (AI SDK data parts with an id are idempotent) instead of duplicating or moving.

#### 2. DO steer path — `workers/main/src/chat-thread-do.ts`

**Relay branch** — in `writePiStreamChunks` (`:9399-9463`), add an envelope branch beside the `"error"` one (`:9417-9458`):

```ts
} else if (envelope.type === "steer-marker") {
  const steerMessageId = typeof envelope.steerMessageId === "string" ? envelope.steerMessageId : "";
  const acceptedAtMs = typeof envelope.acceptedAtMs === "number" ? envelope.acceptedAtMs : Date.now();
  if (!steerMessageId) return;
  chunks = encoder.encodeSteerMarker(steerMessageId, acceptedAtMs);
}
```

(The `encoder` null-check at the top of the function already makes this a no-op when no turn is bridging; `encodeSteerMarker` returning `[]` after `finish` makes the raced-completion case a no-op too.)

**Steer branch** (`:9043-9083`) — three changes:

1. **Push the marker synchronously at accept** (before the `waitUntil`, right after `recordPiTurnJournalSteerMessage`), so its stream position matches send time:
   `this.pushChatEvent({ type: "steer-marker", steerMessageId: steeredSkeleton.id, acceptedAtMs: Date.now() });`
   If the turn raced to completion (encoder gone/finished), the marker no-ops and the bubble renders at its array position — correct for a steer that will be re-delivered as the next turn's prompt.
2. **Reorder the `waitUntil` body: persist the skeleton FIRST, then refresh + steer**, and surface failures. The render append has no dependency on the model refresh, and today a refresh failure silently loses the user's bubble:

```ts
this.ctx.waitUntil(
  (async () => {
    // Append the steered bubble to the linear render history directly
    // (persistMessages, NOT saveMessages — the latter would enqueue a
    // second ai-chat turn). Persist BEFORE the model refresh: the bubble
    // must survive a refresh failure.
    await this.persistMessages([...this.messages, steeredSkeleton]);
    if (!this.piSession) return;
    await this.refreshPiSessionModel();
    if (!this.piSession) return;
    this.piSession.steer(stampedSteerMessage);
  })().catch((error) => {
    console.error("[ChatThreadDO] failed to steer / persist steered user render message", error);
    this.emitChatError("Your message could not be delivered to the running turn. Please resend it.");
  }),
);
```

   `emitChatError` (the helper wrapping `pushChatEvent({ type: "error", ... })`, `:9277`) replaces today's silent loss — error-handling culture. Keep the existing guarantee from the `:10357` test: a steer-side failure must NOT tear down the in-flight turn.
3. **Stamp the skeleton as a steer**: give `buildUserUiSkeleton` (`:10114-10139`) a new `sentDuringStreaming?: boolean` arg that sets `metadata.sentDuringStreaming = true`; pass `true` only from this call site (`:9050-9055`). (The pi_core copy already carries the flag at `:9023-9025`; the render skeleton currently doesn't, which breaks `turnKey` grouping and the spacer exclusion after any reload.)

Do **not** touch the queued-prompt steer path (`:9618-9623`) — see Non-goals.

#### 3. Adapter — `src/lib/ui-message-adapter.ts`

- `uiMessageToMessage`: after the `pi.*` unpacking (`:263-273`), map `ui.metadata.sentDuringStreaming === true` → `message.sentDuringStreaming = true`. (The legacy `Message` type already has the field; today the adapter drops it, so persisted steer bubbles come back falsy and would advance `lastFreshPromptUserMessageId`, breaking the chunk grouping — see the reads at `chat-messages-view.tsx:183/:231`, `Chat.tsx:2907`, `runtime-message-state.ts:40`.)
- `data-pi-steer-marker` parts must produce **no content block** — they already fall into the ignored `default` branch (`:241-248`); extend that branch's comment so nobody "fixes" it. (The split strips markers before adaptation anyway; this is belt-and-suspenders for raw-list consumers.)
- `messageToUiMessage` (backfill direction, `:471-479`): for user messages whose source row metadata carries `sentDuringStreaming: true` (the pi_core copy stamped at `chat-thread-do.ts:9023-9025`), stamp `metadata.sentDuringStreaming = true` on the produced UIMessage. This is what makes **rebuilt** steer bubbles (Phase 2, admin resync, fork seeding) group correctly.

#### 4. New module: `src/lib/steer-split.ts` (pure, unit-tested)

```ts
export function splitUiMessagesAtSteerMarkers(
  uiMessages: UIMessage[],
  opts: { streamingMessageId: string | null },
): UIMessage[];
export function isSteerSliceIdOf(rawId: string, id: string): boolean; // id === rawId || id.startsWith(`${rawId}::steer`)
```

Spec:

- For each **assistant** message containing `data-pi-steer-marker` parts, partition its parts into segments at each marker (markers themselves are dropped from segments).
- A marker whose `steerMessageId` matches a **user message anywhere in the array** (before or after the turn message — reload puts it before, live puts it after) "consumes" that bubble: remove it from its array position and emit it between the two segments. A marker with no matching bubble present does **not** split (join the adjacent segments) — no phantom gaps while the skeleton broadcast is in flight.
- Emitted slices:
  - The **last emitted slice** keeps the **original id and original `metadata`** (this is where `pi.completedAtMs` / `turnDurationMs` live). Earlier slices get id `` `${id}::steer${index}` `` and metadata reduced to `{ pi: { createdAtMs } }` (copied from the source, so `uiMessageCreatedAtMs` — `ui-message-adapter.ts:85-102` — still resolves; they must NOT carry `turnDurationMs`, or `useCompletedTurns` would badge them).
  - Empty segments: drop empty **leading/middle** segments. While the message is still streaming (`opts.streamingMessageId === message.id`), **keep** an empty final segment (the live group must exist below the bubble immediately after a steer). Once settled, drop an empty final segment — the "last emitted slice keeps original id + metadata" rule then applies to the last non-empty slice, so completion metadata is never lost even when a steer arrives after the turn's last content (the bubble then renders after the whole turn, which is the honest order for that case).
- Messages without markers, and user messages not referenced by any marker, pass through **preserving object identity** and array order (exact fallback = today's behavior; covers pre-deploy history and re-drives where markers were lost).
- Stability/memoization: the downstream adapt cache is a WeakMap keyed by UIMessage object identity (`use-pi-chat-stream.ts:329`), so settled slices must be **stable objects across renders**. Do NOT memoize per source message alone — a source turn message's split output changes when its matching bubble later arrives in the array. Keep a small cache keyed by source message id holding `{ sourceRef, consumedBubbleRefs, slices }` and reuse `slices` only when the source object identity AND every consumed bubble's object identity are unchanged (the streaming message is a fresh object each tick anyway, so it recomputes naturally).

#### 5. Hook integration — `src/lib/use-pi-chat-stream.ts`

- Apply the split strictly between dedupe and adaptation:

```ts
const uiMessages = useMemo(() => dedupeUiMessagesById(chat.messages), [chat.messages]); // :234-237, unchanged
// streamingMessageId stays derived from RAW uiMessages (:300-306, unchanged)
const displayUiMessages = useMemo(
  () => splitUiMessagesAtSteerMarkers(uiMessages, { streamingMessageId }),
  [uiMessages, streamingMessageId],
);
// The adapt memo (:330-346) maps displayUiMessages instead of uiMessages.
```

- The hook's returned `uiMessages` (`:355-362`) stays the **raw** list — snapshot capture (`Chat.tsx:779`), seed reconciliation (`Chat.tsx:1072-1076`), and bridge expiry (`Chat.tsx:948`) all must keep operating on raw ids. Only the adapted `messages` are built from the split view.
- The streaming-flag and `mergeLiveToolOutput` post-steps in the adapt memo key on `streamingMessageId` — the final slice keeps that id, so they land on the right slice with no changes.

#### 6. Tab-switch bridge — `src/components/Chat.tsx:946-962`

The snapshot's legacy `messages` are the rendered (post-split) view, so after this change the captured copy of a mid-steered turn is several slices, not one message. The bridge currently picks the single message with `id === bridgedStreamingMessageId`, which would drop the pre-steer slices during the paint gap. Change `bridgeMessage` (single) to `bridgeMessages` (array): filter `parsedInitialMessages` with `isSteerSliceIdOf(bridgedStreamingMessageId, message.id)` preserving order, and append the array in `baseMessages` (`:968-974`). The steer bubble itself is a separate persisted row already present in the seed, so it needs no bridging; during the ≤15s gap the bubble renders above the bridged slices — the same coarse order today's whole-turn bridge shows — and the resumed stream re-delivers the marked message, after which the split restores the exact interleave.

#### 7. Working-indicator clamp — `src/lib/chat-working-indicator.ts` + `Chat.tsx`

Add a pure helper next to `deriveIsAwaitingAssistant`:

```ts
/** The transcript's last message is a finished assistant reply: role assistant
 * (or compact summary) AND carrying turn-completion metadata. Any newer send
 * re-enables busy state by appending a user message. */
export function deriveTurnSettled(lastMessage: Message | null | undefined): boolean {
  return (
    isAssistantLikeMessage(lastMessage) &&
    typeof lastMessage?.completedAtMs === "number"
  );
}
```

In `Chat.tsx` (`:2890-2896`; `lastMessage` is already in scope from `:2867`):

```ts
const turnSettled = deriveTurnSettled(lastMessage);
const assistantTurnActive =
  !turnSettled &&
  (loading || isStreaming || isAwaitingAssistant ||
   activeAssistantMessageId !== null || activeThreadRunningState.isRunning);
```

Why gate `assistantTurnActive` itself (not just the camel): a stuck busy flag also keeps the composer in stop-mode and misclassifies the *next* send as a steer on the client (`wasSentDuringStreaming = assistantTurnActive`, `:3916`). The server decides steer-vs-prompt from its own state, so this only fixes client behavior — but it's the same one-line gate. Safety:

- `completedAtMs` reaches the legacy message via the adapter (`ui-message-adapter.ts:271-273`) from the `message-metadata` chunk emitted at `turn/completed` — mid-turn the streaming slice has no `completedAtMs`, so the clamp can't fire early.
- Any next send puts a user bubble at the tail (optimistic echo or persisted skeleton) → clamp releases → `loading` shows the camel. Exactly today's flow.
- Compaction renders its own indicator on `isCompacting` — unaffected.

#### 8. Tests (Phase 1)

| File | What to assert |
| --- | --- |
| `tests/pi-chunk-encoder.test.ts` | `encodeSteerMarker` closes open text/reasoning slots and emits the id-stamped data part; returns `[]` after `finish`; two steers → two distinct part ids. |
| `tests/steer-split.test.ts` (new) | marker+bubble (bubble after AND before the turn message) → interleave; marker w/o bubble → no split; bubble w/o marker → array order; multiple steers; empty final segment kept only while streaming; settled empty-final fold-back keeps original id+metadata on the last non-empty slice; earlier slices carry no `turnDurationMs`; pass-through and settled slices are identity-stable across calls. |
| `tests/ui-message-adapter.test.ts` | `sentDuringStreaming` round-trips both directions; `data-pi-steer-marker` part yields no blocks. |
| `tests/chat-working-indicator.test.ts` | `deriveTurnSettled` truth table (assistant+completedAtMs → true; streaming assistant w/o metadata → false; user tail → false; compact summary + completedAtMs → true). |
| `tests/chat-messages-view-collapsed-turn.test.tsx` | slices + steer bubble group into ONE logical turn (`turnKey`): intermediate slice renders summary without duration, final slice gets duration + final answer. |
| `workers/main/tests/chat-thread-pi-turn.test.ts` | steer branch: marker envelope pushed synchronously at accept (before any await); skeleton persisted even when `refreshPiSessionModel` throws (and `emitChatError` fired); existing `:8442` journal-before-steer and `:10357` no-teardown assertions still hold. |

Run: `bun run typecheck`, `bun run test:run -- tests/steer-split.test.ts tests/pi-chunk-encoder.test.ts tests/ui-message-adapter.test.ts tests/chat-working-indicator.test.ts tests/chat-messages-view-collapsed-turn.test.tsx`, `bun run test:workers -- workers/main/tests/chat-thread-pi-turn.test.ts`.

End-to-end check (local dev, live model): start a long agentic turn, steer mid-tools, confirm (a) the bubble snaps to its seam with new tool calls below it, (b) a reload mid-turn shows the same order, (c) at completion the camel disappears and the final chunk shows the duration badge, (d) a tab switch mid-steered-turn repaints without losing the pre-steer chunk.

### Phase 2 — required but severable (separate commit)

**Rebuild-path parity + latent clobber fix — `topUpUiMessagesFromPiCore` (`chat-thread-do.ts:10232-10434`).**

The fold groups only **consecutive** stamped assistant rows (`:10317-10341`), and `existingIds` is snapshotted before the loop (`:10271`). A steered turn's pi_core order is `[…assistantRows(turnId), steerUserRow, assistantRows(turnId)…]`, so any full rebuild (`rebuildUiMessagesFromPiCore`, `:3576-3589` — admin resync, fork seeding, every history-invalidating pi_core rewrite) converts **two groups with the same id**, and `persistMessages`' upsert (`:10413`) makes the second clobber the first — the pre-steer half of the turn is silently lost. The live path only dodges this because the stream already wrote the single row (id-existence skip at `:10347-10349`).

Fix: fold **all** same-stamp assistant groups into ONE UIMessage (parts concatenated in commit order — the merge key is `renderMessageId`, regardless of interposed rows), inserting a synthetic `data-pi-steer-marker` part at each seam. The marker's `steerMessageId` = the interposed user row's `uiMetadata.renderMessageId` stamp when present (stamped since Phase A, `:9056-9059`); for a row being converted in this same pass without a stamp, use the id its converted UIMessage gets; for a skipped legacy row matched by `piCoreMessageKey`, use the matched existing message's id; if nothing resolves, emit the marker with the row-derived id anyway — an unmatched marker joins segments client-side, so the worst case is "content preserved, bubble positional" (still strictly better than the clobber). The merged message's `created_at` keeps the first group's monotonic slot; interposed user rows keep their own. Result: a rebuilt thread renders byte-identically to the live view (the client split does the rest).

Test in `workers/main/tests/chat-thread-pi-stream-bridge.test.ts` (the file covering the top-up/backfill): steered pi_core fixture → force rebuild → ONE assistant row containing both halves' parts with a marker at the seam, user row present between-stamps in array order, and `metadata.sentDuringStreaming` on the rebuilt bubble (via item 3's `messageToUiMessage` change). Run: `bun run test:workers -- workers/main/tests/chat-thread-pi-stream-bridge.test.ts`.

### Cuttable (do NOT block the fix on these)

- **Recovery marker re-injection:** a recovery re-drive that rebuilds the render row from pi events alone loses markers for steers accepted before the cut (their bubbles fall back to array order — graceful). Could be restored from the steer journal at re-drive time. Rare path; skip.
- **Observability:** a `recordChatThreadObservabilityEvent("pi_steer_accepted", { status: encoderAttached ? "marked" : "raced_completion" })` in the steer branch would make marker coverage measurable. One-liner; nice-to-have.
- **Sidebar running-state hardening:** dispatch `dispatchLocalThreadStatus(threadId, "idle")` when `turnSettled` first becomes true so a stale sidebar shimmer clears with the camel. The sidebar already has a server-side self-heal sweep (#969).

### Non-goals

- **Queued-prompt steers** (`chat-thread-do.ts:9618-9623`) get **no markers**: their skeletons are persisted via `saveMessages` before the turn's render message exists, so they deterministically render above the whole turn — which is correct, since they steer it from position zero.
- No patches/forks of `agents` or `@cloudflare/ai-chat`; the upstream replace-last-or-push merge stays as-is — the split makes render order independent of it (and `dedupeUiMessagesById` stays as the id-identity net; see `docs/chat-transcript-simplification.md`).
- No changes to pi_core ordering or stamping; the model transcript and same-content-same-id invariant are untouched.
- No changes to the send animation, spacer, or scroll behavior (`shouldRenderSpacer` and the steer's no-spacer path stay exactly as they are). `mergeOverlay`'s reposition loop (`runtime-message-state.ts:39-44`) still governs only the pre-broadcast optimistic gap; leave it.
- No visual redesign of bubbles, summaries, or the camel indicator.

---

## Failure-mode walkthrough (why this is now deterministic)

| Scenario | Old outcome | New outcome |
| --- | --- | --- |
| Normal steer, no mid-turn persist | bubble at tail while streaming, then jumps above the whole turn when the broadcast lands; reload shows bubble above the turn | marker splits the turn message; bubble at its seam everywhere (sub-second optimistic window remains, now bounded by one persist round-trip) |
| Recovery / transient-retry persisted the partial turn row before the steer | content streams above the bubble for the rest of the turn; reload same | irrelevant — the split derives order from marker parts, not row order |
| `refreshPiSessionModel()` throws | user's bubble silently vanishes; only a console.error | bubble persisted first; inline chat error tells the user delivery failed; turn untouched |
| Tab switch / second tab mid-steered-turn | seed order arbitrary; bridge paints the whole turn below the bubble | raw seed + replay rebuild the same marked message; split re-derives the same order; bridge carries all slices |
| Steer lands as the turn completes (encoder finished) | bubble at tail | same (marker no-ops; the steer is journaled and re-delivered as the next turn's prompt) |
| Turn completes; a busy flag lags (lost terminal frame, stuck `loading`, stale sidebar state) | camel spins (up to the 12-min stall clamp / sidebar sweep) | tail is a completed assistant slice → `deriveTurnSettled` clamps the indicator off immediately |
| Steer accepted after the last content, then turn ends (empty final segment) | n/a | empty final segment folds back: last content slice keeps id+metadata, bubble renders after the turn; clamp defers to the normal flag path |

## Rollout / compat

- Threads created before this change have no markers and no skeleton `sentDuringStreaming`: the split passes them through untouched → rendering identical to today. No migration.
- A turn straddling the deploy lacks markers for steers accepted before it — fallback order, self-corrects on the next turn.
- Ship Phase 1 as one PR (server + client are forward/backward compatible: old clients ignore the unknown data part via the adapter's default branch; new clients without markers just don't split). Phase 2 rides separately.
