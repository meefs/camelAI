# Chat Performance P0 Final PR Review

## Findings

### 1. Low: Admin Thread Metadata Broadcasts Still Omit `updatedAt`

Files:

- `src/routes/_admin.threads.$id.tsx:72`
- `src/routes/_admin.threads.$id.tsx:92`
- `workers/main/src/routes/admin/routes.ts:287`
- `workers/main/src/routes/admin/routes.ts:328`
- `workers/main/src/routes/admin/routes.ts:1375`
- `workers/main/src/routes/admin/routes.ts:1384`
- `workers/main/src/routes/admin/routes.ts:1399`
- `workers/main/src/routes/admin/routes.ts:1408`

The main chat title/model update paths now pass `updated_at` through the
`title_updated` and `thread_model_updated` side channel. That fixes the stale
optimistic patch race for normal chat updates.

The admin thread-edit paths still notify `ChatThreadDO` without the returned
thread revision:

- `_admin.threads.$id.tsx` ignores the `adminUpdateThread(...)` return value,
  then calls `chatThread.setTitle(title.trim())`.
- `workers/main/src/routes/admin/routes.ts` stores `result`, but
  `notifyThreadMetadataChange(...)` receives only the request body and calls
  `setTitle(updates.title)` / `setModel(updates.model)`.

Because the client falls back to `Date.now()` when `updatedAt` is missing, an
admin-originated title patch can survive reconciliation longer than needed if a
loader refresh returns the same server update with a slightly older
`updated_at`. The visible title should still be correct because the patch value
matches the admin update, so this is not a blocker. It is still worth tightening
so every metadata producer follows the same revision contract.

Recommended fix:

- Capture the `adminUpdateThread(...)` result in `_admin.threads.$id.tsx` and
  pass `updated?.updated_at` into `chatThread.setTitle(...)`.
- Change `notifyThreadMetadataChange(...)` to accept `updatedAt?: number`.
- When the admin API has `result`, pass `result.updated_at` into
  `notifyThreadMetadataChange(...)`.
- Forward that revision to `setTitle(...)` and `setModel(...)`.

Tests worth adding:

- Admin route test: successful title update calls the mocked `setTitle` with the
  returned `updated_at`.
- Admin API worker test: `notifyThreadMetadataChange` forwards `result.updated_at`
  into `setTitle` / `setModel`.

### 2. Low: Preview Session Preservation Still Has Only Helper-Level Coverage

Files:

- `src/components/Chat.tsx:1004`
- `src/components/chat-preview/preview-session-compare.ts:23`
- `tests/chat-preview-session-compare.test.ts:15`

The semantic preview-session comparison is the right shape: same-thread loader
metadata changes no longer reset preview state when the preview targets are
effectively the same. The tests cover the comparison helper, but not the
component behavior where the regression would be user-visible.

This is not blocking because the helper tests are good and the code is simple.
The missing coverage is that a fresh but semantically equal loader session
should not reset per-tab view mode, iframe key state, notebook mode, or mobile
preview state in `Chat`.

Recommended test:

- Mount `Chat` with an app or HTML file preview.
- Change local preview UI state, such as file source/preview mode or iframe key.
- Rerender with a fresh `initialPreviewTabs` array that is semantically equal.
- Assert the local preview mode/key state is preserved.
- Rerender with a truly different target and assert the state resets.

### 3. Low: Long Transcript DOM Cost Remains Out Of Scope For This Patch

Files:

- `src/components/Chat.tsx`
- `src/components/chat-messages-view.tsx`

This patch removes several major avoidable jank sources:

- same-thread completion revalidation
- delayed completion revalidation timers
- eager inactive preview iframe/file mounting
- direct HTML preview double-fetching
- automatic hidden HTML iframe execution
- a quadratic tool continuation scan

It does not virtualize the transcript. A very long chat with many markdown/code
blocks and tool components can still become expensive because the full
transcript remains mounted. Based on the user's current testing, this does not
need to block this PR, but it should remain tracked as the next structural
performance step if slow scrolling returns on larger histories.

Recommended future work:

- Virtualize message groups/turns rather than individual content fragments.
- Keep the active streaming assistant turn mounted.
- Preserve scroll position when prepending older messages.
- Add a 500+ message regression fixture that asserts bounded mounted message
  count and stable scroll position.

## Things That Look Ready

- The click-to-run HTML preview gating has been removed. HTML previews render
  interactively immediately with `allow-scripts`, while still omitting
  `allow-same-origin`.
- HTML preview mode no longer parent-fetches the file body; source mode still
  fetches on demand and caches by full `previewUrl`.
- The Playwright HTML preview harness now renders the real `PreviewPanelShell`
  path and verifies only the active HTML iframe runs.
- Active preview rendering now mounts only `activeTabState`; inactive file tabs
  do not fetch and inactive app/HTML tabs do not keep iframes alive.
- Revision-aware local thread summary patches now preserve optimistic metadata
  over older loader data and clear when matching/newer server data arrives.
- Active chat route `shouldRevalidate` now checks thread id and loader-affecting
  search params before honoring `defaultShouldRevalidate === false` or the
  `updateThreadModel` fast path.
- Completion frames no longer call broad route revalidation or schedule delayed
  revalidation timers.
- `message-bubble.tsx` removes the per-tool `content.slice(...).some(...)`
  scan and preserves empty mention array identity.

## Verification Run

Commands run during this review:

```bash
bun run test:run tests/chat-route-revalidation.test.ts tests/chat-preview-session-compare.test.ts tests/chat-preview-shell.test.tsx tests/code-preview.test.tsx tests/message-bubble-tool-continuation.test.tsx tests/chat-groups-ui.test.tsx tests/chat-debug-flags.test.ts tests/chat-draft-persistence.test.tsx tests/chat-admin-readonly-loader.test.ts
bun run typecheck
bun run lint
git diff --check
bun run test:e2e -- e2e/html-preview-sandbox.spec.ts
bun run test:workers -- workers/main/tests/admin-api-thread-update.test.ts workers/main/tests/chat-thread-codex-external-turn.test.ts workers/main/tests/user-do-chat-groups.test.ts
bun run test:run
```

Results:

- Focused Vitest suite passed: 9 files, 108 tests.
- Full Vitest suite passed: 161 files passed, 1 skipped; 1150 tests passed, 4
  skipped.
- Typecheck passed.
- ESLint passed.
- `git diff --check` passed.
- Playwright HTML preview harness passed: 1 test.
- Focused worker suite passed: 3 files, 73 tests.

## PR Readiness

I did not find a merge-blocking issue in the current diff. I would either fix
Finding 1 before PR because it is a small consistency cleanup, or explicitly
call it out as a follow-up. Findings 2 and 3 are reasonable follow-ups and do
not need to block this PR.
