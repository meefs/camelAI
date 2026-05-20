# Chat Performance P0 PR Readiness Review

## Scope

Reviewed the current worktree implementation of
`docs/chat-performance-p0-prescriptive-plan.md` after the implementation agent's
changes.

This review covers:

- active chat route revalidation containment
- local chat-group title/model/provider patching
- completion-frame revalidation removal
- active-only preview panel rendering
- direct HTML preview source caching and iframe lifecycle changes
- message bubble hot-path memo/perf cleanup
- newly added unit and browser tests

No production fixes were made during this review. This document is intended as
the handoff for the next implementation pass.

## Verification Run

Commands run:

```bash
bun run test:run tests/chat-route-revalidation.test.ts tests/chat-preview-session-compare.test.ts tests/chat-preview-shell.test.tsx tests/code-preview.test.tsx tests/message-bubble-tool-continuation.test.tsx tests/chat-groups-ui.test.tsx tests/chat-debug-flags.test.ts tests/chat-draft-persistence.test.tsx tests/chat-admin-readonly-loader.test.ts
bun run typecheck
bun run test:e2e -- e2e/html-preview-sandbox.spec.ts
bun run lint
git diff --check
```

Results:

- Targeted Vitest suite passed: 9 files, 99 tests.
- Typecheck passed.
- New Playwright HTML sandbox spec passed: 1 test.
- ESLint passed.
- `git diff --check` passed.

## Verdict

The implementation is directionally strong and addresses the highest-cost
behaviors from the audit: full active-thread revalidation after completion,
eager inactive preview mounting, and direct HTML double-fetching.

However, the current implementation also adds a click-to-run gate for direct
HTML previews. That UX tradeoff is too expensive: users should not have to press
an extra button before seeing an interactive HTML preview. Remove that feature
entirely before PR review.

I would not treat the patch as fully PR-ready until the first three findings
below are addressed or explicitly accepted. The remaining items are test and
hardening gaps that should be added before calling the P0 performance work
closed.

## Findings

### 1. High: Remove Click-To-Run HTML Preview Gating Entirely

Files:

- `src/components/chat-file-preview/file-preview-content.tsx:3`
- `src/components/chat-file-preview/file-preview-content.tsx:16`
- `src/components/chat-file-preview/file-preview-content.tsx:150`
- `src/components/chat-file-preview/file-preview-content.tsx:178`
- `tests/code-preview.test.tsx`
- `e2e/html-preview-sandbox.spec.ts`

The implementation changes direct HTML file previews so they render with an
empty iframe `sandbox` by default, overlay a "Run interactive preview" button,
and only enable scripts after the user clicks. This is too large a UX regression
for the performance win. Direct HTML previews are a core part of the app
experience; they should feel immediate and live when a user opens the preview
tab.

The performance issue should be addressed by reducing unnecessary mounts and
loads, not by requiring a manual activation step.

Required removal:

- Remove the `interactive` state from `HtmlPreview`.
- Remove the `useEffect` that resets `interactive` on `src`/`title`.
- Remove the `Button` import from `@/components/ui/button`.
- Remove the `Play` import from `lucide-react`.
- Remove the overlay container and "Run interactive preview" button.
- Remove the empty-sandbox default.
- Render a single iframe immediately with the prior script-capable sandbox:

  ```tsx
  <iframe
    src={src}
    title={title}
    sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"
    referrerPolicy="no-referrer"
    className={cn("w-full bg-white", layout === "panel" ? "h-full" : "h-[60vh]")}
  />
  ```

- Keep `allow-same-origin` out of the sandbox. That part is still important.
- Keep the no-parent-fetch behavior for HTML preview mode. The iframe should be
  the only preview-mode network load.
- Keep active-only preview tab mounting. Inactive HTML previews should not be
  mounted and therefore should not run.

Tests that must change:

- Remove or rewrite any test that expects the button, empty sandbox, or
  click-to-enable behavior.
- `tests/code-preview.test.tsx` should assert:
  - HTML preview mode renders an iframe immediately
  - the iframe sandbox includes `allow-scripts`
  - the iframe sandbox does not include `allow-same-origin`
  - HTML preview mode does not call `fetch(previewUrl)`
  - HTML source mode still fetches on demand
- `e2e/html-preview-sandbox.spec.ts` should not test "scripts stay paused until
  explicitly enabled" because that behavior must be removed.
- Replace that E2E with a browser test that proves the acceptable performance
  behavior:
  - an active HTML preview script can run immediately
  - switching away or unmounting the active preview removes the iframe
  - after unmount, script messages stop
  - inactive preview tabs never mount their iframe

Acceptance criteria:

- There is no "Run interactive preview" button anywhere in the HTML preview UI.
- Direct HTML previews are interactive immediately when the preview tab is
  active.
- Inactive HTML preview tabs do not run because their iframe is not mounted.
- HTML preview mode still avoids the parent `fetch(previewUrl)`.
- Tests cover the immediate-run UX and the inactive/unmount lifecycle.

### 2. Medium: Optimistic Thread Summary Patches Can Be Cleared By Stale Group Data

Files:

- `src/hooks/use-chat-groups.tsx:166`
- `src/hooks/use-chat-groups.tsx:350`
- `src/hooks/use-chat-groups.tsx:416`
- `src/routes/_app.chat.$id.tsx:827`
- `src/routes/api/threads.$id.ts:26`
- `src/components/Chat.tsx:1798`
- `src/components/Chat.tsx:3470`

The stale-patch issue from the prior review is partially fixed: summary patches
are now reconciled when fresh `data?.chatGroups` arrives. However, the current
reconciliation deletes a patch whenever the refreshed group data contains the
thread id. It does not check whether the refreshed thread summary actually
contains the patched title/model/provider, nor whether the refreshed
`updated_at` is newer than the optimistic patch.

That creates a race:

1. Local UI receives a title/model update and inserts a summary patch.
2. Parent app loader revalidates and returns group data that still has the old
   summary.
3. `reconcileThreadSummaryPatchesWithGroups(...)` sees the thread id and deletes
   the patch.
4. The sidebar/tab can flicker or revert to the old title/model until a later
   refresh.

This is less severe than permanent stale patches, but it is still a visible
metadata correctness risk. It is especially relevant because `Thread` and
`ChatGroupThreadSummary` already have `updated_at`, and the title/model mutation
paths return updated thread data.

Recommended fix:

- Extend `ThreadSummaryPatch` with a revision:

  ```ts
  type ThreadSummaryPatch = {
    title?: string;
    model?: LlmModel;
    provider?: ChatHarness;
    updatedAt: number;
  };
  ```

- For manual rename, read the `PATCH /api/threads/:id` response body and
  dispatch the returned `thread.updated_at` with the title patch.
- For `updateThreadModelFetcher.data.thread`, dispatch
  `thread.updated_at` with the model/provider patch.
- For WebSocket-generated `title_updated` and `thread_model_updated`, update
  the server broadcast to include the updated thread revision:
  - `workers/main/src/chat-thread-do.ts:setTitle(...)`
  - `workers/main/src/chat-thread-do.ts:setModel(...)`
  - call those methods with the `updated_at` value returned by `OrgDO`.
- Reconcile by comparing the refreshed group thread summary with the patch:
  - if the refreshed thread is missing, delete the patch
  - if `thread.updated_at >= patch.updatedAt`, delete the patch because the
    server source has caught up or superseded it
  - if `thread.updated_at < patch.updatedAt`, keep the patch because the loader
    returned older data

Tests to add:

- Unit test: a patch should survive group data with the same thread id but an
  older `updated_at`.
- Unit test: a patch should be removed when group data has matching or newer
  `updated_at`.
- Provider/component test: dispatch a local title patch, then refresh group data
  with an older title and older `updated_at`; the visible tab title should stay
  patched.
- Provider/component test: refresh group data with a newer different title; the
  server title should win.

### 3. Medium: Active Chat `shouldRevalidate` Should Not Let Defaults Override Thread Or Loader-Param Changes

File:

- `src/lib/chat-route-revalidation.ts:25`

The helper currently returns `false` for `updateThreadModel` form data and for
`defaultShouldRevalidate === false` before checking pathname, thread id, or
loader-affecting search params.

That makes the helper correct for the expected current calls, but fragile. A
future caller, redirect, or React Router edge case could pass
`defaultShouldRevalidate: false` during a real thread navigation or group/search
change. In that case, the active chat route could skip the loader and render
stale thread data.

Recommended fix:

- Check route identity and loader-affecting inputs before honoring
  `defaultShouldRevalidate === false` or `updateThreadModel`:

  ```ts
  if (!currentUrl || !nextUrl) return defaultShouldRevalidate;
  if (currentUrl.pathname !== nextUrl.pathname) return true;
  if (currentParams?.id !== nextParams?.id) return true;
  if (loaderAffectingSearchParamChanged(currentUrl, nextUrl)) return true;
  if (formData?.get("intent") === "updateThreadModel") return false;
  if (!defaultShouldRevalidate) return false;
  return false;
  ```

- Consider adding the dev-only loader-affecting params used by the route:
  `devCreditState` and `devChatError`. These do not matter in production, but
  including them avoids confusing local testing.

Tests to add:

- `defaultShouldRevalidate: false` plus different thread id returns `true`.
- `defaultShouldRevalidate: false` plus different `group` returns `true`.
- `updateThreadModel` with the same thread returns `false`.
- `updateThreadModel` with a different thread id still returns `true`.

### 4. Medium: Browser HTML Preview Tests Must Exercise The App Implementation

Files:

- `e2e/html-preview-sandbox.spec.ts:3`
- `src/components/chat-file-preview/file-preview-content.tsx:150`
- `src/components/chat-preview/chat-preview-shell.tsx:246`

The new Playwright test is synthetic. It creates a hand-written iframe and
button with `page.setContent(...)` rather than rendering `FilePreviewContent` or
`PreviewPanelShell`. It also tests the click-to-run behavior that should be
removed per Finding 1.

The browser coverage should protect the real app behavior: active HTML previews
run immediately, inactive previews are not mounted, and switching away tears down
the active iframe.

Recommended fix:

- Delete or rewrite the current synthetic click-to-run browser test.
- Add an app/component-level browser test that mounts the actual preview code.
  The test should:
  - render an HTML preview through `FilePreviewContent` or the real preview
    panel
  - use an HTML fixture whose script posts messages in a
    `requestAnimationFrame` loop
  - assert messages start while the HTML preview tab is active
  - switch tabs or unmount and assert messages stop

If mounting the real app route is too expensive because of auth, create a small
test-only harness route or Playwright fixture page that imports and renders the
real component. Avoid another hand-written DOM copy of the implementation.

### 5. Medium: HTML Preview Mode Now Bypasses Existing HTTP Error UI

Files:

- `src/components/chat-file-preview/file-preview-content.tsx:266`
- `src/components/chat-file-preview/file-preview-content.tsx:415`

The new behavior correctly avoids parent-fetching HTML in preview mode. That
removes the double load. The tradeoff is that preview mode no longer uses the
existing `textStatus === "error"` path for failed `previewUrl` requests. A 403,
404, or other content route failure will render whatever the browser shows in
the sandboxed iframe instead of the app's normal preview error message.

Do not reintroduce a full GET just to recover the old error state. That would
undo the double-load fix.

Recommended fix:

- Decide the intended product behavior for failed direct HTML previews.
- Prefer one of these:
  - make the file-content API return an iframe-friendly error document for HTML
    preview requests
  - add a lightweight preview-error state only if it does not duplicate the HTML
    GET payload
  - explicitly accept iframe-rendered errors and add tests for that behavior

Tests to add:

- HTML source mode still shows the existing app error message on failed fetch.
- HTML preview mode has a defined behavior for 404/403 and that behavior is
  covered in a browser test.

### 6. Medium: No Integration Test Proves Same-Thread Revalidation Avoids Message Loading

Files:

- `tests/chat-route-revalidation.test.ts:8`
- `tests/chat-admin-readonly-loader.test.ts:102`
- `src/routes/_app.chat.$id.tsx:269`
- `src/components/Chat.tsx:2048`

The helper tests are good, and the Chat completion test verifies
`mockRevalidate` is not called for completion frames. However, there is still no
integration-style test that proves a real same-thread route revalidation cannot
call `readThreadMessages(...)`.

The test in `chat-admin-readonly-loader.test.ts` asserts
`readThreadMessagesMock` was not called after invoking `shouldRevalidate(...)`,
but the loader was not invoked in that test. That assertion does not protect the
real expensive path.

Recommended tests:

- Route integration test with `readThreadMessages(...)` mocked:
  - initial loader can load messages
  - same-thread/same-URL revalidation is skipped before the loader path
  - thread id change still calls the loader and loads messages
- Mark-viewed integration test:
  - mount the active chat route or a close route harness
  - trigger the mark-viewed effect
  - assert `/api/threads/:id/mark-viewed` is called
  - assert active route message loading is not called again
- Background status integration test:
  - emit `camelai:thread-status` or status socket data for another thread
  - assert sidebar status updates
  - assert active thread messages are not reloaded

### 7. Low: Parent App Revalidation Still Happens For Some Metadata Actions

Files:

- `src/routes/_app.tsx:31`
- `src/routes/_app.chat.$id.tsx:846`
- `src/routes/_app.chat.$id.tsx:856`
- `src/routes/_app.chat.$id.tsx:869`

The active chat route now avoids full transcript reloads for same-thread
revalidation, which is the important P0 containment. The parent `_app` loader
still revalidates for actions such as tab rename, group rename, and tab reorder.
That loader fetches auth, billing, and chat groups.

This is acceptable for deliberate user actions, but it should not become the
normal path for frequent background status/metadata updates.

Recommendation:

- Keep this for now if the first two findings are fixed.
- Do not add new background or high-frequency `revalidator.revalidate()` calls.
- Longer term, move chat group summary refreshes to a narrower resource/fetcher
  so metadata changes do not reload the full app shell.

## Things That Look Good

- `PreviewPanelShell` now renders only the active tab body. Inactive file tabs no
  longer mount `FilePreviewContent`, and inactive app tabs no longer mount
  iframes.
- HTML preview mode no longer parent-fetches the HTML before iframe navigation.
- HTML source mode remains on-demand and is cached by full `previewUrl`, so
  `?v=0` and `?v=1` do not collide.
- Completion frames no longer call route revalidation or schedule delayed
  revalidation timers.
- `message-bubble.tsx` removes the quadratic `content.slice(...).some(...)`
  continuation scan.
- `applyLiveRunningStatuses(...)` now preserves group/thread object identities
  on no-op status frames, which should reduce memo churn.
- Direct HTML previews no longer need a parent fetch in preview mode. Keep this
  part, but remove the click-to-run/button behavior from Finding 1.

## Additional Tests Worth Adding Before PR Review

These are the highest-value tests that avoid mock-only coverage:

1. **Revision-aware summary patch reconciliation**
   - Unit and provider-level tests as described in Finding 1.

2. **Hardened `shouldRevalidate` routing**
   - Cover thread id and loader-search changes when
     `defaultShouldRevalidate` is false.

3. **Real preview panel inactive-fetch regression**
   - Render `PreviewPanelShell` with one active app tab and one inactive HTML
     file tab using the real `FilePreviewContent`.
   - Stub `fetch` and assert inactive file content is not fetched.
   - Switch to the file tab and assert fetch happens once.

4. **Real browser HTML preview script lifecycle**
   - Use actual `FilePreviewContent` or the real preview panel.
   - Assert scripts run immediately while active, inactive tabs do not mount,
     and scripts stop after tab switch/unmount.

5. **Active route no-message-reload integration**
   - Exercise route/component wiring, not just pure helper inputs.
   - Assert `readThreadMessages(...)` is not called for mark-viewed,
     completion, title/model side-channel updates, or background status updates.

6. **Preview session state preservation**
   - Component-level test that semantically equal loader preview session data
     does not reset file source/preview mode, notebook mode, or iframe keys.

7. **HTML error behavior**
   - Source mode error handling remains unchanged.
   - Preview mode has a deliberate, tested behavior for 404/403.

## Remaining P0 Work Not Solved By This Diff

This patch should reduce app-wide jank substantially, but it does not structurally
solve long-transcript DOM cost. The chat transcript is still fully mounted and
rendered. If the slow scrolling is primarily caused by hundreds of heavy
messages, markdown blocks, code blocks, and tool call components, the issue can
still return after this patch.

The next performance wave should implement the transcript virtualization work
from `docs/chat-performance-p0-prescriptive-plan.md`:

- virtualize message groups/turns, not individual text fragments
- keep the active streaming assistant turn mounted
- preserve scroll position when older messages are prepended
- add a 500+ message regression fixture that asserts bounded mounted message
  count and stable scroll position
