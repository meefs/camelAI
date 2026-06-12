# Chat Explorer Errors Dashboard Implementation Feedback

Reviewed the current workspace diff for the Chat Explorer metadata and Errors dashboard implementation against `docs/chat-explorer-metadata-improvements-plan.md`.

## Findings

### High: Direct send errors still bypass error persistence

References:

- `workers/main/src/chat-thread-do.ts:12352`
- `workers/main/src/chat-thread-do.ts:7461`
- `workers/main/src/chat-thread-do.ts:7478`

The new error capture hook only runs inside `pushChatEvent` when `payload.type === "error"`. `handleRunnerClientUserMessage` still sends browser-visible errors with `sendDirect(ws, this.chatSendErrorPayload(...))` when `enqueueRunnerUserMessage` throws or returns a non-accepted result.

Those paths cover important employee-facing failures such as billing/credit errors, busy/send failures, and sandbox message enqueue failures. Because they do not go through `pushChatEvent`, they do not call `recordCurrentThreadError`, increment `chat_error_count`, insert `chat_error_events`, appear in `/qaml-backdoor/errors`, or show up in the Errors-only Chat Explorer filter.

Recommendation: centralize direct chat error sending behind a helper that both records and sends, or have the two `handleRunnerClientUserMessage` failure branches call `recordCurrentThreadError` with the same payload metadata before `sendDirect`. Add a focused test that simulates a rejected/failed runner message and asserts `OrgDO.recordThreadError` or the resulting `thread_error_recorded` event fires.

### Medium: Partial `thread_upsert` events can erase existing error and model metadata

References:

- `workers/main/src/app-index-db.ts:652`
- `workers/main/src/app-index-db.ts:693`
- `workers/main/src/app-index-db.ts:700`

`thread_upsert` normalizes an omitted `chat_error_count` to `0` and an omitted `model_history` to a fallback based on `model`, then writes those values unconditionally in the conflict update. Any stale or partial `thread_upsert` that arrives after `recordThreadError` can clear the D1 error summary and remove a thread from `errors_only`. The same pattern can collapse a true multi-model history back to a single current model.

Recommendation: preserve existing D1 values when the incoming payload does not explicitly include the new metadata. For example, distinguish omitted fields from explicit zero/null before binding, and use conditional update expressions or `COALESCE` where appropriate. Add a regression test that records an error, then applies an older-style `thread_upsert` without error fields, and verifies the error summary and model history remain intact.

### Medium: Model-history repair is masked before OrgDO hydration can run

References:

- `src/lib/auth-do.server.ts:534`
- `src/lib/auth-do.server.ts:624`
- `src/lib/auth-do.server.ts:629`

`hydrateMissingChatExplorerThreadMetadata` fills every row missing `model_history` with `[row.model]` before calling `shouldRepairChatExplorerRow`. That means a D1 row with missing/stale model history will no longer qualify for OrgDO repair, even if OrgDO has the real multi-model history.

Recommendation: decide repair eligibility from the raw D1 row before applying display fallbacks, or add a separate flag for "model history was absent in D1". The fallback `[model]` is fine for rendering, but it should not prevent repair from the authoritative OrgDO thread row.

### Medium: Historical fallback error detection can disagree with the Errors dashboard

References:

- `workers/main/src/chat-thread-do.ts:4404`
- `src/lib/auth-do.server.ts:680`
- `src/lib/auth-do.server.ts:696`
- `workers/main/src/app-index-db.ts:1196`

`getAdminExplorerSummary` can discover persisted assistant errors and the loader can copy `summary.errorCount` / `summary.lastErrorMessage` into the thread summary. That can make Chat Explorer show an Error badge, but the Errors dashboard reads only `chat_error_events`; no `thread_error_recorded` event is inserted for these fallback-discovered errors.

This creates a confusing state where a thread can look errored in Chat Explorer but not contribute to the top-errors dashboard. If the dashboard is intentionally forward-looking only, document that limitation in the plan/UI. Otherwise, emit bounded `thread_error_recorded` events for fallback-discovered persisted assistant errors when a timestamp and normalized message are available.

## Test Coverage Gaps

The added `admin-index-chat-explorer` tests cover D1 grouping/filtering well, and typecheck passes. The highest-risk live paths still need coverage:

- direct `sendDirect` chat error capture;
- `OrgDO.recordThreadError` incrementing summary fields and dispatching both admin events;
- model-history create/update/dedupe behavior in OrgDO;
- `/qaml-backdoor/errors` range parsing, superuser access, empty state, and selected-fingerprint loader behavior.

## Verification Run

- `bun run typecheck`
- `bun run test:workers -- workers/main/tests/admin-index-chat-explorer.test.ts`
