# Chat transcript simplification

Status and roadmap for collapsing the chat transcript's synchronization
machinery. Phases A and B are implemented; this doc records the invariants they
introduced and the concrete path for the remaining work, so follow-ups delete
code instead of adding guards.

## Where duplication came from

The transcript used to exist in several places with no shared identity: pi_core
rows (authoritative), the ai-chat render table (mirrored under *deterministic*
backfill ids), the live stream (under a *random* turnId), the client's seeded
state, the snapshot cache, and the resume-replay buffer. Every pair needed a
synchronization heuristic (marker gates, content skip-sets, persist-ordering
gates, replay-artifact collapse), and each new race grew another one.

## Phase A (done): same content ⇒ same id

Every pi_core row now records the render-history message id it corresponds to,
in `uiMetadata.renderMessageId` (UI-only; `stripPiUiMetadata` keeps it out of
model-facing loads, and `piCoreMessageKey` ignores it):

- **Assistant rows**: stamped with the minted turnId at every commit path
  (turn_end, recovery owes-no-output commit, agent_end user-stop commit,
  transient-retry stop). The backfill folds consecutive rows sharing a stamp
  into ONE UIMessage under that id — exactly the message the live stream
  persists — so dedup is a plain id-existence check, and when neither writer
  has landed yet, whichever runs first, the other's upsert converges on one
  row. The old agent_end → `_reply`-persist race is structurally harmless.
- **User rows**: stamped with the id of the ui skeleton persisted for them
  (fresh sends, steering, channel history, the immediate new-thread persist).
  The backfill still *matches* user rows by `metadata.piCoreMessageKey` (exact,
  cheap); the stamp is the data foundation for derive-on-read below.

Deleted by A: the reply-persist gate (`pendingPiReplyPersist`,
`persistMessages` hook, settle-grace windows) and the assistant content
skip-sets for stamped rows. The fork-id/tool-call heuristics remain ONLY as a
legacy fallback for rows committed before stamping shipped (a turn straddling
the deploy); delete them once no pre-stamp in-flight turns can exist.

Stamp lifecycle across pi_core REWRITES (`replacePiCoreMessages`), audited:

- **Compaction** (`uiRender: "preserve"`) re-serializes rows from the live
  session array, which does not carry the stamps (they are added to persist
  copies) — rewritten rows come out unstamped. Harmless for the mirror: the
  high-water mark is re-pinned past them so they are never re-converted. A
  future derive-on-read must either re-stamp at compaction or treat
  post-compaction rows as legacy.
- **Fork seeding** rewrites rows copied from the SOURCE thread, stamps
  included; the follow-up rebuild derives the new thread's render history from
  them, so a whole source turn still folds into one message under the
  inherited id (unique per thread; no collision). Strip inherited stamps here
  if per-thread id namespacing ever matters.
- The append dedup key (`piCoreMessageKey`) strips `uiMetadata`, so
  re-appending the same row is deduped regardless of stamps and the
  first-written stamp wins.

## Phase B (done): seed and stream own disjoint content

On a tab switch, the remounted Chat seeds `useAgentChat` from the snapshot
cache and `resume: true` replays the buffered turn. The seed now EXCLUDES the
message that was mid-stream at capture (`ChatThreadSnapshot.streamingMessageId`
→ `resolveDisplayChatData`): history comes from the seed, the in-flight turn
comes from the stream, exclusively. A replay therefore always rebuilds the
live message from scratch — the "replay onto a hydrated copy" part-duplication
class can't occur. Chat paints the excluded message from the legacy snapshot
view (`bridgedStreamingMessageId`, bounded) until the stream re-delivers it.

Deleted by B: the replay-artifact normalization layer from the first fix
(socket frame sniffing, replay-touched id tracking, prefix-collapse of
duplicated parts). What remains is `dedupeUiMessagesById` — an exact,
id-identity safety net for the one residual upstream defect (below).

## Upstream defects (agents / ai packages)

The residual client complexity exists because of upstream behavior; filing/
fixing these deletes the rest:

1. `ai` `Chat.makeRequest`'s `write()` is replace-last-or-push. A streamed
   `start` whose messageId exists in state but is not the LAST message pushes
   a duplicate. It should upsert by id. (This is what `dedupeUiMessagesById`
   nets out.)
2. `createStreamingUIMessageState` clones `lastMessage` whenever it is an
   assistant — even when its id does not match the incoming `start` — so a
   resume whose seed tail is an *unrelated* assistant can fold that content
   into the new message. It should only continue a matching id.
3. `agents` `resetMatchingHydratedAssistantForReplay` only matches the tail
   message, and its replay-artifact collapse handles text parts only.

## Phase C roadmap: derive render history on read

pi_core + the stamps now determine the settled render history completely; the
ai-chat table is a materialized cache of `messageToUiMessage` over it. The
remaining differences, audited:

- **Derivable today**: text/thinking/tool blocks, tool results (+ code-mode
  artifacts via `uiMetadata.codeModeArtifacts`), inline errors (from assistant
  `errorMessage` fields), user-stop markers, todos (turnPlan tool_use).
- **Render-only, needs a stamp before derive-on-read**: user skeleton
  `messageSource` / `channelHistory` flags (the skeleton id itself is now
  stamped); the encoder's `turnDurationMs` / `completedAtMs` message metadata
  (derivable approximately from row timestamps, or stamp at agent_end).
- **Never derivable**: the in-flight turn's live row (owned by the stream) and
  ai-chat's recovery bookkeeping.

Steps, each deletion-shaped:

1. Extend user-row handling in the backfill to use the stamp as the converted
   id (skip-by-id like assistants); then delete the `piCoreMessageKey`
   skip-set. Requires `messageToUiMessage` to prefer the stamp over
   `forkEntryId` — audit fork-target resolution first (it matches on
   `forkEntryId` metadata, which the fold already preserves).
2. Stamp `turnDurationMs`/`completedAtMs` into the turn's last assistant row's
   `uiMetadata` at agent_end, so a derived view renders turn badges without
   the ai-chat row.
3. Make `getUiMessages` derive settled history from pi_core on read (the
   `rebuildUiMessagesFromPiCore` transform, without persisting), overlaying
   only rows the derivation can't produce (live turn row). At that point the
   high-water mark, `UI_MESSAGES_PI_CORE_LAST_CREATED_AT_KEY` ordering
   machinery, and the admin resync RPCs collapse into "the read IS the
   resync". Gated on: every render row class having a pi_core source (audit
   above), and on ai-chat tolerating an externally-derived message list for
   its recovery paths — the framework loads `this.messages` from its own
   table on wake, so this needs either an `@cloudflare/ai-chat` hook for a
   custom message source or acceptance that the table remains as a cache the
   derive refreshes.

## Also worth retiring (independent)

- **Legacy `Message` shape**: the renderer consumes pi-era `Message`, so every
  UIMessage round-trips `ui-message-adapter` (plus caches). Rendering
  UIMessages directly deletes the adapter, `parseMessageContent`, and the
  legacy halves of the snapshot. Large UI refactor; no server coupling.
- **Snapshot cache** (`use-chat-thread-snapshots`): exists for instant paint on
  tab switch. With loader latency now dominated by `getUiMessages` (fast) and
  the B seam making seeds trivial, measure whether the cache still earns its
  code; if not, `?chatCache=1` and `resolveDisplayChatData` shrink to nothing.
