# Preview Panel Tabs — Performance + Persistence Feedback

## Scope

This document is a technical handoff for two issues in the implemented preview tabs feature:

1. Render stability while chat is active (typing + streaming)
2. Full multi-tab persistence across refresh/reconnect/restart

It intentionally avoids UI redesign decisions and focuses on correctness, architecture, and implementation safety.

---

## Current State Audit

### 1) Tab/header rerenders are not isolated

- `PreviewTabRow` is a plain function component, not memoized (`src/components/preview-panel/preview-tabs.tsx:14`).
- `PreviewToolbar` is a plain function component, not memoized (`src/components/preview-panel/preview-toolbar.tsx:308`).
- `Chat` re-renders frequently due to chat state (`input`, `messages`, streaming, etc.; see state setup in `src/components/Chat.tsx:692` onward).
- The preview header is built inline inside `previewPanelBody` (`src/components/Chat.tsx:2801`), with inline lambdas for `onRefresh` and `onOpenExternal` (`src/components/Chat.tsx:2814`, `src/components/Chat.tsx:2821`), so prop identity changes every parent render.

Result: tab row + toolbar rerender on many unrelated chat updates.

### 2) Some memoization already exists (content path)

- `FilePreviewContent` is memoized with a custom comparator (`src/components/chat-file-preview/file-preview-content.tsx:363`).
- `NotebookPreview` is memoized (`src/components/chat-file-preview/notebook-preview/index.tsx:48`).
- `activeTab` is derived with `useMemo` (`src/components/Chat.tsx:711`).

So the current optimization is mostly in content rendering, not the tab/header shell.

### 3) Multi-tab persistence is frontend-only

- `previewTabs` and `activeTabId` live in local React state (`src/components/Chat.tsx:702`, `src/components/Chat.tsx:706`).
- On thread load/reset, state is rebuilt from `initialPreviewTarget` only (`src/components/Chat.tsx:775`), which is single-target.
- DO persists only one target + version (`workers/main/src/durable-objects.ts:206`, `workers/main/src/durable-objects.ts:587`).
- WebSocket `preview_state` also carries only one target (`workers/main/src/durable-objects.ts:733`, `workers/main/src/durable-objects.ts:898`).
- Chat loader only fetches `previewTarget` (`src/routes/_app.chat.$id.tsx:60` to `src/routes/_app.chat.$id.tsx:63`).

Result: after refresh/revisit/restart, only active tab is recoverable.

---

## Technical Requirements

1. Keep existing UI behavior, but reduce unnecessary rerenders of tab/header controls during streaming/typing.
2. Persist full tab session per thread (open tabs + active tab), not just active target.
3. Preserve backward compatibility with existing single-target DO state and existing clients.
4. If a persisted file no longer exists, keep the tab and show an in-panel error state (do not silently drop the tab).

---

## Implementation Plan

## A) Render Stability (Frontend)

### A1. Memoize tab/header components

- Wrap `PreviewTabRow` in `React.memo` (or export memoized component) in `src/components/preview-panel/preview-tabs.tsx`.
- Wrap `PreviewToolbar` in `React.memo` in `src/components/preview-panel/preview-toolbar.tsx`.

### A2. Stabilize props passed from `Chat`

- Replace inline toolbar callbacks with `useCallback` in `src/components/Chat.tsx`:
  - `handlePreviewRefresh`
  - `handlePreviewOpenExternal`
  - `handlePreviewBugReportOpen`
- Memoize computed toolbar prop objects (where useful) with `useMemo`.
- Keep dependencies minimal and explicit.

### A3. Isolate preview shell from chat churn

- Extract a memoized child component for the preview panel header/content shell (tabs + toolbar + active pane) so `Chat` state updates unrelated to preview do not always propagate.
- Pass only preview-related props to that child.

Notes:
- This is higher impact than adding `useMemo` around JSX nodes and gives clearer rerender boundaries.
- `useMemo` can still be used for derived values, but component memoization should be the primary lever.

---

## B) Full Multi-Tab Persistence (DO + Loader + WS + Client)

### B1. Add durable preview session state in `ChatThreadDO`

In `workers/main/src/durable-objects.ts`, introduce persisted state for:

- `previewTabs: PreviewTarget[]`
- `previewActiveTabId: string | null`
- existing `previewTarget` remains for compatibility/legacy callers
- existing `previewVersion` remains, but increments on any tab-state mutation

Suggested storage keys:

- `previewTabs`
- `previewActiveTabId`
- `previewTarget` (existing)
- `previewVersion` (existing)

### B2. Add migration/compat restore logic

On DO startup:

1. Load `previewTabs` + `previewActiveTabId` if present.
2. If absent but `previewTarget` exists, migrate to:
   - tabs = `[previewTarget]`
   - activeTabId = `getPreviewTabId(previewTarget)`
3. Keep all values normalized via the existing preview target normalization rules.

### B3. Extend protocol without breaking old clients

Keep existing messages:

- client -> server: `set_preview_target`
- server -> client: `preview_state` with `target` + `version`

Add optional fields to `preview_state`:

- `tabs?: PreviewTarget[]`
- `activeTabId?: string | null`

Add a new client message for authoritative tab session sync:

- `set_preview_tabs_state` with `{ tabs: PreviewTarget[]; activeTabId: string | null }`

Backward compatibility:

- New clients can consume old `preview_state` (target-only).
- Old clients ignore extra `preview_state` fields.

### B4. Update DO mutation behavior

In `ChatThreadDO`:

- `set_preview_target(target)` semantics:
  - `target === null`: clear tabs + active + target
  - otherwise: upsert target tab and set active tab to it
- `set_preview_tabs_state` semantics:
  - normalize + validate each target
  - reject invalid workspace for file tabs (same guard as current target validation)
  - dedupe by preview tab ID
  - set active tab only if present in tabs, else fallback (first tab or null)
  - derive/update legacy `previewTarget` from active tab
  - persist + bump `previewVersion` + broadcast

### B5. Thread loader: fetch full preview tab session

In `src/lib/chat-do.server.ts`:

- Add `getThreadPreviewState(context, threadId)` returning:
  - `tabs`
  - `activeTabId`
  - `target` (legacy active)
  - `version` (optional)

In `src/routes/_app.chat.$id.tsx`:

- Replace single `previewTarget` loader fetch with full preview state fetch.
- Pass `initialPreviewTabs` + `initialActiveTabId` + `initialPreviewTarget` to `Chat`.
- For compatibility, if no tab state exists, derive from legacy `previewTarget`.

### B6. Client state initialization + reconciliation

In `src/components/Chat.tsx`:

- Initialize `previewTabs` / `activeTabId` from new loader props.
- Remove reset logic that force-replaces local tabs with a single `initialPreviewTarget` on each thread load (`src/components/Chat.tsx:775` behavior should be replaced with full-state init).
- On receiving `preview_state`:
  - if `tabs` payload exists: reconcile/replace local tab session from server payload
  - else fallback to current single-target behavior

### B7. Sync local tab mutations to DO

After local tab operations (`openTabForTarget`, `selectTab`, `closeTab`, clear):

- send `set_preview_tabs_state` (authoritative tabs + activeTabId) when WS is open
- keep optimistic local updates for responsiveness
- maintain existing `set_preview_target` path only as fallback compatibility if needed

This closes the current gap where closing/selecting tabs is not fully represented server-side.

---

## Missing File/Error-State Requirements

When persisted tabs are restored and a file path no longer exists:

1. Keep the tab visible in the tab row.
2. Show an explicit preview error in-panel (e.g. file missing/unavailable).
3. Do not auto-close tab.
4. Allow user to close manually.

Implementation note:

- `FilePreviewContent` already has error states; extend fetch error handling to detect `404/410` and render a specific “file no longer exists” message in panel mode.
- This satisfies workstation continuity while handling stale paths safely.

---

## Acceptance Criteria

1. Typing in the message composer does not rerender tab row/toolbar unless preview-related props changed.
2. Streaming assistant output does not rerender tab row/toolbar unless preview-related props changed.
3. Open 3+ tabs, refresh page: same tabs and active tab are restored.
4. Navigate away and back to same thread: same tabs and active tab are restored.
5. Restart worker/dev server and reopen thread: same tabs and active tab are restored from DO storage.
6. Delete a file that is still in persisted tabs, then reopen thread: tab remains and panel shows missing-file error state.
7. Legacy behavior still works for threads with only old `previewTarget` persisted.

---

## Test Plan (Minimum)

1. DO unit tests (`workers/main/src/durable-objects.ts`)
   - migration from legacy `previewTarget` to tab session
   - `set_preview_tabs_state` validation, dedupe, active fallback
   - broadcast payload includes tabs + active + target
2. Chat integration tests
   - loader hydration with multi-tab state
   - websocket init `preview_state` reconciliation
   - close/select/open operations persist and survive reload
3. UI render/perf smoke
   - verify tab/header rerender count is stable during typing/streaming

