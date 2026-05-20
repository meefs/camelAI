# P0 Chat Performance Prescriptive Fix Plan

## Status

This is the implementation handoff. It supersedes these audit notes:

- `docs/chat-performance-p0-audit.md`
- `docs/chat-preview-html-renderer-performance-audit.md`

Those docs remain useful background, but the implementation agent should follow
this document first.

## Goal

Make chat scrolling and chat-group tab switching stable, fast, and power
efficient under long transcripts and expensive HTML previews.

Do not treat this as a narrow hover-state bug or a React bug. The app is doing
too much work in too many places:

1. Active chat data is revalidated too broadly.
2. Revalidation reloads and reparses full transcripts.
3. Long transcripts are fully mounted.
4. Message memoization is defeated by recreated objects.
5. Preview iframes are mounted too eagerly.
6. Direct HTML previews run arbitrary user scripts by default.

The fixes below are ordered. Do not start with speculative rewrites or broad
state-management changes.

## Concrete Evidence

### Full Chat Work

Current code can reload full chat history during same-thread/global
revalidation:

- `src/routes/_app.chat.$id.tsx` has no child `shouldRevalidate`.
- `buildChatData(...)` calls `readThreadMessages(...)` when `loadMessages` is
  true: `src/routes/_app.chat.$id.tsx:160-225`.
- Full Pi-core history is parsed and converted in
  `workers/main/src/chat-thread-do.ts:2386-2417` and
  `workers/main/src/chat-thread-do.ts:2763-2781`.
- Client loader sync reparses messages and does deep content equality:
  `src/components/Chat.tsx:407-415`,
  `src/components/Chat.tsx:640-669`,
  `src/components/Chat.tsx:251-270`.

### Full DOM Work

The transcript is not virtualized:

- `Chat` passes all visible messages into `ChatMessagesView`:
  `src/components/Chat.tsx:4062-4095`.
- `ChatMessagesView` groups and maps all messages:
  `src/components/chat-messages-view.tsx:95-139`,
  `src/components/chat-messages-view.tsx:165-229`.

### HTML Preview Work

Preview tabs are all mounted and inactive tabs are only hidden with CSS:

- `src/components/chat-preview/chat-preview-shell.tsx:247-298`.

Direct HTML preview double-loads:

- parent fetch includes `previewType === 'html'`:
  `src/components/chat-file-preview/file-preview-content.tsx:223-252`
- iframe then loads the same `previewUrl`:
  `src/components/chat-file-preview/file-preview-content.tsx:352-379`.

### User Trace

The user trace recorded on 2026-05-20 points to
`hot-pink-screensaver.html` as the worst HTML file:

- sampled JS concentrates in `drawFrame` around line 320, with
  `drawConnections` and `drawParticle` also present
- hot-pink `FunctionCall` time is about 137ms across 229 calls, versus about
  61ms for `blue-screensaver.html` and about 46ms for `screensaver.html`
- switching away from hot-pink shows large non-main-frame iframe teardown tasks:
  about 196ms and about 180ms in `RenderFrameImpl::Delete` /
  `FrameDetached` / `WebFrameWidgetImpl::Close`

The trace does not show all chat-group tabs mounted as full `Chat` components.
It shows one active HTML preview at a time, plus expensive active iframe script
and iframe teardown/recreation during chat-group tab switches.

## Required Implementation Order

### Phase 1: Stop Full-Transcript Revalidation

This is the first patch. It reduces app-wide jank without changing the UI.

#### 1. Add `shouldRevalidate` To The Active Chat Route

File:

- `src/routes/_app.chat.$id.tsx`

Export a route-level `shouldRevalidate`.

Return `true` when:

- the pathname changes
- the thread id path param changes
- loader-affecting search params change:
  `adminReadonly`, `newThread`, `chatCache`, `group`

Return `false` when:

- this is a same-thread, same-URL global revalidation
- a fetcher/action result does not need transcript data
- the action is only `updateThreadModel`; `Chat` already updates model locally

Acceptance:

- Calling `revalidator.revalidate()` while staying on the same chat does not
  call `readThreadMessages(...)`.
- Same-thread metadata changes do not reload the full transcript.

Tests:

- add focused tests for `shouldRevalidate`
- cover same-thread false, different thread true, loader search param change
  true, `updateThreadModel` false

#### 2. Remove Explicit Full-Route Revalidation On Mark Viewed

File:

- `src/routes/_app.chat.$id.tsx`

Current mark-viewed effect calls `revalidateRef.current()` after the
`/api/threads/:id/mark-viewed` POST succeeds. Remove that global revalidation.

Update unread state through the chat-group/status owner instead of reloading the
active route. If there is no existing local patch helper, add the smallest one
inside `useChatGroups` rather than using route revalidation as a side effect.

Acceptance:

- Marking the visible thread viewed does not reload `chatData.messages`.
- Sidebar unread state still clears.

#### 3. Remove Duplicate Turn-Completion Revalidations

File:

- `src/components/Chat.tsx`

Current completion paths schedule broad revalidation after the WebSocket has
already streamed message state:

- Codex `turn/completed`
- Claude `sdkEvent.type === "result"`
- generic `data.type === "result"`

Remove the immediate + delayed full-route revalidations from those paths.

Keep local state updates that are actually needed:

- final message state from stream
- context usage
- model/provider changes
- title updates, but via a small title/group update path

Acceptance:

- A completed turn does not schedule 1s/3s active-route reloads.
- New final assistant content still appears.
- Thread title/model metadata still updates.

#### 4. Contain Background Status Revalidation

Files:

- `src/hooks/use-chat-groups.tsx`
- `src/lib/chat-debug-flags.ts`
- `src/routes/_app.tsx`

Do not let background thread status frames cause the active chat route to reload
full transcript data.

Prescriptive fix:

- make status frames patch chat-group context directly
- do not call the app/global route revalidator for ordinary status changes
- if a server refresh is still needed, load a small group/thread-summary
  resource, not the active chat route

Short-term acceptable containment:

- default `statusRevalidate` to false while the P0 is being fixed

Acceptance:

- Background thread completion changes sidebar/tab status.
- The visible chat's loader does not refetch messages because another thread
  changed status.

## Phase 2: Make Preview Rendering Power-Safe

This phase addresses the user trace and the HTML renderer suspicion. It should
land in the same implementation wave as Phase 1 if possible.

### 1. Mount Only The Active Preview Tab

File:

- `src/components/chat-preview/chat-preview-shell.tsx`

Replace the current `tabRenderStates.map(...)` body rendering with a single
active body render.

Required behavior:

- keep the tab row rendering all tabs
- compute `activeTabState`
- render only `activeTabState` content
- inactive preview tabs must not mount `FilePreviewContent`
- inactive app preview tabs must not mount iframes
- `iframeRef` is attached only to the active app iframe

Do not implement a many-iframe cache. It would preserve state at the cost of the
same power problem.

Acceptance:

- With three preview tabs, `document.querySelectorAll('iframe')` in the preview
  panel reflects only the active tab's iframe content.
- Inactive file tabs do not fetch content.
- Inactive app tabs do not run timers/animations.

Tests:

- inactive file tab does not render `FilePreviewContent`
- inactive app tab does not render an iframe
- switching active preview tab mounts exactly one body

### 2. Stop Double-Loading Direct HTML Previews

File:

- `src/components/chat-file-preview/file-preview-content.tsx`

Change HTML preview mode so it renders an iframe directly from `previewUrl`
without first fetching the HTML into React state.

Required behavior:

- HTML `preview` mode does not call `fetch(previewUrl)`
- HTML `source` mode still fetches text and renders `SourcePreview`
- preview/source toggle fetches source on demand
- cache source text per `previewUrl` if repeated toggling causes churn

Acceptance:

- Network shows one HTML preview load, not parent fetch plus iframe navigation.
- Existing source mode behavior still works.

Tests:

- HTML preview mode renders iframe and does not call `fetch`
- HTML source mode calls `fetch` and renders source
- existing sandbox test still passes

### 3. Make Direct HTML Files Script-Paused By Default

File:

- `src/components/chat-file-preview/file-preview-content.tsx`

This is the most important product-level stability decision for the trace.
Direct HTML files are arbitrary user code. If the app mounts them with
`allow-scripts`, a single generated animation can consume frame budget or make
iframe teardown expensive. The app should not run arbitrary direct-file HTML
scripts by default inside chat.

Required behavior:

- direct HTML file preview defaults to a static sandboxed iframe without
  `allow-scripts`
- render an explicit "Run interactive preview" control over the static preview
- when clicked, remount the iframe with the current script-enabled sandbox:
  `allow-scripts allow-forms allow-modals allow-popups allow-downloads`
- do not include `allow-same-origin`
- reset the interactive state when the preview tab changes, file URL changes, or
  chat thread changes

This applies to direct file HTML preview. It does not apply to app previews,
which are already explicitly deployed/running apps.

Acceptance:

- `hot-pink-screensaver.html` does not run `drawFrame` until the user clicks
  "Run interactive preview".
- Switching chat-group tabs with default direct HTML previews does not show the
  180-200ms hot-pink iframe teardown stall.
- User can still opt into interactive/scripted HTML.

Tests:

- default HTML iframe sandbox excludes `allow-scripts`
- clicking run remounts an iframe whose sandbox includes `allow-scripts`
- interactive state resets when `previewUrl` changes

### 4. Preserve Preview State Across No-Op Loader Data

File:

- `src/components/Chat.tsx`

Current effect resets preview state whenever loader tab array identity changes:

- `src/components/Chat.tsx:973-997`

Replace identity-based reset with semantic comparison.

Required behavior:

- compare incoming preview session by tab id, active tab id, target kind,
  script name, file path, workspace id, source, content type, and filename
- if semantically equal, do not reset:
  - iframe keys
  - file preview keys
  - notebook/report mode
  - preview/source mode
  - notebook load state
  - app loading state
  - mobile view
  - iframe retry/refresh timers
- if only `isPublic` changes, update that metadata without resetting preview
  render state
- true target changes should still reset stale per-tab state

Acceptance:

- no-op route revalidation with fresh loader objects does not reload the active
  iframe or reset source/preview mode
- intentional `preview_state` side-channel refresh still refreshes the targeted
  tab

Tests:

- fresh but semantically equal tabs preserve file/source mode
- fresh but semantically equal app tab preserves iframe key
- changed target resets stale state

### 5. Cancel Preview Timers For Closed Or Inactive Tabs

File:

- `src/components/Chat.tsx`

Current app preview retry/refresh logic can schedule delayed iframe key bumps.
Make it active-tab scoped.

Required behavior:

- do not schedule iframe refresh/retry for inactive app tabs
- clear pending refresh/retry timers when a tab is closed
- clear pending refresh/retry timers when the target tab becomes inactive
- keep active app retry behavior for transient deploy errors

Acceptance:

- inactive/closed preview tabs cannot later bump iframe keys
- active transient app deploy retry still works

Tests:

- closing a tab clears pending timer state
- inactive app preview error does not schedule a visible refresh

## Phase 3: Virtualize The Chat Transcript

This is the structural scroll fix. Do not rely on memoization alone while the
full transcript remains mounted.

Recommended dependency:

- `@tanstack/react-virtual`

Files:

- `src/components/chat-messages-view.tsx`
- `src/components/Chat.tsx`

Required behavior:

- virtualize message groups/turns, not individual markdown/tool blocks
- use the existing chat scroll container as the virtualizer scroll element
- keep the active streaming assistant turn mounted
- preserve bottom-stick behavior
- preserve scroll offset when older rows are prepended later
- preserve `data-message-id` and existing refs used by scroll anchoring

Do not virtualize at the individual content-block level first. That is more
complex and risks breaking assistant action/hover behavior.

Acceptance:

- a 500+ message thread does not mount 500+ message DOM subtrees
- idle scroll remains smooth
- streaming at the bottom remains stable
- user reading older messages is not pulled to bottom by new stream updates

Tests:

- long thread renders only a window of message groups
- last streaming assistant group remains mounted
- prepending older messages preserves scroll offset

## Phase 4: Make Message Loading And Equality Versioned

Phase 1 stops avoidable reloads. Phase 4 makes unavoidable reloads cheap.

Files:

- `workers/main/src/chat-thread-do.ts`
- `src/lib/chat-history.server.ts`
- `src/lib/chat-do.server.ts`
- `src/components/Chat.tsx`

Required behavior:

1. Add a cheap server-side history state method.
   - Return latest revision/count/updated timestamp for the thread.
   - Prefer a monotonically increasing revision over hashing whole payloads.
2. Include a stable version/revision on each UI message where possible.
3. Add bounded latest-message loading for Pi-core threads.
   - Use `getPiCoreMessageRows(limit)` as the starting point.
   - Initial active load should fetch latest N messages, not all messages.
   - Provide a cursor for loading older messages.
4. Replace client deep equality.
   - Stop using `JSON.stringify(message.content)` in no-op checks.
   - Compare message id + version/revision.
   - Reconcile by id/version and reuse unchanged message objects.

Acceptance:

- active initial load is bounded for Pi-core threads
- no-op loader comparison does not stringify the full transcript
- unchanged message objects keep identity across loader refreshes

Tests:

- unchanged id/version reuses object identity
- changed version replaces only that message
- bounded load returns newest messages plus older cursor

## Phase 5: Remove Known Render Hot Spots

These are smaller, low-risk improvements. They can land before virtualization if
they are quick, but they are not a substitute for Phases 1-3.

### 1. Fix Tool Continuation Scan

File:

- `src/components/message-bubble.tsx`

Current logic uses `content.slice(index + 1).some(...)` per tool-use block,
which is quadratic for tool-heavy messages.

Required behavior:

- compute "agent continued after this block" in one reverse pass
- pass/read the precomputed boolean during rendering

Tests:

- output matches current behavior for multiple tool-use/tool-result layouts
- large tool-block arrays run in linear time

### 2. Stabilize Empty Annotated Mentions

Files:

- `src/components/message-bubble.tsx`
- `src/components/markdown-renderer.tsx`

Required behavior:

- use a module-level `EMPTY_ANNOTATED_MENTIONS`
- avoid passing fresh empty arrays into `MarkdownRenderer`

Acceptance:

- markdown blocks do not rerender solely due to a recreated empty annotation
  array

### 3. Reconcile Messages By Version

File:

- `src/components/Chat.tsx`

After Phase 4 versions exist, keep unchanged message object references.

Acceptance:

- `MessageBubble` memo boundaries survive loader refreshes

### 4. Stabilize `onSnapshotChange`

File:

- `src/routes/_app.chat.$id.tsx`

Wrap `onSnapshotChange` in `useCallback` instead of passing an inline callback
to `Chat`.

Acceptance:

- this prop does not change identity on unrelated route renders

## Phase 6: Reduce Chat Group Context Churn

Files:

- `src/hooks/use-chat-groups.tsx`
- `src/routes/_app.tsx`
- `src/routes/_app.chat.$id.tsx`

Required behavior:

- no-op status frames preserve `Map` identity
- `applyLiveRunningStatuses(...)` returns original thread/group objects when
  status and unread state are unchanged
- `markThreadIdle` does not close over changing `liveThreadStatuses`; use a ref
- split context values so read-heavy group data and stable actions are separate
- avoid rerendering the full `Chat` subtree for sidebar-only status changes

Acceptance:

- no-op status frame does not commit the chat subtree
- background thread status updates do not rerender unchanged message bubbles

Tests:

- no-op status frame preserves identities
- `markThreadIdle` remains referentially stable across status updates
- existing chat group UI tests still pass

## Phase 7: Lazy-Mount Notebook HTML Outputs

Files:

- `src/components/chat-file-preview/notebook-preview/html-output.tsx`
- `src/components/chat-file-preview/notebook-preview/output-renderers.tsx`

Required behavior:

- wrap `NotebookHtmlOutput` in an `IntersectionObserver` gate
- before intersection, render a fixed-height placeholder
- mount the `srcDoc` iframe only when near the viewport
- keep existing parser behavior for Vega, Plotly, and native table outputs

Acceptance:

- notebook with many raw HTML outputs does not mount all HTML iframes at once
- scroll height remains stable when HTML output becomes visible

Tests:

- HTML output does not mount iframe before intersection
- intersection mounts iframe exactly once
- existing `tests/notebook-preview-utils.test.ts` continues passing

## Explicit Non-Goals

Do not implement these as first fixes:

- Do not remove `<Chat key={displayThreadId}>` as a speculative first step.
  That risks stale state. Revisit only after Phases 1 and 2 if chat-tab switch
  traces still show visible jank.
- Do not add a many-chat iframe cache. It makes power usage worse.
- Do not use `loading="lazy"` as the primary iframe fix. It does not solve
  mounted active animations.
- Do not keep direct HTML scripts running by default and try to memo around
  them. Arbitrary user HTML must be treated as expensive.
- Do not rely only on `React.memo` while the full transcript remains mounted.
- Do not permanently cap history without pagination.
- Do not silently drop title/model/status updates. Make those refreshes smaller
  and source-specific.

## Verification Plan

### Automated

Run targeted tests after each phase:

```bash
bun run typecheck
bun run test:run tests/code-preview.test.tsx tests/notebook-preview-utils.test.ts tests/preview-toolbar-notebook-download.test.tsx
bun run test:run tests/chat-groups-ui.test.tsx tests/message-bubble-streaming-indicator-order.test.tsx tests/message-bubble-touch-actions.test.tsx
bun run test:run tests/workspace-chat-messages-stream-api.test.ts tests/chat-admin-readonly-loader.test.ts
```

Add new focused tests for:

- active chat `shouldRevalidate`
- no global revalidation on mark viewed
- no duplicate completion revalidations
- active-only preview body rendering
- HTML preview no-fetch preview mode
- HTML script-paused default and click-to-run
- preview semantic reset behavior
- virtualized message group windowing
- message id/version reconciliation

### Manual

Use the user's trace scenario:

1. Open a chat group with `hot-pink-screensaver.html`,
   `screensaver.html`, and `blue-screensaver.html`.
2. Before clicking "Run interactive preview", confirm hot-pink has no sampled
   `drawFrame` work.
3. Switch away from the hot-pink chat and record a short Performance trace.
4. Passing result:
   - no user-visible 180-200ms iframe teardown stall during tab switch
   - no repeated active route full-message network response
   - `document.querySelectorAll('iframe')` does not grow with inactive preview
     tabs
5. Click "Run interactive preview" and confirm the file can still run when the
   user explicitly asks for it.

Use a long coding thread:

1. Scroll up and down while idle.
2. Trigger background thread status updates.
3. Complete an active turn.
4. Passing result:
   - no repeated full transcript reloads
   - unchanged message bubbles do not commit
   - mounted DOM count scales with virtual window, not total message count
   - no long tasks above 50ms during ordinary scroll

## Recommended PR Slicing

PR 1: Revalidation containment and preview safety.

- Phase 1
- Phase 2
- low-risk Phase 5 items if small

PR 2: Transcript virtualization.

- Phase 3
- enough message identity cleanup to keep virtualization stable

PR 3: Versioned/bounded history.

- Phase 4
- older-message pagination

PR 4: Context and notebook cleanup.

- Phase 6
- Phase 7

This order gives the fastest production relief while keeping each patch
reviewable.
