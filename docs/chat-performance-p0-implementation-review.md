# Chat Performance P0 Implementation Review

## Scope

Reviewed the current worktree implementation of
`docs/chat-performance-p0-prescriptive-plan.md`.

This patch appears to implement:

- active chat route revalidation containment
- disabled default status revalidation
- removal of duplicate completion revalidations
- active-only preview tab mounting
- direct HTML preview no-fetch mode
- script-paused direct HTML previews with click-to-run
- preview session semantic comparison
- preview timer cleanup for inactive/closed tabs
- the tool continuation and empty annotation hot spots

It does not yet implement transcript virtualization, bounded/versioned message
history, or notebook HTML lazy mounting. Those remain necessary for the full P0
plan.

## Verification Run

Commands run during review:

```bash
bun run test:run tests/chat-route-revalidation.test.ts tests/chat-preview-session-compare.test.ts tests/chat-preview-shell.test.tsx tests/code-preview.test.tsx tests/message-bubble-tool-continuation.test.tsx tests/chat-groups-ui.test.tsx tests/chat-debug-flags.test.ts
bun run typecheck
git diff --check
```

Result:

- targeted tests passed: 7 files, 73 tests
- typecheck passed
- `git diff --check` passed

## Findings

### 1. High: Local Thread Summary Patches Can Become Permanently Stale

Files:

- `src/hooks/use-chat-groups.tsx:267`
- `src/hooks/use-chat-groups.tsx:376`
- `src/hooks/use-chat-groups.tsx:383`
- `src/hooks/use-chat-groups.tsx:571`
- `src/components/Chat.tsx:1798`
- `src/routes/_app.chat.$id.tsx:827`

The implementation adds `localThreadSummaryPatches` for title/model/provider
updates. That is a good way to avoid full route revalidation, but the patches
are never reconciled or expired.

Once a patch is inserted, `applyLiveRunningStatuses(...)` keeps applying it over
fresh loader data. If the same thread is later renamed from another tab/device,
or if a later server refresh contains a newer title/model/provider, the local
patch can continue overriding the server truth for the lifetime of the provider.
The map can also grow as many threads are updated.

Recommended fix:

- Treat summary patches as optimistic, not authoritative.
- Clear a thread's patch when fresh route/group data arrives for that thread.
- If the fresh source already matches the patch, delete the patch.
- If the fresh source differs from the patch after a revalidation, prefer the
  server value unless the patch has an explicit newer revision/timestamp.
- At minimum, clear all `localThreadSummaryPatches` when `data?.chatGroups`
  identity changes after a successful revalidation.

Tests worth adding:

- Provider-level test: dispatch a local title patch, then provide fresh route
  loader data with a different title; the fresh server title should win after
  reconciliation.
- Unit-level test if reconciliation is extracted: patch matching source is
  removed, stale patch is removed or superseded, unrelated patches remain.

### 2. Medium: Browser Title/Route Meta No Longer Update On `title_updated`

Files:

- `src/routes/_app.chat.$id.tsx:60`
- `src/components/Chat.tsx:1798`

`title_updated` now patches chat-group state locally instead of revalidating the
route. That is right for performance, but route `meta(...)` still reads
`threadTitle` from loader data. The chat tab row can update while the browser
document title remains stale until a later navigation or full route reload.

Recommended fix:

- Add a small local document-title update for the active thread title, or move
  active title display/meta ownership to a small title state that is updated by
  the same side-channel event.
- Do not reintroduce full transcript revalidation just to update the title.

Tests worth adding:

- Component/route test around `title_updated`: chat-group tab title updates and
  `document.title` updates without fetching full `chatData.messages`.

### 3. Medium: Script-Paused HTML Behavior Needs A Real Browser Regression Test

Files:

- `src/components/chat-file-preview/file-preview-content.tsx:150`
- `tests/code-preview.test.tsx`

The jsdom tests assert the sandbox string and fetch behavior, but jsdom does not
execute iframe documents like a real browser. The production risk in the user
trace was real iframe script work and expensive iframe teardown, so this needs
at least one browser-level regression test.

Recommended test:

- Use Playwright against a small test page or fixture route that serves an HTML
  file with inline script such as:
  `window.parent.postMessage({ type: "html-ran" }, "*")` plus a
  `requestAnimationFrame` loop.
- Render it through `FilePreviewContent` or the real preview panel.
- Assert no message is received before clicking "Run interactive preview".
- Click the button and assert the message is received.
- Switch away/unmount and assert no continuing messages are received.

This should be a real browser test. A mocked unit test cannot prove the scripts
are actually paused.

### 4. Medium: Revalidation Containment Needs Integration Tests Around The Real Route

Files:

- `src/lib/chat-route-revalidation.ts`
- `src/routes/_app.chat.$id.tsx`
- `src/components/Chat.tsx`

The pure helper tests are useful, but the highest-value regression is ensuring
the active route does not call full message loading after common events:

- mark viewed
- turn completed
- background thread status update
- title/model side-channel update

Recommended tests:

- Route-level integration test with `readThreadMessages(...)` mocked/spied:
  same-thread `revalidator.revalidate()` should not call it.
- Chat/WebSocket integration test: emit `turn/completed`; assert no delayed
  global revalidation is scheduled.
- Chat group status integration test: emit a background `thread_status`; assert
  sidebar state updates without active route message reload.

These tests should exercise the route/component wiring. Avoid testing only a
copied `shouldRevalidate` input table.

### 5. Medium: Active-Only Preview Tests Should Cover Real Inactive Fetch Avoidance

Files:

- `src/components/chat-preview/chat-preview-shell.tsx:246`
- `tests/chat-preview-shell.test.tsx`

The new shell tests mock `FilePreviewContent`, so they verify the render shape
but not the most important side effect: inactive file previews must not fetch.

Recommended test:

- Add an integration-style `PreviewPanelShell` test that uses the real
  `FilePreviewContent`.
- Configure active tab as an app preview and inactive tab as an HTML file.
- Stub `fetch` and assert it is not called.
- Then switch active tab to the file and assert the file preview behavior runs.

This directly protects the power-efficiency fix.

### 6. Medium: Long Transcript Performance Is Still Structurally Unfixed

Files:

- `src/components/chat-messages-view.tsx`
- `src/components/Chat.tsx`

This patch reduces avoidable revalidation and preview iframe work, but long
threads are still fully mounted. That means slow scroll can still return on
large transcripts, especially with markdown/code/tool-heavy histories.

Recommended next implementation:

- Implement transcript virtualization from the prescriptive plan.
- Virtualize message groups/turns first.
- Keep active streaming assistant turn mounted.
- Preserve scroll offset when older messages are prepended.

Tests worth adding with virtualization:

- A 500+ message fixture mounts only a virtual window of message groups.
- The active streaming assistant group remains mounted.
- Prepending older messages preserves scroll position.
- Unchanged message bubbles do not commit on background status updates.

## Additional Test Recommendations

These are worth adding before considering this P0 closed:

1. **No Full Reload On Mark Viewed**
   - Use the real chat route or a route harness.
   - Assert successful `/mark-viewed` does not call the active route
     revalidator or `readThreadMessages(...)`.

2. **No Completion Revalidation Timers**
   - Use fake timers around `Chat`.
   - Emit Codex `turn/completed`, Claude result, and generic result events.
   - Assert no 1s/3s route revalidation timers are scheduled.

3. **Preview Semantic Equality Preserves State**
   - Existing helper tests are good.
   - Add a component-level test that a fresh but semantically equal loader
     preview session does not reset source/preview mode or iframe keys.

4. **HTML Source Cache Does Not Leak Across Versions**
   - Toggle HTML source mode, then change `previewUrl` from `?v=0` to `?v=1`.
   - Assert source is fetched for the new version.

5. **Stale Summary Patch Regression**
   - Dispatch local title/model update.
   - Simulate fresh server group data with a newer different value.
   - Assert the UI uses the fresh server value after reconciliation.

## Review Summary

The implementation is directionally strong and the targeted tests pass. The
largest correctness issue is the missing lifecycle for
`localThreadSummaryPatches`; fix that before merge. The largest remaining P0
risk is that transcript virtualization and bounded/versioned history are still
not implemented, so this patch is a strong first wave but not the full
performance fix.
