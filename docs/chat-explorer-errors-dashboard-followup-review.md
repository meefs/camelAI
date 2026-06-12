# Chat Explorer Errors Dashboard Follow-Up Review

Reviewed the implemented fixes for the combined handoff. The three requested bugs are addressed, and the focused test suite passes, but I found two follow-up issues that are worth fixing before PR.

## Findings

### Medium: Stale explicit `thread_upsert` payloads can still roll error/model metadata backward

References:

- `workers/main/src/app-index-db.ts:656`
- `workers/main/src/app-index-db.ts:702`
- `workers/main/src/app-index-db.ts:709`

The new preservation logic protects metadata when fields are omitted, but it still trusts explicit stale values. Current OrgDO thread payloads include `chat_error_count` and `model_history`, so an older async `thread_upsert` can arrive after `recordThreadError` and overwrite newer D1 state with `chat_error_count = 0`, null `last_chat_error_*`, or an older single-model history.

This can happen if a create/touch/update event that was built before an error or model switch lands after the newer event. The conflict update has no timestamp or monotonic guard for the new summary fields.

Recommendation:

- Treat `chat_error_count` as monotonic in the admin index: do not reduce an existing positive count from a later row.
- Only update `last_chat_error_*` when the incoming `last_chat_error_at` is present and newer than or equal to the existing value, or when the existing value is null.
- For `model_history`, merge existing and incoming histories instead of replacing, or only replace when `excluded.last_model_changed_at >= threads.last_model_changed_at`.
- Add a regression test where a thread gets an error/model switch, then an older explicit payload with `chat_error_count: 0` / single-model history arrives and does not erase the newer metadata.

### Low: Direct-send error sources can be relabeled as `pi_provider`

References:

- `workers/main/src/chat-thread-do.ts:7418`
- `workers/main/src/chat-thread-do.ts:7435`
- `workers/main/src/chat-thread-do.ts:12290`

`sendDirectChatError()` correctly passes explicit sources like `runner_enqueue` and `runner_send`, but `recordCurrentThreadError()` changes the source to `pi_provider` whenever `input.provider` is present. If `piCurrentUsageProvider` is set, a direct browser send failure can be recorded under `pi_provider` instead of the runner/send source.

That does not lose the event, but it makes the dashboard grouping and source badge less accurate for the exact failures this fix was meant to surface.

Recommendation:

- Keep an explicit source from callers. Only coerce to `pi_provider` when `input.source === "chat_thread_do_pi"` or when no source was provided and provider metadata is the only signal.
- Add a test where `sendDirectChatError()` runs with `piCurrentUsageProvider = "openai"` and still records `source: "runner_send"`.

## Verification

- `bun run test:workers -- workers/main/tests/admin-index-chat-explorer.test.ts workers/main/tests/chat-thread-codex-external-turn.test.ts`
- `bun run typecheck`
