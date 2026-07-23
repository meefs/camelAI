# Chat History Search — Review Feedback

Review of the `docs/chat-history-search-plan.md` implementation. Verified: OrgDO SQL clause (escaping, AND-of-ORs, COUNT reuse, RPC arg order), V45 migration + defensive column ensure, ask-log append/cap/dedupe, client staleness guards (queryKey + echoed `q`, replace-on-offset-0, `searchPending` gating), snippet index math, and serialization containment through `toThread`/`toThreadListPreview`. Typecheck, `tests/thread-search.test.ts` (12), and `workers/main/tests/thread-pagination-filter.test.ts` (7) all pass. One item to fix:

## 1. Admin-index bootstrap bypasses the `user_ask_log` strip

`workers/main/src/admin-index-bootstrap.ts:218-223` spreads raw `orgStub.getThreads()` rows into `thread_upsert` events:

```ts
for (const thread of threads) {
  await appIndex.applyAdminEvent({
    type: 'thread_upsert',
    payload: { ...thread, org_id: orgId },
  });
}
```

`getThreads()` rows now include `user_ask_log`, and this path does not go through `toAdminThreadPayload`, so the log rides along in the bootstrap RPC payload. Not a stored leak today — the `thread_upsert` handler in `workers/main/src/app-index-db.ts` (~line 770) extracts an explicit column list, so the field is dropped on arrival — but this is the one remaining dispatch path where the log leaves OrgDO, and the invariant is supposed to be "the ask log never leaves the DO."

Fix: strip the field at the spread site, mirroring `toAdminThreadPayload` in `org-do.ts` (that helper is module-private to org-do; a local destructure is fine):

```ts
for (const thread of threads) {
  const { user_ask_log: _omitted, ...adminThread } = thread;
  await appIndex.applyAdminEvent({
    type: 'thread_upsert',
    payload: { ...adminThread, org_id: orgId },
  });
}
```

No test needed beyond `bun run typecheck`.

Nothing else to change — do not refactor or expand scope beyond this item.
