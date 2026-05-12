# Preview Toolbar Standardization

## Problem

The action row above the preview pane has grown organically. Three problems:

1. **Button positions are not consistent across file types.** "Open in new tab" lives 2nd-from-left for apps and 2nd-from-right for files. Refresh is always first, but everything else is in motion. Users have to re-find buttons every time they switch what's in the active tab.
2. **"Open in new tab" is doing three different jobs under one icon.** Same `ExternalLink` icon and `"Open in new tab"` tooltip, but it actually navigates to *three* different destinations depending on the active target. (Detailed below.)
3. **The Rendered/Source toggle has inconsistent labels.** Notebooks say `Report`/`Notebook`; markdown says `Rendered`/`Source`. Same control, different vocabulary, different widths.

This plan **(a)** redefines the action row as a fixed three-zone grid that every file type fills the same way, **(b)** splits the overloaded "Open in new tab" button into two semantically distinct buttons with distinct icons, and **(c)** restyles the Rendered/Source toggle into a shared icon-only pill with tooltips.

---

## Current State Audit

### What every button actually does

Source: [src/components/preview-panel/preview-toolbar.tsx](src/components/preview-panel/preview-toolbar.tsx) (rendering) + [src/components/Chat.tsx:5946-5964](src/components/Chat.tsx#L5946-L5964) (handlers) + [src/components/Chat.tsx:5930-5944](src/components/Chat.tsx#L5930-L5944) (URL derivation).

| Button | Icon | What it does today |
|---|---|---|
| **Refresh** | `RefreshCw` | App: bumps iframe key → forces iframe reload. File: bumps `tabFilePreviewKeys` → refetches preview data. |
| **URL chip** (app) | `Globe` | Click → copies the full vanity URL (`https://...`) to clipboard. 1.5s green flash. Tooltip says `Live app link`. |
| **File chip** (file) | `FileText` | Click → copies the absolute file path (not URL) to clipboard. 1.5s green flash. Tooltip says `Copy file path`. |
| **Share status** (app) | varies | Existing `ShareStatusButton` dropdown. Public/Private/etc. App-only. |
| **Bug** (app) | `Bug` | Opens bug report modal. Admin-only (controlled by `readOnly`). |
| **Open in new tab** (app) | `ExternalLink` | `window.open(appPreviewVanityUrl, "_blank")` → **opens the live deployed app in a browser tab**. |
| **Open in new tab** (workspace file) | `ExternalLink` | `window.open("/computer/{wsId}?file={path}", "_blank")` → **opens the Computer tab focused on this file**, inside camelAI. |
| **Open in new tab** (upload file) | `ExternalLink` | `window.open("/api/workspaces/{wsId}/uploads/{path}", "_blank")` → opens the raw uploaded file URL. **Effectively dead behavior** — uploads and outputs are not viewable in the Computer tab, and the raw URL is not a meaningful "view" destination. Plan removes this. |
| **Open in new tab** (output file) | `ExternalLink` | `window.open("/api/workspaces/{wsId}/outputs/{path}", "_blank")` → opens the raw output file URL. **Same as upload — dead behavior, plan removes this.** |
| **Download** | `Download` | Triggers a file download via temporary `<a download>`. Single-format direct for most types; dropdown for `.ipynb` (`.ipynb` direct + `Report as PDF` action). |
| **Report/Notebook toggle** (.ipynb) | text | Segmented control switching `FilePreviewContent` between rendered report and raw notebook view. Per-tab state in `tabNotebookViewModes`. |
| **Rendered/Source toggle** (.md) | text | Segmented control switching `FilePreviewContent` between rendered markdown and source. Per-tab state in `tabMarkdownViewModes`. |

### Where each button sits today

**App** ([preview-toolbar.tsx:400-423](src/components/preview-panel/preview-toolbar.tsx#L400-L423)):
```
[Refresh] │ [Open in new tab] [URL chip] [Share] │ [Bug]
```

**Notebook (.ipynb)** ([preview-toolbar.tsx:510-538](src/components/preview-panel/preview-toolbar.tsx#L510-L538)):
```
[Refresh] │ [File chip] │ [Report/Notebook] ──spacer── [Open in new tab] [Download ▾]
```

**Markdown (.md)**:
```
[Refresh] │ [File chip] │ [Rendered/Source] ──spacer── [Open in new tab] [Download]
```

**All other files** (.txt, .csv/.tsv, .json/.jsonl, .py/.js/.ts, .svg, .png/.jpg, .pdf, fallback):
```
[Refresh] │ [File chip] ──spacer── [Open in new tab] [Download]
```

### Inconsistencies, named

- **"Open in new tab" position drifts.** Slot 2 for apps, slot N-1 for files.
- **"Open in new tab" is overloaded.** One icon, four destinations (live URL, Computer tab, raw upload, raw output). A user clicking the button on an app and again on a file has no visual signal that the second click is a fundamentally different action.
- **Two of those four destinations don't really work.** Upload-source and output-source files open a raw `/api/.../uploads/...` or `/api/.../outputs/...` URL in a new browser tab. There is no Computer-tab view for these files, and the raw URL isn't a useful "view" — it's a download surrogate at best (and may fail outright on content-type/auth quirks). This plan **removes the button entirely for those sources**; users still have Download.
- **Refresh is the only button users can reliably find** — it's always first. Everything else moves.

---

## Standardization

### The three-zone grid

Every action row, regardless of file type, becomes the same three-zone layout. Buttons may be absent from a zone for a given file type, but **no button ever changes zones**.

```
┌───────────────────────────────────────────────────────────────────────────────┐
│  LEFT (view)          CENTER (identity)              RIGHT (act on this)      │
│  ┌─────────────┐      ┌───────────────────┐          ┌──────────────────────┐ │
│  │ Refresh     │      │ Identity chip     │          │ Type-specific        │ │
│  │ View toggle │      │ (URL or path,     │          │ action buttons       │ │
│  │             │      │  click-to-copy)   │          │  …                   │ │
│  │             │      │                   │          │ Download             │ │
│  │             │      │                   │          │ Open elsewhere       │ │
│  └─────────────┘      └───────────────────┘          └──────────────────────┘ │
└───────────────────────────────────────────────────────────────────────────────┘
```

**Rules:**

1. **LEFT zone** holds *view controls* — things that change how the current content is rendered, without leaving it. Refresh is always present and always first. View toggle (Preview/Source) is present when the file type supports it.
2. **CENTER zone** holds the *identity chip* — the URL chip for apps, the file path chip for files. Always present. Always click-to-copy. Acts as a visual anchor between the two action zones.
3. **RIGHT zone** holds *outbound actions* — things that act on this preview (open-elsewhere, share, report a bug, download). **Open-elsewhere is always the first button in this zone, immediately adjacent to the center identity chip.** That keeps it visually paired with the URL/path it acts on (so the URL still reads "live" for apps) while making its position fully predictable across file types. Other right-zone actions follow it in a type-specific order.
4. Zone separators are vertical `Separator`s.
5. The center zone uses `flex-1` so it expands and the action zones stay pinned.

### Splitting "Open in new tab" into two distinct actions

The current single button is doing two-and-a-half semantically different things. Cut the dead behaviors and standardize the rest as two distinct buttons with distinct icons. Only one ever shows at a time (they're mutually exclusive by file type), and neither shows at all for upload- or output-source files.

| New button | Icon | Tooltip | Shows for | Behavior |
|---|---|---|---|---|
| **Open live app** | `ExternalLink` (↗ box) | `Open live app` | App previews | `window.open(vanityUrl, "_blank")` |
| **Open in Computer** | `PanelsTopLeft` | `Open in Computer` | Workspace-source files only | `window.open("/computer/{id}?file=...", "_blank")` |
| *(none)* | — | — | Upload-source and output-source files | Button does not render. Download is the only meaningful "take this elsewhere" action for these. |

> **Rationale for two icons, not one.** `ExternalLink` means "you'll see actual content on the live internet"; the Computer icon means "you'll land back in this app, in the Computer view." That distinction matters because the resulting tab takes the user to fundamentally different places.

The underlying handler ([Chat.tsx:5955-5964](src/components/Chat.tsx#L5955-L5964)) branches on target kind and file source today. It needs to:

1. Stop opening raw `/api/.../uploads/...` and `/api/.../outputs/...` URLs.
2. Surface a `kind` to the toolbar so it can pick the right icon + tooltip — or signal "no button" when appropriate.

Pass it as a new prop: `openElsewhereKind: 'app' | 'computer' | null`. When `null`, the toolbar omits the button.

---

## Standardized Layouts (per file type)

Reading left → right. `│` = vertical separator. `──` = flex spacer. Open-elsewhere is always the first button after the identity chip.

### App

```
[↻ Refresh] │ [🌐 vanityHost.camelai.app (click=copy)] ── [↗ Open live app] [Share status] [🐞 Bug*]
```
- `*` Bug only renders for admins (`onBugReport` provided).
- **Change vs today:** Open-elsewhere moves from *before* the URL chip to *immediately after* it. URL chip is now the center anchor. Share and Bug both sit in the right zone after the open button.

### Notebook (.ipynb) — workspace source

```
[↻ Refresh] [📓⇄<> Preview/Source toggle] │ [📄 analysis.ipynb (click=copy)] ── [⊞ Open in Computer] [⬇ Download ▾]
```
- **Change vs today:** View toggle moves left of the separator (joins Refresh in the view-controls zone). Open-elsewhere moves from before Download to be the first right-zone button (adjacent to the file chip), becomes "Open in Computer."

### Markdown (.md) — workspace source

```
[↻ Refresh] [📄⇄<> Preview/Source toggle] │ [📄 README.md (click=copy)] ── [⊞ Open in Computer] [⬇ Download]
```
- **Change vs today:** Same as notebook — view toggle joins Refresh; open-elsewhere becomes first in the right zone.

### Plain text (.txt), JSON/JSONL, CSV/TSV/XLSX/XLS, code (.py/.js/.ts/…), SVG, raster image, PDF, fallback — workspace source

```
[↻ Refresh] │ [📄 filename.ext (click=copy)] ── [⊞ Open in Computer] [⬇ Download]
```

### Any file — upload source or output source

```
[↻ Refresh] │ [📄 filename.ext (click=copy)] ── [⬇ Download]
```
- **No Open-elsewhere button at all.** Uploaded and agent-output files are not viewable in the Computer tab, and the prior behavior of opening the raw `/api/.../uploads/...` URL is removed.
- Notebooks and markdown from upload/output sources still get the Preview/Source toggle in the left zone (rendering capability is independent of source).

### What this changes vs today, in one paragraph

The view toggle moves from the middle of the toolbar into the left view-controls zone next to Refresh. The identity chip becomes the central anchor every time. Open-elsewhere always sits as the first button after the identity chip — that keeps it visually paired with the URL/path it acts on for apps, and standardizes its position across all file types. Open-elsewhere splits into `Open live app` (for apps) and `Open in Computer` (for workspace-source files) with distinct icons; it is removed entirely for upload-source and output-source files because no useful destination exists. Share moves into the right zone (after Open-elsewhere) for apps. Refresh and Download positions are unchanged.

---

## Implementation

### Step 1 — Open-elsewhere split + dead-behavior removal

**File:** [src/components/preview-panel/preview-toolbar.tsx](src/components/preview-panel/preview-toolbar.tsx)

Extend `PreviewToolbarProps` with a nullable discriminator. `null` means "do not render the button":

```ts
type OpenElsewhereKind = 'app' | 'computer';

interface PreviewToolbarProps {
  // … existing
  openElsewhereKind: OpenElsewhereKind | null;
  onOpenElsewhere: () => void;          // renamed from onOpenExternal for clarity
  // …
}
```

Internal helper:

```tsx
function OpenElsewhereButton({
  kind,
  onClick,
}: {
  kind: OpenElsewhereKind | null;
  onClick: () => void;
}) {
  if (kind === null) return null;
  const { icon, tooltip } = {
    app:      { icon: ExternalLink,  tooltip: 'Open live app' },
    computer: { icon: PanelsTopLeft, tooltip: 'Open in Computer' },
  }[kind];
  return <ToolbarButton icon={icon} tooltip={tooltip} onClick={onClick} />;
}
```

**File:** [src/components/Chat.tsx](src/components/Chat.tsx)

1. Update `fileExternalOpenUrl` ([Chat.tsx:5930-5944](src/components/Chat.tsx#L5930-L5944)) to return `""` for upload-source and output-source files. The block that builds `/api/.../uploads/...` and `/api/.../outputs/...` URLs goes away:

   ```ts
   const fileExternalOpenUrl = useMemo(() => {
     if (previewTarget?.kind !== "file") return "";
     if (previewTarget.source !== "workspace") return "";
     const query = new URLSearchParams();
     query.set("file", previewTarget.path);
     if (readOnly) query.set("adminReadonly", "1");
     return `/computer/${previewTarget.workspaceId}?${query.toString()}`;
   }, [previewTarget, readOnly]);
   ```

2. `handlePreviewOpenExternal` ([Chat.tsx:5955-5964](src/components/Chat.tsx#L5955-L5964)) is unchanged in shape; it just becomes a no-op when `fileExternalOpenUrl === ""`, which already matches its guard. Optional cleanup: tighten it to assert `previewTarget.kind === "app" || previewTarget.source === "workspace"`.

3. Derive and pass the discriminator:

   ```ts
   const openElsewhereKind: OpenElsewhereKind | null =
     previewTarget?.kind === 'app'
       ? 'app'
       : previewTarget?.kind === 'file' && previewTarget.source === 'workspace'
         ? 'computer'
         : null;
   ```

   …down into `<PreviewToolbar />` along with `onOpenElsewhere={handlePreviewOpenExternal}`.

### Step 2 — Three-zone layout in `PreviewToolbarComponent`

**File:** [src/components/preview-panel/preview-toolbar.tsx:540-592](src/components/preview-panel/preview-toolbar.tsx#L540-L592)

Replace the current single-row flex with three explicit zones. Open-elsewhere is the **first** child in the right zone so it sits immediately after the identity chip:

```tsx
<div className="flex items-center gap-1 border-b border-border px-3 py-1.5">
  {/* LEFT — view controls */}
  <ToolbarButton icon={RefreshCw} tooltip="Refresh" onClick={onRefresh} />
  {fileType === 'notebook' && (
    <PreviewSourceToggle
      target={activeTarget}
      value={notebookViewMode === 'notebook' ? 'source' : 'preview'}
      onChange={(m) => onNotebookViewModeChange?.(m === 'source' ? 'notebook' : 'report')}
    />
  )}
  {fileType === 'markdown' && (
    <PreviewSourceToggle
      target={activeTarget}
      value={markdownViewMode === 'source' ? 'source' : 'preview'}
      onChange={(m) => onMarkdownViewModeChange?.(m === 'source' ? 'source' : 'rendered')}
    />
  )}

  <Separator orientation="vertical" className="mx-1 h-4 data-[orientation=vertical]:self-auto" />

  {/* CENTER — identity (flex-expanding anchor) */}
  <div className="flex min-w-0 flex-1 items-center">
    {activeTarget.kind === 'app' ? (
      <ClickToCopyUrlBar url={vanityUrl ?? ''} displayHost={vanityHost ?? ''} />
    ) : (
      <ClickToCopyFileChip target={activeTarget} />
    )}
  </div>

  {/* RIGHT — outbound actions. Open-elsewhere always first. */}
  <OpenElsewhereButton kind={openElsewhereKind} onClick={onOpenElsewhere} />
  {activeTarget.kind === 'app' && appShareButton}
  {activeTarget.kind === 'app' && onBugReport ? (
    <ToolbarButton icon={Bug} tooltip="Report a bug" onClick={onBugReport} />
  ) : null}
  {activeTarget.kind === 'file' && (
    <DownloadButton
      activeTarget={activeTarget}
      filePreviewOpenUrl={filePreviewOpenUrl}
      notebookState={notebookState}
      isNotebookPdfExporting={isNotebookPdfExporting}
      onNotebookReportPdfDownload={onNotebookReportPdfDownload}
    />
  )}
</div>
```

This deletes the inner `AppToolbarActions` / `FileToolbarActions` / `NotebookToolbarActions` / `MarkdownToolbarActions` sub-components — they're no longer needed once the layout is unified. Keep `ClickToCopyUrlBar`, `ClickToCopyFileChip`, and `DownloadButton` as-is.

### Step 3 — Shared `PreviewSourceToggle` component (replaces both text toggles)

**New file:** [src/components/preview-panel/preview-source-toggle.tsx](src/components/preview-panel/preview-source-toggle.tsx)

```tsx
import { Code2 } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { PreviewTarget } from '@/types';
import { getTabIcon } from './preview-utils';

export type PreviewSourceMode = 'preview' | 'source';

interface Props {
  target: PreviewTarget;
  value: PreviewSourceMode;
  onChange: (mode: PreviewSourceMode) => void;
}

export function PreviewSourceToggle({ target, value, onChange }: Props) {
  const PreviewIcon = getTabIcon(target);
  return (
    <Tabs
      value={value}
      onValueChange={(v) => { if (v === 'preview' || v === 'source') onChange(v); }}
      className="shrink-0 gap-0"
    >
      <TabsList variant="outline" className="h-7">
        <Tooltip>
          <TooltipTrigger asChild>
            <TabsTrigger value="preview" className="h-6 w-7 p-0" aria-label="Preview">
              <PreviewIcon className="h-3.5 w-3.5" />
            </TabsTrigger>
          </TooltipTrigger>
          <TooltipContent>Preview</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <TabsTrigger value="source" className="h-6 w-7 p-0" aria-label="Source code">
              <Code2 className="h-3.5 w-3.5" />
            </TabsTrigger>
          </TooltipTrigger>
          <TooltipContent>Source code</TooltipContent>
        </Tooltip>
      </TabsList>
    </Tabs>
  );
}
```

- The "preview" icon **always comes from `getTabIcon(target)`** ([preview-utils.ts:52-71](src/components/preview-panel/preview-utils.ts#L52-L71)) so it matches the tab bar. No new icon mapping is introduced; the tab-icon mapping stays the single source of truth.
- The "source" icon is universally `Code2` (the `<>` glyph in the reference screenshot).
- Underlying state types **stay the same** — `notebookViewMode` remains `'report' | 'notebook'`; `markdownViewMode` remains `'rendered' | 'source'`. The toggle component translates at the UI boundary. This keeps the per-tab state in `Chat.tsx` (`tabNotebookViewModes`, `tabMarkdownViewModes`) and `FilePreviewContent`'s prop shapes untouched.

### Step 4 — Verify file-type → preview icon mapping

The toggle pulls from `getTabIcon`. The current mapping ([preview-utils.ts:52-71](src/components/preview-panel/preview-utils.ts#L52-L71)):

| Extensions | Icon (Lucide) |
|---|---|
| `.ipynb` | `NotebookPen` |
| `.json`, `.jsonl` | `Braces` |
| `.md`, `.txt`, `.pdf` | `FileText` |
| `.csv`, `.tsv`, `.xlsx`, `.xls` | `FileSpreadsheet` |
| `.svg`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`, `.ico`, `.avif` | `FileImage` |
| `.py`, `.js`, `.jsx`, `.ts`, `.tsx`, `.html`, `.css`, `.rs`, `.go`, `.java`, `.c`, `.cpp`, `.sh`, `.sql`, `.yaml`, `.yml`, `.toml`, `.bash`, `.zsh` | `FileCode` |
| App preview | `AppWindow` |
| Fallback | `File` |

Today only `.ipynb` (→ `NotebookPen`) and `.md` (→ `FileText`) hit the toggle code path. Both are correct. No change needed; just verify visually that the icons read clearly at `h-3.5 w-3.5`.

### Step 5 — Remove dead code

After Steps 2 + 3:

- Delete `AppToolbarActions`, `NotebookToolbarActions`, `MarkdownToolbarActions`, `FileToolbarActions` from `preview-toolbar.tsx`. Their bodies were folded into the unified toolbar render.
- Remove the now-unused `Tabs`, `TabsList`, `TabsTrigger` imports from `preview-toolbar.tsx` ([line 22](src/components/preview-panel/preview-toolbar.tsx#L22)); `PreviewSourceToggle` owns them now.
- Rename `onOpenExternal` → `onOpenElsewhere` everywhere it threads through (`PreviewToolbarProps` and the Chat.tsx callsite). This is a 1:1 rename, no behavior change.

---

## Decisions (confirmed)

1. **View toggle tooltip strings:** universal `Preview` / `Source code`. The small semantic shift for notebooks (the "Notebook" view shows code cells with outputs, not raw `.ipynb` JSON) is an accepted trade-off for cross-file-type consistency.
2. **Share moves into the right zone, just after `Open live app`.** See the Share callout below for implementation specifics.

### Note on the Share control

`ShareStatusButton` ([Chat.tsx:960-1074](src/components/Chat.tsx#L960-L1074)) is **not an icon button** — it's a labeled `DropdownMenu` trigger that controls **public visibility of the deployed app on the internet**. The user-visible behavior is significant: switching to Public means anyone with the vanity URL can load the app. Treat this control carefully when moving it:

- **It's a `DropdownMenu` with radio items** (`Private` / `Public`), not a toggle. Don't accidentally collapse it into a single click action.
- **It has its own visual weight.** Trigger renders as `h-6 px-2 gap-1.5` with an icon (`Globe` when public, `Lock` when private), the text label `Public` / `Private`, and a `ChevronDown` caret. The "Public" state has a distinct primary-tinted border + background. This makes it visually larger than the icon-only `ToolbarButton`s around it — that is intentional and should not be muted.
- **Dropdown alignment.** The dropdown content uses `align="end"`. After moving the trigger toward the middle-right of the toolbar (rather than the far right today), verify the panel still positions reasonably and doesn't get clipped by the preview pane edge. If it does, switch to `align="start"` or `align="center"`.
- **State plumbing is unchanged.** `isPublic`, `setAppIsPublic`, `threadId`, and `scriptName` props all stay the same; this is purely a position change inside the toolbar.
- **Manual visibility regression test.** As part of validation, toggle Public → Private once after the move and confirm the deployed app actually flips access (not just the UI state). The optimistic-update + fetcher path runs through `/apps` action — easy to break inadvertently.

---

## Components Used

All already installed in [src/components/ui/](src/components/ui/):

- `Button` — toolbar buttons, `variant="ghost" size="icon-sm"`
- `Tabs`, `TabsList`, `TabsTrigger` — view-mode toggle (`variant="outline"`)
- `Tooltip`, `TooltipTrigger`, `TooltipContent` — every toolbar button gets one
- `Separator` — zone dividers
- `DropdownMenu` family — notebook download dropdown (unchanged)

Lucide icons used: `RefreshCw`, `ExternalLink`, `PanelsTopLeft` (new), `Code2` (new), `Download`, `Bug`, `Globe`, `FileText` (chip), plus all icons already pulled by `getTabIcon`.

---

## Validation Checklist

**Layout / positioning**
- [ ] In every file type, Refresh is always the first button.
- [ ] In every file type where Open-elsewhere exists, it is the **first** button in the right zone — immediately adjacent to the center identity chip.
- [ ] The identity chip is always centered (in the flex-expanding middle zone).
- [ ] View toggle (when present) sits to the right of Refresh, left of the first separator.
- [ ] Download (when present) is the last button in the right zone for file types.
- [ ] No button changes zones between file types.

**Open-elsewhere split + removal**
- [ ] App preview shows `ExternalLink` + tooltip `Open live app`; clicks open `appPreviewVanityUrl`.
- [ ] Workspace-source file shows `PanelsTopLeft` + tooltip `Open in Computer`; clicks open `/computer/{id}?file=...`.
- [ ] **Upload-source and output-source files render no open-elsewhere button at all.** Refresh, identity chip, and Download remain.
- [ ] `fileExternalOpenUrl` returns `""` for non-workspace sources (no more `/api/.../uploads/...` or `/api/.../outputs/...` URLs).
- [ ] Clicking the button never produces a `window.open(null/empty)` no-op.

**View toggle**
- [ ] Notebook tab: toggle shows `NotebookPen` (preview) + `Code2` (source); switching updates `tabNotebookViewModes[tabId]` between `'report'` and `'notebook'`; preview content updates.
- [ ] Markdown tab: toggle shows `FileText` (preview) + `Code2` (source); switching updates `tabMarkdownViewModes[tabId]` between `'rendered'` and `'source'`; preview content updates.
- [ ] Tooltip on hover: `Preview` / `Source code`.
- [ ] Keyboard: Tab focuses the toggle; arrow keys move between triggers; Enter/Space activates.
- [ ] Per-tab independence: opening two notebooks and switching their view modes does not bleed state between them.

**Regression**
- [ ] App refresh still reloads iframe; file refresh still refetches.
- [ ] URL chip / file chip still copy on click with 1.5s flash.
- [ ] Notebook download dropdown still offers `.ipynb` direct + `Report as PDF`.
- [ ] Share dropdown still works from the right zone:
  - [ ] Trigger still shows correct `Globe`/`Public` vs `Lock`/`Private` state.
  - [ ] Public state still gets the primary-tinted border + background.
  - [ ] Dropdown panel opens without being clipped by the preview pane edge (adjust `align` if it is).
  - [ ] **Toggling Public → Private actually changes app visibility on the internet** (not just UI optimistic state).
- [ ] Bug report still admin-gated; modal still opens.
- [ ] Mobile chat/preview switch still works when tabs are open.

**Tests**
- `bun run typecheck`
- `bun run lint`
- `bun run test:run -- preview` (any existing preview-toolbar tests)

---

## Out of Scope

- **Adding the view toggle to new file types** (JSON pretty-print, CSV table-vs-raw, SVG render-vs-source). The shared `PreviewSourceToggle` makes this trivial later — drop it in for any file type whose `FilePreviewContent` supports two render modes — but no new toggles ship here.
- **Renaming the underlying view-mode state types.** `notebookViewMode` stays `'report' | 'notebook'`; `markdownViewMode` stays `'rendered' | 'source'`. Only the UI layer translates to `'preview' | 'source'`.
- **Tab bar icon changes.** This plan reuses the existing `getTabIcon` mapping; it does not redefine it.
- **Building Computer-tab support for uploaded/output files.** A separate effort. If/when uploads and outputs become viewable in the Computer view, the open-elsewhere classifier in `Chat.tsx` flips them from `null` to `'computer'` — one-line change. This plan deliberately removes the dead button until then.
- **App preview view toggle.** Apps have no rendered/source distinction. Untouched.
