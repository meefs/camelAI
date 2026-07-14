# Restore Message Author Stamp — Implementation Feedback

## Review outcome

The primary UI flow is implemented coherently: new user rows receive server-derived attribution metadata, optimistic and pending-first rows avoid an authorless first paint, the renderer prefers structured metadata while retaining legacy-prefix compatibility, and the existing shadcn `Button`/`Tooltip` action controls remain intact.

One correctness issue should be fixed before merging. A second parser issue is lower severity but worth addressing while this surface is already under test.

## Findings

1. **P2 — The one-shot history repair can permanently assign the wrong author when Pi timestamps collide.**

   `workers/main/src/chat-thread/ui-mirror.ts:231-245` builds `piUsersByKey` as a single-value map keyed only by `String(message.created_at)`. User messages use millisecond timestamps, so two accepted messages can legitimately share the same value. The later canonical row overwrites the earlier row in the map; every UI candidate with that `piCoreMessageKey` is then repaired from the same canonical author. `uiMessagesAuthorAttributionHealV1` is set at `workers/main/src/chat-thread/ui-mirror.ts:284`, making the incorrect attribution durable.

   Resolve canonical rows in this order:

   - First match a UI candidate's `message.id` to the canonical user row's `renderMessageId`. This is the exact same-content/same-id link and should be authoritative whenever present.
   - Build timestamp buckets rather than a last-write-wins timestamp map.
   - Use `piCoreMessageKey` only when its timestamp bucket contains exactly one canonical user row.
   - Leave ambiguous fallback rows unstamped. Timestamp-only UI is safer than showing another teammate as the sender.

   The core lookup can have this shape:

   ```ts
   const exact = piUsersByRenderMessageId.get(message.id);
   const timestampMatches = piUsersByTimestamp.get(piCoreMessageKey) ?? [];
   const canonical = exact ??
     (timestampMatches.length === 1 ? timestampMatches[0] : undefined);
   ```

   Do not consume an arbitrary member of an ambiguous bucket. It is fine for the versioned repair marker to complete after safely skipping rows that cannot be identified.

   Add regression coverage in `workers/main/tests/chat-thread-ui-mirror.test.ts` for both cases:

   - Two canonical user rows have the same `created_at` but distinct `renderMessageId` values and authors; their matching UI ids must receive the correct distinct authors.
   - Two canonical user rows have the same `created_at` and no usable render ids; timestamp fallback must leave the affected UI row(s) without `authorDisplayName`.

2. **P3 — Parsing an unattributed `ContentBlock[]` now trims visible text even when there is nothing to strip.**

   `src/lib/message-author.ts:34-35` applies `.trim()` unconditionally. The block overload then replaces the first text block at `src/lib/message-author.ts:124-130` whenever that trimming changes its text, even if the input contained no author prefix or system tag. For example, a block containing `"    indented code"` is returned as `"indented code"`. Before this extraction, `stripAuthorFromBlocks` returned the original block array when no author prefix matched.

   This contradicts the intended “preserve non-prefix content exactly” behavior and can change Markdown semantics for leading indentation. Keep the original string/block and array identity when neither a system tag nor an attribution prefix was removed. Prefix/system-tag cleanup can continue returning normalized text.

   Extend `tests/message-bubble-parsers.test.ts` with an unattributed block containing leading spaces and a trailing newline, and assert that both its text and the original array reference are preserved.

## What looks good

- `enqueueRunnerUserMessage` resolves the durable label from the same captured authenticated context used for the Pi prefix, before an awaited operation can replace the DO's current connection context.
- UI-message metadata remains presentation-only; no client-provided author was added to the public durable RPC contract.
- `uiMessageContentSignature` includes author and source metadata, so metadata-only repair payloads are not discarded as equivalent.
- `MessageBubble` cleanly separates channel source from person identity and produces the requested `name timestamp` copy without dangling connector prose.
- Existing channel-logo placement and action-row accessibility primitives were reused rather than replaced with custom controls.

## Verification performed

- `bun run typecheck` passed.
- `bun run lint` passed.
- `bun run test:run -- tests/message-bubble-parsers.test.ts tests/message-bubble-author-stamp.test.tsx tests/ui-message-adapter.test.ts tests/chat-admin-readonly-loader.test.ts` passed: 57 tests.
- The focused worker run passed 319 of 322 tests. `chat-thread-ui-mirror.test.ts` and `chat-thread-pi-stream-bridge.test.ts` passed. The three failures are unchanged deploy-action tests in `chat-thread-pi-turn.test.ts`, all failing in `usage-guard-config.ts` with `Cloudflare script details returned no version id`; none exercise the author-stamp diff.

## Merge recommendation

Request changes for finding 1. Finding 2 is non-blocking for the manually tested common flow, but fixing it now will keep the shared parser's behavior honest and avoid a subtle content-rendering regression.
