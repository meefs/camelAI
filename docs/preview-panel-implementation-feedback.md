# Preview Panel Tabs & Toolbar — Implementation Feedback

## Bug: Computer tab crashes on "Open in new tab"

**Symptom:** Clicking the "Open in new tab" toolbar button for a file preview opens `/computer/{workspaceId}?file={encodedPath}` and throws:

```
TypeError: Cannot read properties of undefined (reading 'length')
    at hashString (computer-page-content.tsx:154)
```

**Current status:** `hashString` is already null-safe in current code. The stack trace line number (`computer-page-content.tsx:154`) appears to be from an older bundle/sourcemap.

Current implementation:

```ts
function hashString(value: string | null | undefined): string {
  const input = typeof value === 'string' ? value : '';
  ...
}
```

**Likely cause:** stale frontend build in browser cache / dev HMR state.

**Required verification before deeper code changes:**
1. Restart dev server.
2. Hard refresh browser (or clear site data).
3. Reproduce and capture a fresh stack trace.

**Hardening improvement (separate from stale-build issue):**
The `?file=` deep-link flow currently gates on `hydrated`, not on root listing completion. Add a `rootLoaded` flag that flips after the initial `loadDirectory(ROOT_PATH)` resolves, then gate deep-link open logic on `hydrated && rootLoaded`.

**Additional hardening (recommended):**
`openFile` does pre-read size checks using `nodesByPath[path]?.size`, which can be missing when tree state is still warming. Add a post-read size check using `data.size` from the `/fs/read` payload before model creation. That makes large-file behavior deterministic even when tree metadata is incomplete.

Suggested placement inside `openFile` after `const data = toWorkspaceFileRead(...)`:

```ts
const effectiveSize = typeof data.size === 'number' ? data.size : null;
if (effectiveSize && effectiveSize > MAX_EDITABLE_BYTES && !options.force) {
  updateTab(normalizedPath, (tab) => ({
    ...tab,
    isTooLarge: true,
  }));
  return;
}
```


## Fix: Remove container wrapping from text file previews

**File:** `src/components/chat-file-preview/file-preview-content.tsx` lines 246–272

**Problem:** Text file previews are wrapped in a `<pre>` with `rounded-md border bg-muted/30 p-3` styling that creates an inset card appearance. This is inconsistent with app previews (which fill the panel edge-to-edge via an `<iframe>`) and notebook previews (which also fill the panel).

**Current code (lines 256–264):**
```tsx
<pre
  className={cn(
    'w-full min-w-0 overflow-auto rounded-md border bg-muted/30 p-3 text-xs',
    layout === 'panel' ? 'h-full max-h-full' : 'max-h-[60vh]',
    textPreview ? 'text-foreground' : 'text-muted-foreground'
  )}
>
  {textPreview || 'No preview content available.'}
</pre>
```

**Required change:** When `layout === 'panel'`, strip the decorative container styles so text fills the panel. Keep the styling for `layout === 'dialog'` (the click-to-preview modal in chat messages).

```tsx
<pre
  className={cn(
    'w-full min-w-0 overflow-auto text-xs',
    layout === 'panel'
      ? 'h-full max-h-full'
      : 'max-h-[60vh] rounded-md border bg-muted/30 p-3',
    textPreview ? 'text-foreground' : 'text-muted-foreground'
  )}
>
```

This removes `rounded-md`, `border`, and `bg-muted/30` in panel mode and avoids duplicate padding when the outer Chat container already applies `p-3`.

**Also in Chat.tsx line 2833:** There's an extra `p-3` wrapper around `FilePreviewContent` for non-notebook files:

```tsx
<div className={cn('h-full', !isNotebookPreview && 'p-3')}>
  <FilePreviewContent ... />
</div>
```

Once the `<pre>` container styling is removed, this outer `p-3` creates *double* padding for text files (the `<pre>` still has its own `p-3`).

**Recommended implementation (lower regression risk):**
- Keep the outer wrapper as-is for now.
- Remove `p-3` from the text `<pre>` **only in panel mode** so text gets exactly one padding layer (from the outer wrapper).

Use:

```tsx
<pre
  className={cn(
    'w-full min-w-0 overflow-auto text-xs',
    layout === 'panel'
      ? 'h-full max-h-full'
      : 'max-h-[60vh] rounded-md border bg-muted/30 p-3',
    textPreview ? 'text-foreground' : 'text-muted-foreground'
  )}
>
```

If you decide to remove the outer `p-3` wrapper instead, run a regression pass for non-text previews (image/pdf/video/audio) because their edge spacing currently depends on shared container layout.


## Additional code review notes

### 1. `openTabForTarget` doesn't sync to server

`openTabForTarget` (line 970) calls `setActiveTabId(id)` but does **not** call `syncPreviewTargetBestEffort(target)`. The sync only happens in `selectTab` and `closeTab`. This means when a new real-time `preview_state` event opens a tab via `openTabForTarget` in `handleRealtimeSideChannelEvent` (line 1055), the server already knows the target (it just sent it), so this is fine. But `openTabForTarget` is also called in `setPreviewTargetForThread` (line 2599), which is the WS init replay path — also fine since the server already has that state.

So the current behavior is correct, but the coupling is implicit. Consider adding a comment on `openTabForTarget` noting that callers are responsible for server sync when needed, or that it intentionally doesn't sync because it's only called from paths where the server already knows.

### 2. `setAppIsPublic` captures `activeTabId` closure

`setAppIsPublic` (line 814) closes over `activeTabId`:

```ts
const setAppIsPublic = useCallback((isPublic: boolean) => {
  if (!activeTabId) return;
  setPreviewTabs((prev) => (
    prev.map((tab) => {
      if (tab.id !== activeTabId || tab.target.kind !== 'app') return tab;
      ...
    })
  ));
}, [activeTabId]);
```

This is correct since `activeTabId` is in the dependency array, but `setAppIsPublic` is passed to `ShareStatusButton` as a callback. Each time `activeTabId` changes, `setAppIsPublic` gets a new identity, which triggers a re-render of `ShareStatusButton`. This is minor but could cause unnecessary renders if the share button has expensive children. If it becomes an issue, use `activeTabIdRef` instead.

### 3. Stale `previewTabsRef` in `closeTab`

`closeTab` (line 990) reads `previewTabsRef.current` at the top:

```ts
const closeTab = useCallback((tabId: string) => {
  const prevTabs = previewTabsRef.current;
  ...
  setPreviewTabs(nextTabs);
```

This is safe because `previewTabsRef` is synced in a `useEffect` (line 757–759). But there's a subtle edge: if `closeTab` fires in the same render where `setPreviewTabs` was just called (before the ref sync effect runs), `previewTabsRef.current` would be stale. Use `setPreviewTabs((prev) => ...)` functional form to avoid this:

```ts
const closeTab = useCallback((tabId: string) => {
  setPreviewTabs((prev) => {
    const nextTabs = prev.filter((tab) => tab.id !== tabId);
    // ... compute nextActiveTab inside the updater
    return nextTabs;
  });
}, [...]);
```

This is a low-probability race but worth fixing for correctness.

### 4. `filePreviewKey` included in `filePreviewUrl` memo

At line 2745:
```ts
return `/api/workspaces/${previewTarget.workspaceId}/${route}?v=${filePreviewKey}`;
```

This appends `filePreviewKey` as a cache-busting query param on the preview URL. When `bumpFilePreviewKey` increments the key, the URL changes, which triggers a re-fetch inside `FilePreviewContent`'s `useEffect` (since `previewUrl` is a dependency). This is the intended mechanism for refresh. Just noting that it works correctly.

### 5. Missing `key` on `FilePreviewContent` (non-issue)

The content area has `key={activeTabId}` on the outer div (line 2814), which already forces a full remount on tab switch. This means `FilePreviewContent` automatically gets fresh state per tab. Good.

### 6. Preview toolbar `getDownloadFormats` — missing some file types

`getDownloadFormats` in `preview-toolbar.tsx` (line 137) handles `ipynb`, `md`, `csv`, `tsv`, `svg` and falls through to a generic "Download" label. Consider adding entries for:
- `json` / `jsonl` — "Download JSON"
- `xlsx` / `xls` — "Download spreadsheet"
- `pdf` — "Download PDF"

These are common file types in the preview panel. Low priority.

### 7. Tab close button on single-tab header

In `preview-tabs.tsx` line 32–41, the single-tab view shows a close `X` button. This is correct per the spec. Just confirming it works as expected — closing the only tab should hide the entire preview panel.

---

## Feature: Rendered markdown preview with toggle

Add a rendered markdown view for `.md` files in the preview panel, with a "Rendered / Source" toggle — mirroring how notebooks have "Report / Notebook".

### Existing infrastructure to reuse

- **`MarkdownRenderer`** (`src/components/markdown-renderer.tsx`) — the codebase already has a full-featured markdown renderer using `react-markdown` + `remark-gfm` + Shiki syntax highlighting. It supports headings, tables, code blocks with copy buttons, links, images, blockquotes, lists, dark/light themes. Import and use directly.
- **`markdown-content` CSS class** (`src/styles/globals.css` lines 206–271) — base styling for rendered markdown already exists.
- **Notebook toggle pattern** — the toolbar already has `NotebookToolbarActions` using shadcn `Tabs` with `variant="outline"`. Replicate this pattern exactly.

### Implementation steps

#### 1. Add `'markdown'` to `PreviewType` in `file-type-utils.ts`

**File:** `src/components/chat-file-preview/file-type-utils.ts`

Currently `getPreviewType()` (line 92) collapses `.md` files to `'text'` because `md` is in `CODE_EXTENSIONS` which maps to `'text'`. Add a `'markdown'` case to `PreviewType` and return it before the text fallback:

```ts
export type PreviewType = 'image' | 'pdf' | 'notebook' | 'markdown' | 'text' | 'audio' | 'video' | 'other';

export function getPreviewType(filename: string, contentType?: string): PreviewType {
  const category = getFileCategory(filename, contentType);
  if (category === 'image') return 'image';
  if (category === 'pdf') return 'pdf';
  if (category === 'notebook') return 'notebook';
  if (category === 'audio') return 'audio';
  if (category === 'video') return 'video';
  // Check for markdown before collapsing to 'text'
  if (getFileExtension(filename) === 'md') return 'markdown';
  if (category === 'code' || category === 'text' || category === 'spreadsheet') return 'text';
  return 'other';
}
```

#### 2. Add per-tab markdown view mode state in `Chat.tsx`

**File:** `src/components/Chat.tsx`

Reuse the same per-tab state pattern as notebook view modes. Add alongside the existing `tabNotebookViewModes`:

```ts
const [tabMarkdownViewModes, setTabMarkdownViewModes] = useState<Record<string, 'rendered' | 'source'>>({});
```

Derive the active value:
```ts
const markdownViewMode = activeTabId ? (tabMarkdownViewModes[activeTabId] ?? 'rendered') : 'rendered';
```

Add a setter callback (same pattern as `setActiveNotebookViewMode`):
```ts
const setActiveMarkdownViewMode = useCallback((mode: 'rendered' | 'source') => {
  if (!activeTabId) return;
  setTabMarkdownViewModes((prev) => ({ ...prev, [activeTabId]: mode }));
}, [activeTabId]);
```

Clean up `tabMarkdownViewModes` in the same places as `tabNotebookViewModes`:
- Thread change reset effect (alongside `setTabNotebookViewModes({})`)
- `closeTab` per-tab cleanup (alongside the other `{ [tabId]: _, ...rest }` destructures)
- `clearPreviewTarget` / no-threadId effect

#### 3. Add `MarkdownToolbarActions` in `preview-toolbar.tsx`

**File:** `src/components/preview-panel/preview-toolbar.tsx`

Add new props to `PreviewToolbarProps`:
```ts
markdownViewMode?: 'rendered' | 'source';
onMarkdownViewModeChange?: (mode: 'rendered' | 'source') => void;
```

Create `MarkdownToolbarActions` — identical structure to `NotebookToolbarActions` but with "Rendered / Source" labels:

```tsx
function MarkdownToolbarActions({
  markdownViewMode,
  onMarkdownViewModeChange,
  activeTarget,
  filePreviewOpenUrl,
}: Pick<
  PreviewToolbarProps,
  'markdownViewMode' | 'onMarkdownViewModeChange' | 'activeTarget' | 'filePreviewOpenUrl'
>) {
  return (
    <>
      <Tabs
        value={markdownViewMode ?? 'rendered'}
        onValueChange={(value) => {
          if (value === 'rendered' || value === 'source') {
            onMarkdownViewModeChange?.(value);
          }
        }}
        className="shrink-0 gap-0"
      >
        <TabsList variant="outline" className="h-7">
          <TabsTrigger value="rendered" className="h-6 px-3 text-xs">
            Rendered
          </TabsTrigger>
          <TabsTrigger value="source" className="h-6 px-3 text-xs">
            Source
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <Separator orientation="vertical" className="mx-1 h-4 data-[orientation=vertical]:self-auto" />
      <DownloadButton activeTarget={activeTarget} filePreviewOpenUrl={filePreviewOpenUrl} />
    </>
  );
}
```

Add `'markdown'` to the conditional chain in `PreviewToolbar`'s body (between `notebook` and the default):

```tsx
{fileType === 'app' ? (
  <AppToolbarActions ... />
) : fileType === 'notebook' ? (
  <NotebookToolbarActions ... />
) : fileType === 'markdown' ? (
  <MarkdownToolbarActions
    markdownViewMode={markdownViewMode}
    onMarkdownViewModeChange={onMarkdownViewModeChange}
    activeTarget={activeTarget}
    filePreviewOpenUrl={filePreviewOpenUrl}
  />
) : (
  <DownloadButton ... />
)}
```

#### 4. Pass markdown props through Chat.tsx

**File:** `src/components/Chat.tsx`

Compute `isMarkdownPreview` alongside the existing `isNotebookPreview`:

```ts
const isMarkdownPreview =
  previewTarget?.kind === 'file' &&
  previewFileName.toLowerCase().endsWith('.md');
```

Pass to `PreviewToolbar`:
```tsx
<PreviewToolbar
  ...
  markdownViewMode={isMarkdownPreview ? markdownViewMode : undefined}
  onMarkdownViewModeChange={setActiveMarkdownViewMode}
/>
```

Pass to `FilePreviewContent`:
```tsx
<FilePreviewContent
  ...
  markdownViewMode={isMarkdownPreview ? markdownViewMode : undefined}
/>
```

#### 5. Add markdown rendering branch in `FilePreviewContent`

**File:** `src/components/chat-file-preview/file-preview-content.tsx`

Add `markdownViewMode` to the props interface:
```ts
export interface FilePreviewContentProps {
  filename: string;
  previewUrl: string;
  contentType?: string;
  layout?: PreviewLayout;
  notebookViewMode?: 'report' | 'notebook';
  markdownViewMode?: 'rendered' | 'source';
}
```

The markdown fetch shares the same text-fetch path (`previewType === 'text'` or `'markdown'`). Update the `shouldFetchText` check in the `useEffect` (line 108):

```ts
const shouldFetchText = previewType === 'text' || previewType === 'notebook' || previewType === 'markdown';
```

Add a rendering branch for `previewType === 'markdown'` before the `previewType === 'text'` block (around line 246):

```tsx
{previewType === 'markdown' && (
  <div className={cn(layout === 'panel' && 'h-full overflow-auto')}>
    {(textStatus === 'loading' || textStatus === 'idle') && (
      <p className="text-sm text-muted-foreground">Loading preview...</p>
    )}
    {textStatus === 'error' && (
      <p className="text-sm text-muted-foreground">Unable to preview this file.</p>
    )}
    {textStatus === 'ready' && (
      (markdownViewMode ?? 'rendered') === 'rendered' ? (
        <div className={cn(
          layout === 'panel'
            ? 'h-full overflow-auto'
            : 'max-h-[60vh] overflow-auto p-6'
        )}>
          <MarkdownRenderer content={textPreview} />
        </div>
      ) : (
        <pre
          className={cn(
            'w-full min-w-0 overflow-auto text-xs whitespace-pre-wrap',
            layout === 'panel'
              ? 'h-full max-h-full'
              : 'max-h-[60vh] rounded-md border bg-muted/30 p-3',
            textPreview ? 'text-foreground' : 'text-muted-foreground'
          )}
        >
          {textPreview || 'No preview content available.'}
        </pre>
      )
    )}
    {lineInfo.truncated && (
      <p className="mt-2 text-xs text-muted-foreground px-3">
        Showing first {MAX_TEXT_LINES} of {lineInfo.totalLines} lines.
      </p>
    )}
  </div>
)}
```

Add the import at the top of the file:
```ts
import { MarkdownRenderer } from '@/components/markdown-renderer';
```

#### 6. Update `areFilePreviewContentPropsEqual` memo comparator

**File:** `src/components/chat-file-preview/file-preview-content.tsx`

The `memo()` comparator (around line 302) needs to include `markdownViewMode`:

```ts
prev.markdownViewMode === next.markdownViewMode
```

### Key design decisions

- **Default to rendered** — `'rendered'` is the default (matches how notebooks default to `'report'`). Users who want the source can toggle.
- **Source view reuses existing `<pre>` rendering** — no new component needed. The "Source" mode is identical to how `.md` files rendered before this change.
- **No separate `MarkdownPreview` component** — unlike notebooks (which have `ReportMode`/`NotebookMode` as separate complex components), markdown rendering is a single `<MarkdownRenderer>` call. Keep it inline in `FilePreviewContent` rather than extracting a new file.
- **Dialog layout** — when `layout === 'dialog'` (click-to-preview in chat), default to rendered markdown. The toggle appears only in the panel toolbar, not in the dialog.
- **Padding ownership** — while `Chat.tsx` still applies outer panel padding for non-notebook files, keep markdown panel branches free of extra `p-*` wrappers to avoid double padding.

### Files to modify

| File | Change |
|------|--------|
| `src/components/chat-file-preview/file-type-utils.ts` | Add `'markdown'` to `PreviewType`, return it from `getPreviewType()` for `.md` |
| `src/components/chat-file-preview/file-preview-content.tsx` | Add `markdownViewMode` prop, add `'markdown'` rendering branch with `MarkdownRenderer`, update fetch condition, update memo comparator |
| `src/components/preview-panel/preview-toolbar.tsx` | Add `markdownViewMode`/`onMarkdownViewModeChange` props, add `MarkdownToolbarActions` component, add `'markdown'` branch in toolbar conditional |
| `src/components/Chat.tsx` | Add `tabMarkdownViewModes` per-tab state, `markdownViewMode` derived value, `setActiveMarkdownViewMode` callback, `isMarkdownPreview` flag; pass props to toolbar and content; clean up in thread reset/closeTab/clearPreview |

### Verification

- Open a `.md` file in the preview panel → should render as formatted markdown by default (headings, code blocks with syntax highlighting, tables, links)
- Toggle to "Source" → should show raw markdown text in a `<pre>`
- Toggle back to "Rendered" → should re-render the formatted view
- Open multiple `.md` tabs → each tab should retain its own toggle state independently
- Open a `.md` file in dialog mode (click preview chip in chat) → should show rendered markdown
- Open a non-`.md` text file → should still show plain `<pre>` text with no toggle (unchanged behavior)
