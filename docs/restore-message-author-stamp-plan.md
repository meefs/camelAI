# Restore the message author stamp

## Goal

Restore the sender identity in the existing message action row so a user message displays a compact stamp such as:

```text
Illiana Reed Jul 12, 8:34 PM
```

The stamp should work for newly sent, streamed, reloaded, backfilled, and already-affected messages in shared team threads. It must not expose the model-only attribution prefix in the visible message body.

## User-facing contract

- Put the stamp in the existing hover/focus action row beside the copy control. Do not add a second tooltip or a new always-visible label.
- Join the resolved sender label and the existing formatted timestamp with one space. Do not use connector text such as `Sent by` or `at`.
- Preserve the current time-zone and date rules in `formatMessageTime`:
  - A message from today renders `Illiana Reed 8:34 PM`.
  - An older message renders `Illiana Reed Jul 12, 8:34 PM`.
  - If only the sender is available, render only the sender.
  - If only the timestamp is available, render only the timestamp.
  - If neither is available, omit the stamp entirely.
- Never fabricate an author as `Unknown`, `web`, `email`, or another source name. The source controls the channel branding; it is not a person.
- Keep assistant messages timestamp-only. Keep slash-command, interrupt, compact-summary, and other special-message branches unchanged.
- Preserve the existing coarse-pointer/focus behavior and the fixed channel-logo placement, so the fix does not introduce a layout shift on channel messages.

## Root cause

Author attribution still exists in the canonical Pi/model transcript. `workers/main/src/chat-author-attribution.ts` prepends user prompts with a source and authenticated sender, and `enqueueRunnerUserMessage` in `workers/main/src/chat-thread-do.ts` builds that attributed prompt from `ChatContextState`.

The regression is in the separate ai-chat render mirror introduced for resumable UI messages:

```text
authenticated ChatContextState
        |
        +--> attributed Pi content --> pi_core (author remains available)
        |
        +--> raw user content --------> UIMessage skeleton --> adapter --> MessageBubble
                                            metadata has source, but no author
```

`ChatThreadUiMirror.buildUserUiSkeleton` intentionally persists `rawContent`, not the attributed model prompt. `uiMessageToMessage` then converts that raw UI message to the renderer's legacy `Message` shape. `MessageBubble` can currently find an author only by parsing the old prefix from visible message content, so it receives `null` for live and reloaded raw UI-message rows. The adapter also does not carry the existing `metadata.source` into `Message`, which can lose channel branding.

Keeping the raw render body is correct. The attributed Pi content can contain mention, file-safety, upload, or other model-facing augmentation and must not become the visible user message. The fix is to add structured render metadata and retain prefix parsing only as a compatibility path.

## Architecture decisions

1. **The Durable Object is authoritative for persisted authorship.** Derive the durable display label from the authenticated `ChatContextState` captured for the turn. Do not add an author field to the public `sendMessage` RPC and do not trust a client-supplied name in a team thread.
2. **Store a send-time display snapshot in UI metadata.** Add a flat `authorDisplayName` metadata field alongside the existing flat `source` field. This preserves the identity shown when the message was sent even if a user later changes their profile.
3. **Keep model and render content separate.** Do not change the author-prefix format in Pi, do not render `attributedContent`, and do not redesign `PiUiMetadata` for this fix.
4. **Use metadata first and legacy parsing second.** New messages use structured metadata. Old Pi-derived/backfilled messages can still be rendered by parsing their existing prefix.
5. **Repair affected history lazily and idempotently.** Already-persisted raw UI rows have a `piCoreMessageKey` that links them to the canonical prefixed Pi row. Enrich those UI rows in place with metadata while preserving their ids, raw parts, timestamps, and other metadata.
6. **Keep author and source independent.** A prefix may identify a source without identifying a person. Parsing and rendering must preserve that distinction.
7. **Reuse the current shadcn action controls.** The existing `Button` and `Tooltip` composition already supplies accessible copy actions and hover/focus behavior; no component installation is needed.

## Implementation plan

### 1. Extract a pure author-attribution parser

Create `src/lib/message-author.ts` and move the React-free prefix parsing currently embedded in `src/components/message-bubble.tsx` into it.

The module should expose small, separately testable operations:

- `resolveMessageAuthorDisplayName(name, email): string | null`
  - Trim both inputs.
  - Prefer a non-empty name.
  - Fall back to a non-empty email.
  - Return `null` rather than `Unknown` when neither exists.
- A legacy-prefix parser that returns the cleaned content plus independent `author` and `source` results. Its conceptual result is:

  ```ts
  {
    content: string | ContentBlock[];
    author: {
      name: string | null;
      email: string | null;
      displayName: string;
    } | null;
    source: string | null;
  }
  ```

Preserve all prefix forms supported by the current `parseMessageAuthor` implementation, including system-tag stripping and both string and `ContentBlock[]` input. A source-only prefix must still be stripped and return its source, but it must return `author: null`.

Update `stripAuthorFromBlocks` behavior so content cleanup is not conditional on finding a person. This avoids visibly leaking `[email message]:` while also avoiding a fake author called `email`.

Have `message-bubble.tsx` import the shared parser. Move the existing parser tests to import the shared module directly, or leave a temporary re-export from the component only if another current caller requires it. Do not broaden this change into unrelated transcript-preview parsing.

### 2. Add structured attribution to the render boundary

Update the render-only `Message` interface in `src/types.ts` with optional fields:

```ts
authorDisplayName?: string;
messageSource?: string;
```

Document that these are presentation snapshots from UI-message metadata, not model prompt content and not an authorization source.

Update both directions in `src/lib/ui-message-adapter.ts`:

- `uiMessageToMessage` reads a non-empty string from `metadata.authorDisplayName` into `Message.authorDisplayName` and the existing `metadata.source` into `Message.messageSource`.
- `messageToUiMessage` writes those fields back to the same flat metadata keys when present. This keeps backfill, resync, and round trips deterministic.
- Ignore malformed/non-string/blank metadata values rather than stringifying them.
- Add normalized `authorDisplayName` and `source` values to `uiMessageContentSignature`. A metadata-only history repair must make `uiMessagesEquivalent` return `false`; otherwise loader reconciliation can retain stale authorless messages with identical ids and parts.

Do not add email or user id to the render contract solely for this label. The already-attributed Pi row remains the canonical audit/model-side representation; the UI needs only the resolved display label and independent source.

### 3. Stamp server-authenticated metadata on every new user skeleton

Extend `ChatThreadUiMirror.buildUserUiSkeleton` in `workers/main/src/chat-thread/ui-mirror.ts`, and its thin delegate in `workers/main/src/chat-thread-do.ts`, to accept an optional `authorDisplayName`. Normalize it and write it to `UIMessage.metadata.authorDisplayName`, alongside `source`, `channelHistory`, `piCoreMessageKey`, and `sentDuringStreaming`.

In `enqueueRunnerUserMessage` / `sendRunnerCommand`:

- Resolve the display label from the same captured `ChatContextState.userName` and `userEmail` used to build `attributedContent`.
- Pass that label and `messageSource` through to both the initial user skeleton and the steering skeleton.
- Capture and pass these values before asynchronous work can allow another connection to update the DO's mutable chat context. Do not re-read `this.chatContext` later in the send path. This keeps the structured label consistent with the Pi prefix in a multi-user thread.
- Keep raw user text in `parts`; only metadata changes.

This path should cover web, Slack, email, and Telegram turns that establish their source/context before enqueueing. Keep the author argument optional for synthetic or outbound channel-history rows; do not label those as the currently connected browser user unless their own authenticated/source context proves that identity.

### 4. Add the metadata to transient client-created messages

Server metadata is authoritative after persistence, but the first paint should not temporarily lose the stamp.

- In `src/components/Chat.tsx`, use the current authenticated user from `useAuthData()` to set `authorDisplayName` and `messageSource: 'web'` on the optimistic legacy `Message` created from `finalContent`. Use the same shared name-then-email resolver.
- In `src/routes/_app.chat.$id.tsx`, extend the `pendingFirstUserMessage` fast path to receive the already-loaded authenticated user and put the same fields on its synthesized `Message`. Preserve the route's current cold-Durable-Object/no-extra-read behavior.
- Treat these values as transient presentation data only. The matching server message id and server-authenticated metadata replace/reconcile them; neither client location may send an asserted author to the Durable Object.

### 5. Render one compact stamp in `MessageBubble`

In `src/components/message-bubble.tsx`:

- Always run the legacy parser so old prefixed content is still cleaned.
- Resolve the sender label metadata-first:

  ```ts
  const displayName = message.authorDisplayName ?? parsed.author?.displayName ?? null;
  const source = message.messageSource ?? parsed.source ?? null;
  ```

  Treat blank strings as absent. Structured server metadata wins if it disagrees with a legacy prefix.
- Keep `formatMessageTime` and `messageTimeZone` as the single timestamp formatter.
- Construct the stamp without conditional prose:

  ```ts
  const authorStamp = [displayName, messageTime].filter(Boolean).join(' ');
  ```

- Render `authorStamp` in the existing faded action subgroup used for user-message hover/focus controls. Use the same value in the channel and non-channel branches instead of maintaining two different sentence templates.
- Derive `channelBrand` from the independent `source`, not from `author?.source`.
- Leave the channel logo fixed at the right edge and keep the separator, stamp, and copy button in the existing hover/focus subgroup. Do not wrap the stamp in another tooltip.
- Omit the stamp span when the computed string is empty so there is no blank separator or dangling whitespace.

### 6. Lazily repair already-affected persisted history

Add a one-shot, versioned repair to `ChatThreadUiMirror`, modeled after `healLegacyUiMessageTimes`, with a distinct KV marker such as `uiMessagesAuthorAttributionHealV1`.

The repair should:

1. Return immediately if its marker is set.
2. Return without setting the marker if `readPiActiveTurn()` or `activePiStreamTurnId()` indicates an in-flight turn. This avoids racing a live render row and allows a later quiet read to retry.
3. Select user UI messages that lack a valid `metadata.authorDisplayName` and have a string `metadata.piCoreMessageKey`.
4. Load canonical parsed Pi messages once with `getPiCoreParsedMessages(threadId)`. Index user rows by `String(row.created_at)`, the same Pi timestamp representation stored in the skeleton's `piCoreMessageKey`; do not use content equality as the join.
5. Parse the matched canonical Pi user's prefixed content with the shared pure helper. Merge a resolved display label and, when missing, its source into the existing UI message metadata.
6. Preserve the UI message id, role, raw `parts`, `pi` timestamps, `piCoreMessageKey`, `channelHistory`, `sentDuringStreaming`, and any unknown metadata. Never replace the raw visible body with canonical attributed content.
7. Persist/broadcast the full healed render list only if at least one row changed. Then set the one-shot marker even if some rows had no matching/parseable author, so unrepairable legacy rows do not rescan forever.
8. Emit only a low-cardinality count/status observability event such as `pi_ui_message_authors_healed`. Do not log names, emails, prefixes, or message text.

Invoke this repair from both history entry points:

- `getUiMessages()`, after top-up and before returning adapted history.
- `onConnect()`, after the orphaned-turn sweep and before sending `CHAT_MESSAGES` to the socket.

The `onConnect` call matters because an existing client cache/snapshot can avoid the route-loader path. After persistence, use the mirror's refreshed render list for the connection payload.

Rows without a `piCoreMessageKey`, without a matching Pi row, or without a parseable person remain valid and render timestamp-only. Do not invent a label. A later full resync from Pi will still use the legacy parser fallback.

### 7. Keep the change scoped

Do not change:

- The model-facing prefix generated by `chat-author-attribution.ts`.
- The same-content/same-id invariant or raw user skeleton parts.
- The public send-message RPC payload to accept identity.
- Assistant action-row copy, special message branches, or timestamp date/time-zone rules.
- Thread-preview prefix stripping unless a test proves this change directly regresses it.
- The shadcn registry or installed UI primitives.

## File-level change map

| File | Planned change |
| --- | --- |
| `src/lib/message-author.ts` | New pure display-name resolver and legacy prefix parser/stripper. |
| `src/types.ts` | Add optional render-only `authorDisplayName` and `messageSource` fields. |
| `src/lib/ui-message-adapter.ts` | Map attribution/source both ways and include them in content signatures. |
| `src/components/message-bubble.tsx` | Use metadata-first attribution, independent source, and compact stamp copy. |
| `src/components/Chat.tsx` | Stamp optimistic web messages from the current authenticated user. |
| `src/routes/_app.chat.$id.tsx` | Stamp the pending-first-message fast path without adding a DO read. |
| `workers/main/src/chat-thread/ui-mirror.ts` | Persist author metadata and implement the lazy historical repair. |
| `workers/main/src/chat-thread-do.ts` | Pass captured authenticated attribution to skeletons and invoke repair before socket history delivery. |
| `tests/message-bubble-parsers.test.ts` | Move/extend parser compatibility and no-fabricated-author cases. |
| `tests/ui-message-adapter.test.ts` | Cover metadata mapping, validation, round trip, and signature reconciliation. |
| `tests/message-bubble-author-stamp.test.tsx` | Cover exact stamp copy and hover/channel fallbacks. |
| `tests/chat-admin-readonly-loader.test.ts` | Cover pending first-message attribution while preserving the loader fast path. |
| `workers/main/tests/chat-thread-ui-mirror.test.ts` | Cover skeleton metadata and idempotent historical healing. |
| `workers/main/tests/chat-thread-pi-turn.test.ts` | Cover initial/steered server attribution from captured chat context. |

If an existing focused test file already owns one of these seams, extend it instead of creating a duplicate suite. Keep the UI-mirror repair tests in a focused file rather than expanding the already-large Pi-turn suite with mirror internals.

## Automated test plan

### Shared parser

- Parse current web/source prefixes containing both name and email.
- Parse legacy supported prefix variants for string and block content.
- Prefer name and fall back to email.
- Strip a source-only prefix while returning `author: null` and the correct source.
- Return no author for empty/malformed identity; never return `Unknown` or a source token as a name.
- Preserve non-prefix content exactly.

### UI-message adapter and reconciliation

- Convert valid `metadata.authorDisplayName` / `metadata.source` into the two `Message` fields.
- Round-trip those fields back into flat UI metadata.
- Ignore blank and non-string values.
- Prove that two otherwise identical UI messages are not equivalent when author or source metadata differs. This is the regression guard for metadata-only repair delivery.

### Message bubble

Use a fixed clock and `America/Los_Angeles` to make the expected copy deterministic.

- A raw message with structured author metadata and a July 12 timestamp renders exactly `Illiana Reed Jul 12, 8:34 PM` in the action row.
- A same-day message renders `Illiana Reed 8:34 PM`.
- A legacy prefixed message produces the same stamp while hiding the prefix from the body.
- Structured metadata wins over a conflicting legacy prefix.
- A missing author renders timestamp-only; an invalid/missing timestamp renders author-only; neither renders no stamp.
- No case renders `Sent by`, dangling `at`, `Unknown`, or `web` as the person.
- A structured channel source still selects the correct channel logo, and the stamp remains in the faded subgroup rather than moving the logo.
- Assistant and special-message action rows remain unchanged.

### Durable Object and history repair

- A newly built user skeleton keeps `parts[0].text` equal to raw user input and stores author/source/key in metadata.
- Both initial and steered messages use the identity and source captured for that enqueue, including an external-source context.
- A repair joins by `piCoreMessageKey`, adds only author/source metadata, preserves ids and parts byte-for-byte, and persists once.
- A source-only or unmatched canonical row does not fabricate an author.
- An active turn skips repair without setting the marker; a later idle call retries.
- A completed pass sets the marker; subsequent entry points do no Pi scan or persistence.
- `getUiMessages` and `onConnect` expose the healed list rather than the stale pre-repair list.
- The observability event contains counts/status only.

### Optimistic and loader paths

- A newly submitted web message has the signed-in user's name-or-email stamp before the server echo and keeps it after reconciliation.
- The pending-first-message route result has the current user's display label and `web` source without triggering the Durable Object history read that the fast path intentionally skips.

## Verification commands

Run the focused suites first, adjusting filenames only if the implementation extends an existing owner suite:

```bash
bun run test:run -- tests/message-bubble-parsers.test.ts tests/message-bubble-author-stamp.test.tsx tests/ui-message-adapter.test.ts tests/chat-admin-readonly-loader.test.ts
bun run test:workers -- workers/main/tests/chat-thread-ui-mirror.test.ts
bun run test:workers -- workers/main/tests/chat-thread-pi-turn.test.ts
bun run typecheck
```

Then manually verify against the running app:

1. Send a web message and confirm the same compact stamp before server echo, after completion, and after a full reload.
2. Open the same team thread as a different teammate and confirm the original sender remains on the message; the viewer must not replace it.
3. Check one Slack/email/Telegram-originated message: its person/email stamp and channel logo should both be present, with no hover layout shift.
4. Open a thread containing a raw authorless UI row created during the regression window and confirm a reload/connect repairs it from Pi history.
5. Check a same-day and older message in the configured message time zone.
6. Check keyboard focus and a coarse-pointer viewport to confirm the existing action controls remain reachable.

## Risks and safeguards

- **Identity spoofing:** only the server-captured context becomes durable; client fields are optimistic presentation state.
- **Cross-user context drift:** pass the identity captured at enqueue time through the same call chain as the attributed Pi prompt rather than reading mutable context after awaits.
- **Leaking model-only content:** historical repair merges metadata only and never copies canonical Pi content into UI parts.
- **Stale loader/cache reconciliation:** include attribution/source in `uiMessageContentSignature` so metadata-only changes are applied.
- **Repair racing a stream:** skip without marking while any active turn/stream exists.
- **Unrepairable history:** degrade to timestamp-only and finish the versioned scan; never invent an author.
- **PII in telemetry:** report only aggregate repair counts and statuses.
- **Channel regression:** source and person are independent, so source-only messages retain their logo without acquiring a fake author.

## Definition of done

- New browser and external-source user messages persist a server-authenticated author display snapshot and source in UI-message metadata.
- Optimistic and pending-first-message UI paths show the same stamp without a visible authorless flicker.
- Existing affected rows are repaired lazily from linked Pi rows without changing visible message content or ids.
- Legacy prefixed/backfilled messages continue to render and strip correctly.
- The action row uses the exact compact `name timestamp` form with graceful one-field/zero-field fallbacks and no conditional connector prose.
- Team-thread authorship remains the original sender after reload and when viewed by another member.
- Focused UI, adapter, DO, repair, and route tests pass, followed by `bun run typecheck`.
