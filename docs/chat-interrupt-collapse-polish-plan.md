# Chat Interrupt-Collapse Polish — Implementation Plan

**June 8, 2026**

---

## TL;DR

When a user sends a message **while the agent is actively working** ("interrupt" in the everyday sense — technically a *steer*), the chunk of agent work being interrupted immediately collapses into a `TurnSummaryBar` that reads **`worked for 0:00 · N steps · show work`** and draws a hairline `<hr>` under itself even though there is no final agent message beneath it.

Three problems, fixed entirely in the frontend (**no backend change**):

1. **`worked for 0:00`** — interrupted chunks never receive a `turn/completed` event, so their duration falls back to ~0.
2. **Clunky `<hr>`** — the hairline is meant to separate the summary from the agent's final reply; with no reply it is dead padding. *(Wanted regardless of everything else.)*
3. **Premature collapse** — the interrupted chunk collapses the instant the user steers, instead of staying open until the whole turn finishes.

The work is built on a small **shared foundation** (recognizing which chunks belong to one logical turn, and which chunk is that turn's *final* chunk), then split into two phases:

- **Phase 1 — presentation:** an interrupted/intermediate chunk renders as a pure `N steps · show work` summary — no duration, no `<hr>`, no final-answer bubble — and any text it happens to contain is folded into its *show work* trace. The turn's final chunk keeps the duration + hairline + final answer.
- **Phase 2 — deferred collapse:** while the turn is still running, its already-interrupted chunks stay fully expanded; when the turn completes they all collapse together, reusing the existing completion-collapse animation.

Phase 1 is independently shippable. The classification it depends on is **structural and stable**, not derived from any transient "just completed" flag, so an interrupted chunk stays classified as intermediate forever — even one that ends with a stray sentence of assistant text.

---

## Background: how an "interrupt" actually works today

This is the single most important thing to understand before touching anything, because the natural assumption (each interrupt = its own finished turn) is **wrong**.

Sending a message while the agent is working is a **steer**, not a stop:

- **Client** (`src/components/Chat.tsx`, `sendMessage`): it records `wasSentDuringStreaming = assistantTurnActive` (`Chat.tsx:4575`) and stamps the new user `Message` with **`sentDuringStreaming: true`** (`Chat.tsx:4632`). It then calls `splitStreamingMessageForSteer` (`src/lib/runtime-message-state.ts:420`), which **finalizes** the in-flight assistant message, appends the user message, and starts a **new** streaming assistant message. No stop signal is sent.
- **Backend** (`workers/main/src/chat-thread-do.ts`): while the Pi session is streaming, the new message is delivered with `piSession.steer(userMessage)` (`chat-thread-do.ts:11812`) — the **same turn keeps running**. Only a message sent while idle calls `piSession.prompt(...)` and starts a new turn. The runtime event **`turn/completed` is emitted exactly once per turn**, on the main agent's `agent_end` (`chat-thread-do.ts:11618`), carrying `turnDurationMs` = the full `agent_start → agent_end` span.

So one logical turn with two interrupts looks like this in `visibleMessages`:

```
user A (original prompt — sentDuringStreaming = false/absent)
assistant A.1   ← finalized by the 1st steer
user 1          (sentDuringStreaming = true)
assistant A.2   ← finalized by the 2nd steer
user 2          (sentDuringStreaming = true)
assistant A.3   ← streams to completion → fires turn/completed
```

`src/components/chat-messages-view.tsx` groups *consecutive* assistant messages, so the user messages split the turn into three groups (A.1 / A.2 / A.3). `completedTurns` only ever gets an entry for **A.3** (the one chunk that received `turn/completed`).

### Why the duration is `0:00`

For a chunk with no `completedTurns` entry, the duration comes from `fallbackDurationMs` (`chat-messages-view.tsx:189`):

```ts
Math.max(0, actionMessage.created_at - precedingUserMessage.created_at)
```

Each interrupted chunk is a single assistant message created at essentially the same instant as the user message immediately before it (the split stamps the new streaming message with `created_at: Date.now()` right when the steer is sent). So the difference is ~0 → **`0:00`**, every time.

This is also why we are **not** going to "track intermediary work time": honest per-chunk durations would require new backend plumbing. Instead we **don't show a duration where we don't have a real one** — which is also how the tool the spec references behaves (time lives next to the final answer, not on every work chunk).

---

## The two render paths in `chat-messages-view.tsx` today

Each group renders through one of two branches inside `messageGroups.map(...)`:

- **Summary path** (`shouldShowSummary === true`, lines ~327–407): wraps a single merged trace message in `<TurnSummaryBar>` (which always draws the `<hr>` at `turn-summary-bar.tsx:89`) and renders a separate `final-text-only` `MessageBubble` below it.
- **Full path** (the bottom `return`, lines ~409–417): renders every message in the group normally (the live trace).

```ts
const isActiveTurn =
  messageGroup.isAssistantTurn &&
  messageGroup.actionMessageId === activeTurnActionMessageId;
const shouldShowSummary =
  messageGroup.isAssistantTurn && !isActiveTurn && messageGroup.stepCount > 0;
```

While a chunk is the **active** (streaming) turn it uses the full path; the moment it stops being active it flips to the summary path. That flip is exactly what makes A.1 collapse the instant A.2 begins.

The freshly-completed turn animates closed because `Chat.tsx` sets `freshlyCompletedTurnId` to the completing chunk's id, and `TurnSummaryBar` mounts expanded then collapses on the next frame (`animateOnMount`). **Phase 2 generalizes this from "the one final chunk" to "every chunk of the turn."**

---

## Visual design

### Today (buggy)

The instant the user sends `also add dark mode`, A.1 collapses:

```
worked for 0:00 · 14 steps · show work  ›      ← wrong time
──────────────────────────────────────────     ← pointless hr (no message under it)

┌ also add dark mode ─────────────────────┐
└──────────────────────────────────────────┘
   ● Read theme.ts …                           ← A.2 streaming
```

### Target — Phase 1 only (immediate collapse, but clean)

If only Phase 1 ships, the chunk still collapses immediately, but cleanly — no fake time, no dangling hairline. Any text it contained is reachable under *show work*:

```
14 steps · show work  ›

┌ also add dark mode ─────────────────────┐
└──────────────────────────────────────────┘
   ● Read theme.ts …
```

### Target — Phase 2, while the turn is still running

Nothing from the current turn collapses yet. A.1 and A.2 stay as finalized, fully-expanded traces (no streaming dots); A.3 streams live:

```
┌ Build me a dashboard ───────────────────┐
└──────────────────────────────────────────┘
   ● Read package.json
   ● Edited app.tsx (+40)                       ← A.1  (finalized, full trace)
   ● Ran tests

┌ also add dark mode ─────────────────────┐
└──────────────────────────────────────────┘
   ● Read theme.ts
   ● Edited theme.ts (+12)                       ← A.2  (finalized, full trace)

┌ and a settings page ────────────────────┐
└──────────────────────────────────────────┘
   ● Creating settings.tsx…                      ← A.3  (LIVE / active)
   ▌ working…
```

### Target — Phase 2, the moment the turn completes

`turn/completed` fires for A.3; **all three chunks collapse together** with the same animation. Duration shows **only** on the final chunk (A.3 already has the real full-turn `turnDurationMs`). No hairline except above the final reply:

```
14 steps · show work  ›                          ← A.1  (no time, no hr)

┌ also add dark mode ─────────────────────┐
└──────────────────────────────────────────┘
6 steps · show work  ›                           ← A.2  (no time, no hr)

┌ and a settings page ────────────────────┐
└──────────────────────────────────────────┘
worked for 3:42 · 9 steps · show work  ›         ← A.3  (full-turn time)
──────────────────────────────────────────       ← hr  (only here)
Done! I built the dashboard with dark mode and
a settings page. …                                ← A.3 final message
```

This matches the requested end-order exactly: `A.1, user 1, A.2, user 2, A.3 (+ final message)`.

---

## Shared foundation: turn membership & final-chunk classification

Both phases need to know (a) that A.1/A.2/A.3 belong to one logical turn, and (b) which of them is that turn's **final** chunk (the only one allowed to show a duration, an `<hr>`, and a final-answer bubble).

> **Why a structural signal, not `finalOutputMessage !== null`.** An interrupted chunk can end with a stray sentence of assistant text (the agent narrated, then the user steered before the next tool call). `buildFinalOutputMessageView` (`src/lib/turn-utils.ts:210`) returns non-null for any visible text after the last tool/thinking block, so it would mark such a chunk as having a "final answer." Keying chrome off it would still leak `0:00`, the `<hr>`, and a final-answer bubble onto A.1/A.2. The correct question is **"is this the concluding chunk of its turn?"**, which is purely positional.

### `turnKey` — which turn a chunk belongs to

A turn's original prompt is a direct user message with `sentDuringStreaming !== true`; every steer carries `sentDuringStreaming === true`. So all chunks of one steered turn share the **same most-recent original prompt**, whose id is a stable per-turn key.

In the `messageGroups` memo (`chat-messages-view.tsx:138`):

- Track the original prompt alongside `lastDirectUserMessage`:
  ```ts
  let lastFreshPromptUserMessageId: string | undefined;
  ```
- Update it only for non-steer direct user messages, in **both** places the loop already updates `lastDirectUserMessage` (the cache-hit branch ~171 and the rebuild branch ~215):
  ```ts
  if (!isAssistantTurn && isDirectUserMessage(firstMessage)) {
    lastDirectUserMessage = firstMessage;
    if (firstMessage.sentDuringStreaming !== true) {
      lastFreshPromptUserMessageId = firstMessage.id;
    }
  }
  ```
- Give each assistant group a `turnKey`, and add `turnKey?: string` to `MessageGroup`:
  ```ts
  const turnKey = isAssistantTurn
    ? (lastFreshPromptUserMessageId ?? actionMessage.id)
    : undefined;
  ```
  Add `previousGroup.turnKey === turnKey` to the cache-reuse equality check (next to the existing `precedingUserMessageId` comparison at ~166) so a cached group is not reused across a turn-boundary change.

### `isFinalChunkOfTurn` — computed at render (stable, cache-safe)

Do **not** store this on the cached group (appending A.2 must flip A.1 from final to non-final without A.1's `messages` changing, which would defeat the group cache). Compute it from the finished `messageGroups` list, where "final" = no later assistant group shares the same `turnKey`:

```ts
const lastGroupIndexByTurnKey = useMemo(() => {
  const map = new Map<string, number>();
  messageGroups.forEach((group, index) => {
    if (group.isAssistantTurn && group.turnKey) map.set(group.turnKey, index);
  });
  return map;
}, [messageGroups]);
```

Then inside the `messageGroups.map((messageGroup, index) => { … })` (add the `index` arg):

```ts
const isFinalChunkOfTurn =
  messageGroup.isAssistantTurn &&
  messageGroup.turnKey != null &&
  lastGroupIndexByTurnKey.get(messageGroup.turnKey) === index;
```

> **Reload note (intended):** `sentDuringStreaming` is client-only and absent on history loaded from the DB, so after a refresh every direct user message looks "fresh", each chunk gets its own singleton `turnKey`, and `isFinalChunkOfTurn` is true for each. That is acceptable — see *Known limitation*. Live behavior (the actual complaint) is fully correct.

---

## Phase 1 — Presentation (problems 1 & 2)

### 1a. `TurnSummaryBar` — replace the implicit "always" chrome with explicit props

**File:** `src/components/turn-summary-bar.tsx`

Drop the always-on duration and `<hr>`; gate them on two explicit, presentational props (the consumer owns the policy — see the backend-review rationale baked into the names):

```ts
interface TurnSummaryBarProps {
  durationMs: number;
  stepCount: number;
  children: ReactNode;
  defaultExpanded?: boolean;
  animateOnMount?: boolean;
  onAutoCollapseScheduled?: () => void;
  /** Show the "worked for <time> ·" prefix. */
  showDuration?: boolean;
  /** Render the trailing <hr> that separates the summary from a final answer. */
  showSeparator?: boolean;
}
```

Default both to `true` in the destructure (`showDuration = true, showSeparator = true,`).

**a11y label** — drop the time when it isn't shown:

```ts
const a11yLabel = showDuration
  ? `${isExpanded ? "Hide" : "Show"} work, ${stepLabel}, ${formatTurnDurationForScreenReader(durationMs)}`
  : `${isExpanded ? "Hide" : "Show"} work, ${stepLabel}`;
```

**Button contents** — wrap the `worked for` / time / first `·` in `showDuration`:

```tsx
<button … >
  {showDuration ? (
    <>
      <span>worked for</span>
      <span className="text-muted-foreground/80">{timeLabel}</span>
      <span className="text-muted-foreground/30">·</span>
    </>
  ) : null}
  <span className="text-muted-foreground/80">{stepLabel}</span>
  <span className="text-muted-foreground/30">·</span>
  <span>{toggleLabel}</span>
  <ChevronRight … />
</button>
```

**Hairline** — render only when `showSeparator`:

```tsx
      </CollapsibleContent>

      {showSeparator ? (
        <hr className="my-2 border-t border-border/40" />
      ) : null}
    </Collapsible>
```

Removing the `<hr>` (rather than hiding it) also removes its `my-2` spacing — the "extra padding" called out as clunky. Vertical separation below an intermediate chunk is still provided by the following user message's existing `mt-6` (an interrupted chunk is, by construction, always followed by a user message).

### 1b. `chat-messages-view.tsx` — drive the chrome from the classification

Compute the policy once per collapsed group and select the trace:

```ts
const finalOutputMessage = messageGroup.finalOutputMessage;

// Only the turn's concluding chunk may show a final answer, its separator, or a duration.
const renderFinalAnswer = isFinalChunkOfTurn && finalOutputMessage !== null;

const completed = completedTurns.get(messageGroup.actionMessageId);
const durationMs = completed?.durationMs ?? messageGroup.fallbackDurationMs;

// Never render a "0:00" — if we don't have a real duration, show none.
const showDuration = renderFinalAnswer && durationMs >= 1000;
const showSeparator = renderFinalAnswer;
```

Pass the props and select the *show work* content. The final chunk uses the existing merged trace message (which excludes the final answer, since that renders below the hairline); an intermediate chunk renders its **full** messages so nothing — including any trailing text — is lost:

```tsx
<TurnSummaryBar
  durationMs={durationMs}
  stepCount={messageGroup.stepCount}
  showDuration={showDuration}
  showSeparator={showSeparator}
  animateOnMount={ /* see Phase 2; pass false if Phase 2 is descoped */ }
  onAutoCollapseScheduled={onFreshlyCompletedTurnAnimationScheduled}
>
  {renderFinalAnswer
    ? (messageGroup.traceMessage
        ? renderMessage(messageGroup.traceMessage, {
            renderMode: "full",
            showActionRow: false,
            omitMessageAnchor: true,
          })
        : null)
    : messageGroup.messages.map((msg) =>
        renderMessage(msg, {
          renderMode: "full",
          showActionRow: false,
          omitMessageAnchor: true,
        }),
      )}
</TurnSummaryBar>

{renderFinalAnswer && finalOutputMessage ? (
  /* …existing final-text-only MessageBubble block, unchanged… */
) : null}
```

Notes for the implementer:

- The intermediate-chunk branch renders `messageGroup.messages` directly (stable refs from `visibleMessages`), so there is **no `turn-utils.ts` change** and no perf/stability regression. This is also exactly how the chunk renders while deferred in Phase 2, so the two states look identical.
- The `data-message-id` / `assistantMeasureRef` wiring on the summary wrapper and the final-output wrapper (lines ~340–404) stays as-is. For an intermediate chunk there is no final-output wrapper; keep the summary wrapper's `data-message-id={messageGroup.actionMessageId}` exactly as today.
- `formatTurnDuration(0)` is `"0:00"` and seconds floor at 1000 ms, so `durationMs >= 1000` is precisely "won't render 0:00." This also suppresses the stray `0:00` that a reloaded final-of-a-steered-turn chunk would otherwise show (its fallback is ~0); the final answer and hairline still render, just without a fake time.

**Phase 1 is independently shippable.** With `animateOnMount={false}` it removes the `0:00`, the dangling hairline, and any stray final-answer chrome on interrupted chunks — in both the live and reloaded views.

---

## Phase 2 — Defer collapse until the turn completes (problem 3)

Goal: while a turn is still running, its non-active chunks keep using the **full** render path instead of collapsing; when the turn completes they all switch to the summary path **and animate closed together**, reusing the mechanism the final chunk already uses.

### Step 1 — pass the live "turn is running" signal

Add a prop `isAssistantTurnActive: boolean` to `ChatMessagesViewProps` and pass `assistantTurnActive` (already computed at `Chat.tsx:980`) next to the existing `activeTurnActionMessageId` props (~4882). This is the gate for "a turn is currently in progress." No other `Chat.tsx` change — `freshlyCompletedTurnId`, `completedTurns`, and the `turn/completed` handler stay exactly as they are.

### Step 2 — resolve the active turn and the just-completed turn (at render)

```ts
const activeTurnKey =
  messageGroups.find(
    (g) => g.isAssistantTurn && g.actionMessageId === activeTurnActionMessageId,
  )?.turnKey ?? null;

const completedTurnKey =
  freshlyCompletedTurnId != null
    ? messageGroups.find(
        (g) => g.isAssistantTurn && g.actionMessageId === freshlyCompletedTurnId,
      )?.turnKey ?? null
    : null;
```

`completedTurnKey` is intentionally transient (it follows `freshlyCompletedTurnId`, which clears after the animation). It drives **only** the one-shot collapse animation. The chrome classification above (`isFinalChunkOfTurn`, `renderFinalAnswer`, `showDuration`) is structural and never reads it, so an interrupted chunk stays classified as intermediate after the animation is over.

### Step 3 — defer the collapse

Replace the `shouldShowSummary` computation:

```ts
const isActiveTurn =
  messageGroup.isAssistantTurn &&
  messageGroup.actionMessageId === activeTurnActionMessageId;

// A non-active chunk that belongs to the still-running turn stays expanded.
const isDeferredCurrentTurnChunk =
  isAssistantTurnActive &&
  activeTurnKey != null &&
  messageGroup.isAssistantTurn &&
  !isActiveTurn &&
  messageGroup.turnKey === activeTurnKey;

const shouldShowSummary =
  messageGroup.isAssistantTurn &&
  !isActiveTurn &&
  !isDeferredCurrentTurnChunk &&
  messageGroup.stepCount > 0;
```

When `isDeferredCurrentTurnChunk` is true the group falls through to the existing **full** render path (bottom `return`) — its finalized trace, exactly as it looked while active. When the turn ends, `isAssistantTurnActive` flips false, `isDeferredCurrentTurnChunk` becomes false, and the chunk collapses.

### Step 4 — collapse the whole turn together (animation)

Set the `animateOnMount` argument in the summary block from the turn key:

```tsx
animateOnMount={
  completedTurnKey != null && messageGroup.turnKey === completedTurnKey
}
```

For a normal (non-steered) turn this is unchanged: the turn has a singleton `turnKey`, `freshlyCompletedTurnId` is that one chunk, so only it animates. For a steered turn, A.1/A.2/A.3 share `completedTurnKey`, so all three mount expanded and animate closed on the same frame.

### Step 5 — make `TurnSummaryBar`'s auto-collapse race-proof

With multiple bars animating at once there is a race: the first bar's `onAutoCollapseScheduled` clears `freshlyCompletedTurnId` (`Chat.tsx:3506`), which flips the other bars' `animateOnMount` to false **before their RAF fires**; the current dependency-array effect would then cancel their pending collapse and leave them stuck open.

Fix it by **latching** `animateOnMount` at mount so a later prop change can't cancel an already-scheduled collapse.

**File:** `src/components/turn-summary-bar.tsx`

```tsx
const animateOnMountRef = useRef(animateOnMount);
const [isExpanded, setIsExpanded] = useState(defaultExpanded || animateOnMount);

useEffect(() => {
  if (!animateOnMountRef.current) return;
  const id = requestAnimationFrame(() => {
    setIsExpanded(false);
    onAutoCollapseScheduled?.();
  });
  return () => cancelAnimationFrame(id);
  // Latched at mount: a later animateOnMount=false must not cancel an
  // in-flight collapse. Intentionally run-once.
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);
```

(`onAutoCollapseScheduled` is a stable `useCallback` in `Chat.tsx`, so the empty dependency array is safe.) This keeps `Chat.tsx`'s single `freshlyCompletedTurnId` unchanged; `chat-messages-view.tsx` is the one place that fans it out to every chunk of the turn.

---

## File-by-file change list

| File | Phase | Change |
| --- | --- | --- |
| `src/components/turn-summary-bar.tsx` | 1 + 2 | Replace always-on `worked for` + `<hr>` with `showDuration?: boolean` / `showSeparator?: boolean` props (default `true`); trim the a11y label when `showDuration` is false. **(P2)** Latch `animateOnMount` at mount via a ref + run-once effect. |
| `src/components/chat-messages-view.tsx` | foundation + 1 + 2 | Track `lastFreshPromptUserMessageId`; add per-group `turnKey` (+ cache-equality check). Add `index` to the `messageGroups.map`; compute `lastGroupIndexByTurnKey` and `isFinalChunkOfTurn`. **(P1)** derive `renderFinalAnswer` / `showDuration` / `showSeparator`; render final chunk via `traceMessage` + final bubble, intermediate chunk via full `messages.map` and no bubble. **(P2)** add `isAssistantTurnActive` prop; compute `activeTurnKey` / `completedTurnKey`; add `isDeferredCurrentTurnChunk` to gate `shouldShowSummary`; set `animateOnMount` from `completedTurnKey`. |
| `src/components/Chat.tsx` | 2 | Pass `isAssistantTurnActive={assistantTurnActive}` to `<ChatMessagesView>` (~4882). Nothing else. |
| `src/types.ts` | — | No change. `Message.sentDuringStreaming` already exists (line 202). |
| `src/lib/turn-utils.ts` | — | **No change.** Intermediate chunks render their raw messages, so trailing text is preserved without a new trace variant. `buildTraceMessageView` / `buildFinalOutputMessageView` stay as-is. |

No CSS/keyframe changes (the `--animate-turn-trace-down/up` animations are reused). **No worker/backend change** — `turn/completed`, `turnDurationMs`, and step counting are untouched.

---

## Do NOT touch

- **The send-message spacer / scroll math** (`Chat.tsx` `shouldRenderSpacer` at ~3500, which keys off `lastUserMessage?.sentDuringStreaming`, and the spacer `useLayoutEffect`). The way the user message "sends very clearly" is desired and is independent of collapse timing.
- **`countTurnSteps`** and the rest of `src/lib/turn-utils.ts`. The step count is per-chunk and correct; "N steps" is not a bug.
- **The Radix `Collapsible`, the `collapsible-down/up` keyframes, and the `--animate-turn-trace-*` variables** in `globals.css`. Phase 2 reuses the existing completion-collapse animation; it does not add a new one.
- **The backend turn lifecycle** (`chat-thread-do.ts`). Do not add per-chunk timing or a second `turn/completed`; the final chunk already carries the real full-turn duration.
- **The Stop button path** (`stopGeneration` / `"Stopped by user"`). That is a different flow from steering and is out of scope.

---

## Edge cases

- **Interrupted chunk that ends with a stray sentence of text** (the case the structural classification exists for): `isFinalChunkOfTurn` is false (a later chunk shares its `turnKey`), so it renders as `N steps · show work` with no time, no `<hr>`, and no final-answer bubble; the stray text appears inside *show work* (its full messages are rendered). **Live: fully correct.**
- **Tool-only turn that completes with no reply** (not interrupted): `finalOutputMessage === null` → `renderFinalAnswer` false → `N steps · show work`, no time, no hr. Consistent — time belongs with a final answer, and there isn't one.
- **Single interrupt, then the agent answers**: A.1 stays expanded while A.2 streams; on completion A.1 collapses (no time/hr), A.2 collapses with the full-turn time + hr + reply.
- **New turn started below older interrupted chunks**: older chunks have a different `turnKey` than `activeTurnKey`, so they are not re-expanded when a new turn runs; their collapsed state is untouched.
- **Reload from history**: each chunk is its own singleton `turnKey`; deferral and the group animation are inert (`isAssistantTurnActive` false, `freshlyCompletedTurnId` null). Common interrupted chunks (no trailing text) still render correctly as work-only summaries via `finalOutputMessage === null`; the `durationMs >= 1000` guard suppresses any `0:00`. See *Known limitation* for the residual trailing-text-on-reload case.
- **Zero-step chunk**: `shouldShowSummary` stays false (existing `stepCount > 0` guard); renders as today.
- **`motion-reduce`**: unchanged — `TurnSummaryBar` keeps `motion-reduce:animate-none`; the latch only changes *when* the collapse is scheduled, not whether it animates.

---

## Known limitation (pre-existing) + optional refinement

On **reload**, turn boundaries cannot be reconstructed because `sentDuringStreaming` is client-only and not persisted. The visible consequences after a refresh of an interrupted turn:

- The common interrupted chunk (no trailing text) renders correctly (work-only summary, no time/hr).
- A *rare* interrupted chunk that ended with trailing text is indistinguishable from a tiny complete turn, so it shows an `<hr>` + that text as a pseudo-final-answer. The `durationMs >= 1000` guard still prevents a `0:00`, so the worst symptom (fake time) is gone, but the hairline/answer chrome is imperfect.

This already happens today and is **out of scope** here; the live experience (the actual complaint) is fully correct. The only complete fix is to **persist the turn boundary** (e.g. a steer/`sentDuringStreaming` marker or a `turn_duration_ms` column) on the backend so `turnKey` and `isFinalChunkOfTurn` are reconstructable after reload. Do not bundle that into this task.

---

## Tests

### `tests/turn-summary-bar.test.tsx` (new — direct component tests)

- **Default chrome:** renders `worked for <time>` and the `<hr>` when `showDuration`/`showSeparator` default to true.
- **Work-only chrome:** with `showDuration={false}` and `showSeparator={false}`, the bar renders `N steps · show work`, no `worked for` text, and no `<hr>` element.
- **Latched `animateOnMount`:** with `animateOnMount={true}`, the trace mounts expanded and collapses on the next animation frame; re-rendering with `animateOnMount={false}` **after** mount does not cancel the scheduled collapse (guards the multi-bar race). `onAutoCollapseScheduled` fires once.

### `tests/chat-messages-view-collapsed-turn.test.tsx` (extend — it already mocks `MessageBubble` + renders `ChatMessagesView`)

- **Intermediate chunk hides chrome (the key case):** messages `[user A, A.1(tool work + trailing "let me also…" text), user1(sentDuringStreaming:true), A.2(streaming)]`, `activeTurnActionMessageId = A.2`. Assert A.1 collapses with **no** `worked for`, **no** `<hr>`, and **no** `final-text-only` bubble, and that the trailing text is present in A.1's full/trace render (i.e. not dropped, not promoted to a final answer).
- **Final chunk keeps chrome (regression):** the existing "keeps final text visible" test still shows `worked for` + formatted time + the final reply.
- **`0:00` guard:** a final chunk whose only available duration is the ~0 fallback (no `completedTurns` entry) shows the final answer + `<hr>` but **no** `worked for`.
- **Deferral:** with `isAssistantTurnActive: true` and the steered-turn message set above, A.1 renders via the full path (no `show work` summary) — nothing from the current turn is collapsed.
- **Collapse on completion:** same messages, `isAssistantTurnActive: false`, A.3 finalized with a text reply, `freshlyCompletedTurnId = A.3`. Assert all three chunks render summaries, A.1/A.2 with `showDuration`/`showSeparator` false and A.3 with `worked for` + `<hr>` + final text, and that `animateOnMount` is passed to all three.
- **Separate turns aren't merged:** two genuinely separate turns (second prompt has `sentDuringStreaming` absent) get different `turnKey`s, so completing the second turn does not animate or alter the first.

`src/lib/turn-utils.ts` is unchanged, so its unit tests need no edits.

Run: `bun run typecheck` and `bun run test:run -- tests/chat-messages-view-collapsed-turn.test.tsx tests/turn-summary-bar.test.tsx`.

---

## Implementation order

1. **Shared foundation** in `chat-messages-view.tsx`: `lastFreshPromptUserMessageId` → `turnKey` → `lastGroupIndexByTurnKey` → `isFinalChunkOfTurn`.
2. **Phase 1**: `showDuration`/`showSeparator` on `TurnSummaryBar`; derive `renderFinalAnswer`/`showDuration`/`showSeparator` and the final-vs-intermediate trace selection in `chat-messages-view.tsx`. Ship/verify with `animateOnMount={false}` — this alone fixes problems 1 & 2.
3. **Phase 2 Step 5** (latch `animateOnMount`) — small, isolated prerequisite for safe multi-chunk animation.
4. **Phase 2 Steps 1–4** — `isAssistantTurnActive` prop, `activeTurnKey`/`completedTurnKey`, the deferral gate, and the `completedTurnKey`-driven `animateOnMount`.
5. Add/extend the tests above; `typecheck`.
