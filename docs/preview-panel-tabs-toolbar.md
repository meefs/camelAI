# Preview Panel: Tabs & Action Toolbar

## Problem

The preview panel can only show one thing at a time. When Claude produces multiple artifacts (a deployed app, a notebook, a markdown doc, etc.), users must re-click references in chat to swap between them. There's no way to keep multiple items accessible.

The current toolbar is a flat row of icon buttons mixed in with the header. Actions aren't grouped logically and differ between app previews and file previews, but the two layouts share no common structure. Adding more actions (download, format-specific options) will make this worse.

This plan introduces:
1. **Tab support** — multiple items open simultaneously with a tab bar
2. **Contextual action toolbar** — a dedicated second row of grouped, file-type-aware actions

---

## Design

### Two-Row Header

The preview panel header is always two rows. Row 1 identifies what's open. Row 2 provides actions for the active item.

```
┌─────────────────────────────────────────────────────────────────┐
│ Row 1: Tab Row                                                  │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐            │
│  │ ◎ app.js   × │ │ ◫ data.ipynb │ │ ▣ my-app     │            │
│  └──────────────┘ └──────────────┘ └──────────────┘            │
├─────────────────────────────────────────────────────────────────┤
│ Row 2: Action Toolbar                                           │
│  [ ↻ ] │ [ Report / Notebook ] │ [ ↓ ]  ─────────────  [ ⧉ ]  │
└─────────────────────────────────────────────────────────────────┘
│                                                                 │
│                     Content Area                                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Single Tab (one item open)

When only one item is open, Row 1 looks like a simple header — no tab strip appearance:

```
┌─────────────────────────────────────────────────────────────────┐
│  ◎ analysis.py                                              ×   │
├─────────────────────────────────────────────────────────────────┤
│  [ ↻ ] │ [ ↓ ]  ──────────────────────────────────────  [ ⧉ ]  │
└─────────────────────────────────────────────────────────────────┘
```

- Left: File type icon + filename (monospace)
- Right: Close button (×)
- No visual hint that tabs exist

### Multi Tab (two or more items open)

```
┌──────────────┬──────────────┬──────────────┬────────────────────┐
│ ◎ app.js   × │ ◫ data.ipynb │ ▣ my-app   × │                    │
│   (active)   │  (inactive)  │  (inactive)  │                    │
├──────────────┴──────────────┴──────────────┴────────────────────┤
│  [ ↻ ] │ [ ↓ ]  ──────────────────────────────────────  [ ⧉ ]  │
└─────────────────────────────────────────────────────────────────┘
```

- Active tab: lighter background (`bg-background`), thin bottom border (`border-b-2 border-foreground`)
- Inactive tabs: darker background (`bg-muted/30`), no bottom border
- Close (×) visible on hover or when tab is active
- Horizontal scroll when tabs overflow — no dropdown or overflow menu
- Filenames in monospace: `font-mono text-xs`

### Transition Between States

When going from 1 → 2 tabs, the header should feel like it naturally "grew" tabs. The action toolbar (Row 2) stays pinned in the same position. No layout jump.

---

## File Type Icons

Each file type gets a distinct icon from Lucide.

| Type | Extensions | Lucide Icon | Notes |
|------|-----------|-------------|-------|
| Live app | (app) | `AppWindow` | Replaces green dot |
| Text / Markdown | `.md`, `.txt` | `FileText` | Already in `file-type-utils.ts` |
| Notebook | `.ipynb` | `NotebookPen` | Distinct from generic code |
| Spreadsheet | `.csv`, `.tsv`, `.xlsx` | `FileSpreadsheet` | Already in `file-type-utils.ts` |
| JSON | `.json`, `.jsonl` | `Braces` | Distinct from generic code |
| Code | `.py`, `.js`, `.ts`, etc. | `FileCode` | Already in `file-type-utils.ts` |
| Image | `.svg`, `.png`, `.jpg` | `FileImage` | Already in `file-type-utils.ts` |
| PDF | `.pdf` | `FileText` | Matches existing |
| Other / fallback | — | `File` | Already in `file-type-utils.ts` |

Icons are `h-3.5 w-3.5` in tabs, monochrome `text-muted-foreground`.

---

## Row 2: Action Toolbar

A horizontal row of icon buttons. Contents change based on the active tab's file type.

### Layout Principles

```
[ Refresh ] | {type-specific actions} ─────────────────── [ Open in new tab ]
     ▲              ▲                    spacer                    ▲
     │              │                  (flex-1)                    │
  Always first   Middle group                              Always last
```

- Logical groups separated by `<Separator orientation="vertical" />` (thin vertical dividers)
- Refresh always leftmost
- Open in new tab always rightmost, pushed right with `flex-1` spacer
- All buttons: `variant="ghost" size="icon-sm"` with `Tooltip`

### Actions by File Type

**Live app**
```
[ ↻ Refresh ] │ [ URL bar (click-to-copy) ] [ Public/Private ] │ [ 🪲 Bug ] ─── [ ⧉ Open ]
```

- **Refresh**: Reloads iframe (`refreshActiveIframe()`)
- **URL bar**: Non-editable field showing vanity domain (e.g. `my-dashboard--org.chiridion.app`). Styled like a mini browser URL bar: `bg-muted/50 rounded-md px-2 py-1 text-xs font-mono text-muted-foreground truncate`. On click, copies full URL (with `https://` prefix) to clipboard. Brief "Copied!" flash — field background pulses `bg-green-500/10` for ~1.5s then resets. Show a subtle "Copy" label on hover (`opacity-0 group-hover:opacity-100 text-[10px]`)
- **Public/Private**: Existing `ShareStatusButton` — no changes needed to the component itself, but the `onStatusChange` callback must update the active tab target (see Step 7e)
- **Bug report**: Existing bug button — no changes
- **Open in new tab**: Opens `appPreviewVanityUrl` via `window.open()`

**Notebook (.ipynb)**
```
[ ↻ Refresh ] │ [ Report │ Notebook ] │ [ ↓ Download ] ──────── [ ⧉ Open ]
```

- **Refresh**: Re-fetches notebook (`refreshActiveFilePreview()`)
- **Report / Notebook toggle**: Existing segmented control (shadcn `Tabs` with `variant="outline"`) — move from Row 1 to Row 2. Same implementation: `TabsList variant="outline" className="h-7"`, `TabsTrigger className="h-6 px-3 text-xs"`
- **Download**: Direct download of the `.ipynb` file (single format, no submenu)
- **Open in new tab**: Opens file in computer tab

**Markdown (.md)**
```
[ ↻ Refresh ] │ [ ↓ Download ] ──────────────────────── [ ⧉ Open ]
```

- **Download**: Direct download of the `.md` file (single format)

**Text (.txt)**
```
[ ↻ Refresh ] │ [ ↓ Download ] ────────────────────────── [ ⧉ Open ]
```

- **Download**: Direct download (single format)

**Spreadsheet (.csv, .tsv)**
```
[ ↻ Refresh ] │ [ ↓ Download ] ──────────────────────── [ ⧉ Open ]
```

- **Download**: Direct download (single format, original CSV/TSV)

**JSON (.json, .jsonl)**
```
[ ↻ Refresh ] │ [ ↓ Download ] ────────────────────────── [ ⧉ Open ]
```

- **Download**: Direct download (no submenu)

**Code files (.py, .js, .ts, etc.)**
```
[ ↻ Refresh ] │ [ ↓ Download ] ────────────────────────── [ ⧉ Open ]
```

- **Download**: Direct download (no submenu)

**SVG images (.svg)**
```
[ ↻ Refresh ] │ [ ↓ Download ] ──────────────────────── [ ⧉ Open ]
```

- **Download**: Direct download of SVG (single format)

**Raster images (.png, .jpg, etc.)**
```
[ ↻ Refresh ] │ [ ↓ Download ] ────────────────────────── [ ⧉ Open ]
```

- **Download**: Direct download (no submenu)

### Download Button Behavior

The download button is always just the `Download` icon — no caret, no chevron, no visual indicator that it's a dropdown.

For the initial build, all downloads are single-format (the original file). The `triggerDownload` helper creates a temporary `<a>` element with the `download` attribute and clicks it programmatically (see Step 5 for implementation).

The `getDownloadFormats` function returns possible formats per file type. For now it returns only the original format for each type. The multi-format dropdown code path exists in the component but won't be exercised until format conversion endpoints are built. When conversion endpoints are added later, the `getDownloadFormats` function is the only thing that needs to change — the UI will render the dropdown automatically when more than one format is returned.

### Open in New Tab Behavior

- **Live apps**: `window.open(appPreviewVanityUrl, '_blank')`
- **All files**: `window.open(/computer/{workspaceId}?file={encodedPath}, '_blank')` — opens the source file in the Computer tab

---

## Implementation

### 1. Define tab state types

**File: `src/types.ts`**

Add a `PreviewTab` type that wraps a `PreviewTarget` with tab-specific metadata:

```typescript
export interface PreviewTab {
  /** Unique ID for this tab (used as React key) */
  id: string;
  /** The preview target this tab displays */
  target: PreviewTarget;
}
```

No changes needed to the existing `PreviewTarget` type (lines 13–26 in `src/types.ts`).

### 2. Create the preview panel tab row component

**New file: `src/components/preview-panel/preview-tabs.tsx`**

This component renders Row 1 — the tab/header row.

```typescript
interface PreviewTabRowProps {
  tabs: PreviewTab[];
  activeTabId: string;
  onTabSelect: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
}
```

**Row 1 rendering logic:**

```tsx
function PreviewTabRow({ tabs, activeTabId, onTabSelect, onTabClose }: PreviewTabRowProps) {
  const isSingleTab = tabs.length === 1;
  const scrollRef = useRef<HTMLDivElement>(null);

  if (isSingleTab) {
    const tab = tabs[0];
    const label = getTabLabel(tab.target);
    const Icon = getTabIcon(tab.target);
    return (
      <div className="flex items-center justify-between px-4 py-2 border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="text-sm font-mono truncate">{label}</span>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={() => onTabClose(tab.id)}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }

  // Multi-tab: scrollable tab bar
  return (
    <div
      ref={scrollRef}
      className="flex items-stretch overflow-x-auto border-b border-border bg-muted/20"
      style={{ scrollbarWidth: 'none' }}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        const label = getTabLabel(tab.target);
        const Icon = getTabIcon(tab.target);
        return (
          <button
            key={tab.id}
            onClick={() => onTabSelect(tab.id)}
            className={cn(
              'group/tab flex items-center gap-1.5 px-3 py-2 text-xs font-mono shrink-0 border-b-2 transition-colors',
              isActive
                ? 'bg-background border-foreground text-foreground'
                : 'bg-transparent border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/30'
            )}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate max-w-[120px]">{label}</span>
            <span
              role="button"
              onClick={(e) => { e.stopPropagation(); onTabClose(tab.id); }}
              className={cn(
                'ml-1 flex h-4 w-4 items-center justify-center rounded-sm transition-opacity',
                'hover:bg-foreground/10',
                isActive ? 'opacity-100' : 'opacity-0 group-hover/tab:opacity-100'
              )}
            >
              <X className="h-3 w-3" />
            </span>
          </button>
        );
      })}
    </div>
  );
}
```

### 3. Create the action toolbar component

**New file: `src/components/preview-panel/preview-toolbar.tsx`**

```typescript
interface PreviewToolbarProps {
  activeTarget: PreviewTarget;
  /** App-specific props */
  vanityUrl?: string;
  vanityHost?: string;
  isPublic?: boolean;
  isAdmin?: boolean;
  onRefresh: () => void;
  onOpenExternal: () => void;
  /** App-only callbacks */
  onBugReport?: () => void;
  appShareButton?: React.ReactNode;
  /** Notebook-only */
  notebookViewMode?: 'report' | 'notebook';
  onNotebookViewModeChange?: (mode: 'report' | 'notebook') => void;
  /** File preview open URL (for download) */
  filePreviewOpenUrl?: string;
}
```

**Rendering logic:**

```tsx
function PreviewToolbar(props: PreviewToolbarProps) {
  const { activeTarget, onRefresh, onOpenExternal } = props;
  const fileType = getToolbarFileType(activeTarget);

  return (
    <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border">
      {/* ── Refresh (always first) ── */}
      <ToolbarButton icon={RefreshCw} tooltip="Refresh" onClick={onRefresh} />

      <Separator orientation="vertical" className="mx-1 h-4" />

      {/* ── Type-specific middle section ── */}
      {fileType === 'app' && <AppToolbarActions {...props} />}
      {fileType === 'notebook' && <NotebookToolbarActions {...props} />}
      {fileType !== 'app' && fileType !== 'notebook' && (
        <DownloadButton activeTarget={activeTarget} filePreviewOpenUrl={props.filePreviewOpenUrl} />
      )}

      {/* ── Spacer ── */}
      <div className="flex-1" />

      {/* ── Open in new tab (always last) ── */}
      <ToolbarButton icon={ExternalLink} tooltip="Open in new tab" onClick={onOpenExternal} />
    </div>
  );
}
```

**`AppToolbarActions` sub-component** (inline in same file):

```tsx
function AppToolbarActions(props: PreviewToolbarProps) {
  return (
    <>
      <ClickToCopyUrlBar
        url={props.vanityUrl ?? ''}
        displayHost={props.vanityHost ?? ''}
      />
      {props.appShareButton}

      <Separator orientation="vertical" className="mx-1 h-4" />

      <ToolbarButton icon={Bug} tooltip="Report a bug" onClick={props.onBugReport ?? (() => {})} />
    </>
  );
}
```

**`NotebookToolbarActions` sub-component** (inline in same file):

```tsx
function NotebookToolbarActions(props: PreviewToolbarProps) {
  return (
    <>
      <Tabs
        value={props.notebookViewMode ?? 'report'}
        onValueChange={(value) => {
          if (value === 'report' || value === 'notebook') {
            props.onNotebookViewModeChange?.(value);
          }
        }}
        className="shrink-0 gap-0"
      >
        <TabsList variant="outline" className="h-7">
          <TabsTrigger value="report" className="h-6 px-3 text-xs">
            Report
          </TabsTrigger>
          <TabsTrigger value="notebook" className="h-6 px-3 text-xs">
            Notebook
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <Separator orientation="vertical" className="mx-1 h-4" />

      <DownloadButton activeTarget={props.activeTarget} filePreviewOpenUrl={props.filePreviewOpenUrl} />
    </>
  );
}
```

**Small helper: `ToolbarButton`**

```tsx
function ToolbarButton({ icon: Icon, tooltip, onClick, ...rest }: {
  icon: LucideIcon; tooltip: string; onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" onClick={onClick} {...rest}>
          <Icon className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}
```

**Note on icon sizing:** The Button component's `size="icon-sm"` variant (`size-6`, icon `size-3` = `12px`) is pre-existing and matches current toolbar buttons. The `h-4 w-4` class on icon elements overrides the default in the CVA variants — this is intentional to match the existing app preview toolbar icon sizes. Verify visually that `h-4 w-4` looks right; if icons feel too large in the smaller toolbar row, switch to letting the variant default apply by removing the explicit icon class.

### 4. Create the URL bar component (app preview only)

**Add to: `src/components/preview-panel/preview-toolbar.tsx`** (or co-locate)

```tsx
function ClickToCopyUrlBar({ url, displayHost }: { url: string; displayHost: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        'group/url flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-mono truncate max-w-[240px] transition-colors',
        copied ? 'bg-green-500/10' : 'bg-muted/50 hover:bg-muted'
      )}
    >
      <Globe className="h-3 w-3 shrink-0 text-muted-foreground" />
      <span className="truncate text-muted-foreground">
        {copied ? 'Copied!' : displayHost}
      </span>
      {!copied && (
        <span className="text-[10px] text-muted-foreground/60 opacity-0 group-hover/url:opacity-100 transition-opacity shrink-0">
          Copy
        </span>
      )}
    </button>
  );
}
```

### 5. Create the download button component

**Add to: `src/components/preview-panel/preview-toolbar.tsx`** (or co-locate)

The download button renders as a plain icon. If the file type has multiple download formats (future), it opens a `DropdownMenu`. Otherwise it triggers a direct download.

```tsx
/** Trigger a file download by creating a temporary link and clicking it */
function triggerDownload(url: string, filename?: string) {
  const a = document.createElement('a');
  a.href = url;
  if (filename) a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  // Clean up asynchronously to avoid layout thrashing
  requestAnimationFrame(() => a.remove());
}

function DownloadButton({ activeTarget, filePreviewOpenUrl }: {
  activeTarget: PreviewTarget;
  filePreviewOpenUrl?: string;
}) {
  const formats = getDownloadFormats(activeTarget);
  const downloadUrl = activeTarget.kind === 'file' ? filePreviewOpenUrl : undefined;

  if (!downloadUrl || formats.length === 0) return null;

  // Single format: direct download
  if (formats.length === 1) {
    return (
      <ToolbarButton
        icon={Download}
        tooltip="Download"
        onClick={() => triggerDownload(downloadUrl, formats[0].filename)}
      />
    );
  }

  // Multiple formats: dropdown (future — when conversion endpoints exist)
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm">
              <Download className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Download</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start">
        {formats.map((fmt) => (
          <DropdownMenuItem key={fmt.label} onClick={() => triggerDownload(downloadUrl, fmt.filename)}>
            {fmt.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

**Download format resolution helper:**

For the initial build, every file type returns exactly one format (the original file). The multi-format dropdown structure exists in the component and will activate automatically once `getDownloadFormats` returns more than one entry for a type.

```typescript
function getDownloadFormats(target: PreviewTarget): { label: string; filename: string }[] {
  if (target.kind === 'app') return [];

  const ext = getFileExtension(target.path).toLowerCase();
  const name = target.filename || target.path.split('/').pop() || 'file';

  // Initial build: single-format download only (original file).
  // When server-side conversion endpoints are added, expand the
  // relevant cases to return multiple entries — the dropdown UI
  // will render automatically.
  switch (ext) {
    case 'ipynb':
      return [{ label: 'Download notebook (.ipynb)', filename: name }];
    case 'md':
      return [{ label: 'Download markdown (.md)', filename: name }];
    case 'csv':
      return [{ label: 'Download CSV', filename: name }];
    case 'tsv':
      return [{ label: 'Download TSV', filename: name }];
    case 'svg':
      return [{ label: 'Download SVG', filename: name }];
    default:
      return [{ label: `Download`, filename: name }];
  }
}
```

### 6. Create helpers: `getTabIcon`, `getTabLabel`, `getToolbarFileType`, `getPreviewTabId`

**New file: `src/components/preview-panel/preview-utils.ts`**

```typescript
import { AppWindow, FileText, NotebookPen, FileSpreadsheet, Braces, FileCode, FileImage, File } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { PreviewTarget } from '@/types';
import { getFileExtension } from '@/components/chat-file-preview/file-type-utils';

export function getTabIcon(target: PreviewTarget): LucideIcon {
  if (target.kind === 'app') return AppWindow;

  const ext = getFileExtension(target.path).toLowerCase();

  if (ext === 'ipynb') return NotebookPen;
  if (ext === 'json' || ext === 'jsonl') return Braces;
  if (ext === 'md' || ext === 'txt') return FileText;
  if (ext === 'csv' || ext === 'tsv' || ext === 'xlsx' || ext === 'xls') return FileSpreadsheet;
  if (['svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif'].includes(ext)) return FileImage;
  if (['py', 'js', 'jsx', 'ts', 'tsx', 'html', 'css', 'rs', 'go', 'java', 'c', 'cpp', 'sh', 'sql'].includes(ext)) return FileCode;

  return File;
}

export function getTabLabel(target: PreviewTarget): string {
  if (target.kind === 'app') return target.scriptName;
  if (target.filename) return target.filename;
  return target.path.split('/').filter(Boolean).pop() || 'file';
}

/** Determine which toolbar layout to use based on the active target */
export type ToolbarFileType = 'app' | 'notebook' | 'markdown' | 'text' | 'spreadsheet' | 'json' | 'code' | 'svg' | 'image' | 'other';

export function getToolbarFileType(target: PreviewTarget): ToolbarFileType {
  if (target.kind === 'app') return 'app';
  const ext = getFileExtension(target.path).toLowerCase();
  if (ext === 'ipynb') return 'notebook';
  if (ext === 'md') return 'markdown';
  if (ext === 'txt') return 'text';
  if (ext === 'csv' || ext === 'tsv' || ext === 'xlsx' || ext === 'xls') return 'spreadsheet';
  if (ext === 'json' || ext === 'jsonl') return 'json';
  if (ext === 'svg') return 'svg';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif'].includes(ext)) return 'image';
  if (['py', 'js', 'jsx', 'ts', 'tsx', 'html', 'css', 'rs', 'go', 'java', 'c', 'cpp', 'sh', 'sql'].includes(ext)) return 'code';
  return 'other';
}

/** Generate a stable tab ID from a PreviewTarget */
export function getPreviewTabId(target: PreviewTarget): string {
  if (target.kind === 'app') return `app:${target.scriptName}`;
  return `file:${target.workspaceId}:${target.source}:${target.path}`;
}
```

Implementation note: keep extension classification centralized. `getToolbarFileType()` should reuse `file-type-utils.ts` primitives where possible (or share exported extension sets) so toolbar/file-preview classification does not drift over time.

### 7. Add tab state management to Chat.tsx

**File: `src/components/Chat.tsx`**

This is the largest change. Replace the single `previewTarget` state with a tab list + active tab, and update all dependent code.

#### 7a. New state (replaces lines 717–725)

Remove the single-item preview state (`previewTarget`, `iframeKey`, `filePreviewKey`, `notebookViewMode`, `previewLoading`) and replace it with tab + per-tab maps:

```typescript
// ── Preview tabs ──
const [previewTabs, setPreviewTabs] = useState<PreviewTab[]>(() => {
  if (!initialPreviewTarget) return [];
  return [{ id: getPreviewTabId(initialPreviewTarget), target: initialPreviewTarget }];
});
const [activeTabId, setActiveTabId] = useState<string | null>(() =>
  initialPreviewTarget ? getPreviewTabId(initialPreviewTarget) : null
);

const previewTabsRef = useRef(previewTabs);
const activeTabIdRef = useRef(activeTabId);

const activeTab = useMemo(
  () => previewTabs.find((tab) => tab.id === activeTabId) ?? null,
  [previewTabs, activeTabId]
);
const previewTarget = activeTab?.target ?? null;

const previewTargetRef = useRef<PreviewTarget | null>(previewTarget);
useEffect(() => {
  previewTargetRef.current = previewTarget;
}, [previewTarget]);
useEffect(() => {
  previewTabsRef.current = previewTabs;
}, [previewTabs]);
useEffect(() => {
  activeTabIdRef.current = activeTabId;
}, [activeTabId]);

// ── Per-tab state ──
const [tabIframeKeys, setTabIframeKeys] = useState<Record<string, number>>({});
const [tabFilePreviewKeys, setTabFilePreviewKeys] = useState<Record<string, number>>({});
const [tabNotebookViewModes, setTabNotebookViewModes] = useState<Record<string, 'report' | 'notebook'>>({});
const [tabAppLoading, setTabAppLoading] = useState<Record<string, boolean>>({});

const iframeRefreshTimeoutsRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

// Derived state for the active tab
const iframeKey = activeTabId ? (tabIframeKeys[activeTabId] ?? 0) : 0;
const filePreviewKey = activeTabId ? (tabFilePreviewKeys[activeTabId] ?? 0) : 0;
const notebookViewMode = activeTabId ? (tabNotebookViewModes[activeTabId] ?? 'report') : 'report';
const previewLoading = activeTabId ? Boolean(tabAppLoading[activeTabId]) : false;

const [mobileView, setMobileView] = useState<'chat' | 'preview'>('chat');
const previewVersionRef = useRef<number>(0);
```

#### 7b. Add explicit per-tab key helpers (prevents active-tab race conditions)

```typescript
const bumpIframeKey = useCallback((tabId: string) => {
  setTabIframeKeys((prev) => ({ ...prev, [tabId]: (prev[tabId] ?? 0) + 1 }));
}, []);

const bumpFilePreviewKey = useCallback((tabId: string) => {
  setTabFilePreviewKeys((prev) => ({ ...prev, [tabId]: (prev[tabId] ?? 0) + 1 }));
}, []);

const refreshActiveIframe = useCallback(() => {
  if (!activeTabId) return;
  bumpIframeKey(activeTabId);
}, [activeTabId, bumpIframeKey]);

const refreshActiveFilePreview = useCallback(() => {
  if (!activeTabId) return;
  bumpFilePreviewKey(activeTabId);
}, [activeTabId, bumpFilePreviewKey]);

const setActiveNotebookViewMode = useCallback((mode: 'report' | 'notebook') => {
  if (!activeTabId) return;
  setTabNotebookViewModes((prev) => ({ ...prev, [activeTabId]: mode }));
}, [activeTabId]);
```

#### 7c. Add a best-effort server sync helper for active target

The DO still tracks one active `previewTarget`. In a tabbed UI, selecting/closing tabs must sync the active target back to the server.

```typescript
const syncPreviewTargetBestEffort = useCallback((target: PreviewTarget | null) => {
  if (!threadId) return;
  const socket = wsRef.current;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: 'set_preview_target', target, threadId }));
}, [threadId]);
```

#### 7d. Tab operations (new callbacks)

```typescript
/** Open a target as a tab. If already open, update payload and activate. */
const openTabForTarget = useCallback((target: PreviewTarget) => {
  const id = getPreviewTabId(target);
  setPreviewTabs((prev) => {
    const existing = prev.find((tab) => tab.id === id);
    if (existing) {
      return prev.map((tab) => (tab.id === id ? { ...tab, target } : tab));
    }
    return [...prev, { id, target }];
  });
  setActiveTabId(id);
}, []);

const selectTab = useCallback((tabId: string) => {
  setActiveTabId(tabId);
  const tab = previewTabsRef.current.find((entry) => entry.id === tabId);
  if (tab) syncPreviewTargetBestEffort(tab.target);
}, [syncPreviewTargetBestEffort]);

const closeTab = useCallback((tabId: string) => {
  const prevTabs = previewTabsRef.current;
  const idx = prevTabs.findIndex((tab) => tab.id === tabId);
  if (idx === -1) return;

  const nextTabs = prevTabs.filter((tab) => tab.id !== tabId);
  setPreviewTabs(nextTabs);

  const closingActive = tabId === activeTabIdRef.current;
  if (closingActive) {
    if (nextTabs.length === 0) {
      setActiveTabId(null);
      setMobileView('chat');
      syncPreviewTargetBestEffort(null);
    } else {
      const nextIndex = Math.min(idx, nextTabs.length - 1);
      const nextActive = nextTabs[nextIndex];
      setActiveTabId(nextActive.id);
      syncPreviewTargetBestEffort(nextActive.target);
    }
  }

  // Per-tab cleanup
  setTabIframeKeys((prev) => { const { [tabId]: _, ...rest } = prev; return rest; });
  setTabFilePreviewKeys((prev) => { const { [tabId]: _, ...rest } = prev; return rest; });
  setTabNotebookViewModes((prev) => { const { [tabId]: _, ...rest } = prev; return rest; });
  setTabAppLoading((prev) => { const { [tabId]: _, ...rest } = prev; return rest; });

  const timeout = iframeRefreshTimeoutsRef.current[tabId];
  if (timeout) {
    clearTimeout(timeout);
    delete iframeRefreshTimeoutsRef.current[tabId];
  }
}, [syncPreviewTargetBestEffort]);
```

#### 7e. Update `appIsPublic` / `setAppIsPublic` (line 773–779)

The current code derives `appIsPublic` from `previewTarget` and mutates single-target state directly. With tabs, update the app target inside the active tab:

```typescript
const appIsPublic = previewTarget?.kind === 'app' ? previewTarget.isPublic : false;

const setAppIsPublic = useCallback((isPublic: boolean) => {
  if (!activeTabId) return;
  setPreviewTabs((prev) =>
    prev.map((tab) => {
      if (tab.id !== activeTabId) return tab;
      if (tab.target.kind !== 'app') return tab;
      return { ...tab, target: { ...tab.target, isPublic } };
    })
  );
}, [activeTabId]);
```

#### 7f. Update `setPreviewTargetForThread` (lines 2409–2436)

Do not refresh via `refreshActiveIframe()` here; that can race before `activeTabId` updates. Open tab locally, then sync target to DO.

```typescript
const setPreviewTargetForThread = useCallback((target: PreviewTarget | null) => {
  if (!threadId) return;

  const socket = wsRef.current;
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    if (target === null) {
      // Local "close all" still works offline.
      setPreviewTabs([]);
      setActiveTabId(null);
      setTabIframeKeys({});
      setTabFilePreviewKeys({});
      setTabNotebookViewModes({});
      setTabAppLoading({});
      for (const timeout of Object.values(iframeRefreshTimeoutsRef.current)) {
        clearTimeout(timeout);
      }
      iframeRefreshTimeoutsRef.current = {};
      setMobileView('chat');
      return;
    }
    toast.error('Preview is unavailable while reconnecting.');
    return;
  }

  socket.send(JSON.stringify({ type: 'set_preview_target', target, threadId }));

  if (target) {
    openTabForTarget(target);
  }
}, [threadId, openTabForTarget]);
```

#### 7g. Update `openPreviewTarget` and `clearPreviewTarget`

```typescript
const openPreviewTarget = useCallback((target: PreviewTarget) => {
  setPreviewTargetForThread(target);
  setMobileView('preview');
}, [setPreviewTargetForThread]);

// "Close all tabs" — dismiss the preview panel entirely
const clearPreviewTarget = useCallback(() => {
  setPreviewTargetForThread(null);
  setPreviewTabs([]);
  setActiveTabId(null);
  setTabIframeKeys({});
  setTabFilePreviewKeys({});
  setTabNotebookViewModes({});
  setTabAppLoading({});
  for (const timeout of Object.values(iframeRefreshTimeoutsRef.current)) {
    clearTimeout(timeout);
  }
  iframeRefreshTimeoutsRef.current = {};
  setMobileView('chat');
}, [setPreviewTargetForThread]);
```

#### 7h. Update `handleRealtimeSideChannelEvent` for `preview_state` (lines 882–910)

When the server broadcasts preview state, always update/open that tab. On version bump, refresh by explicit tab ID:

```typescript
if (data.type === 'preview_state') {
  const nextTarget = coercePreviewTarget(data.target);
  const newVersion = typeof data.version === 'number' ? data.version : 0;
  const hasVersionBump = newVersion > previewVersionRef.current;
  previewVersionRef.current = newVersion;

  if (!nextTarget) {
    // Keep client tabs; DO only stores the single active preview.
    return;
  }

  openTabForTarget(nextTarget);
  const nextId = getPreviewTabId(nextTarget);

  if (nextTarget.kind === 'app' && hasVersionBump) {
    const existingTimeout = iframeRefreshTimeoutsRef.current[nextId];
    if (existingTimeout) clearTimeout(existingTimeout);

    setTabAppLoading((prev) => ({ ...prev, [nextId]: true }));
    iframeRefreshTimeoutsRef.current[nextId] = setTimeout(() => {
      setTabAppLoading((prev) => ({ ...prev, [nextId]: false }));
      bumpIframeKey(nextId);
      delete iframeRefreshTimeoutsRef.current[nextId];
    }, 1500);
  } else if (nextTarget.kind === 'file' && hasVersionBump) {
    // Refresh even if this tab is not currently active.
    bumpFilePreviewKey(nextId);
  }
  return;
}
```

Dependency array for the side-channel handler should include:
- `openTabForTarget`
- `bumpIframeKey`
- `bumpFilePreviewKey`

#### 7i. Thread/reset cleanup

Thread changes must reset tabs and clear outstanding refresh timers:

```typescript
useEffect(() => {
  if (initialPreviewTarget) {
    const tab: PreviewTab = { id: getPreviewTabId(initialPreviewTarget), target: initialPreviewTarget };
    setPreviewTabs([tab]);
    setActiveTabId(tab.id);
  } else {
    setPreviewTabs([]);
    setActiveTabId(null);
  }

  setTabIframeKeys({});
  setTabFilePreviewKeys({});
  setTabNotebookViewModes({});
  setTabAppLoading({});
  previewVersionRef.current = 0;

  for (const timeout of Object.values(iframeRefreshTimeoutsRef.current)) {
    clearTimeout(timeout);
  }
  iframeRefreshTimeoutsRef.current = {};
}, [threadId, initialPreviewTarget]);

useEffect(() => {
  if (!threadId) {
    setPreviewTabs([]);
    setActiveTabId(null);
    setTabIframeKeys({});
    setTabFilePreviewKeys({});
    setTabNotebookViewModes({});
    setTabAppLoading({});
    for (const timeout of Object.values(iframeRefreshTimeoutsRef.current)) {
      clearTimeout(timeout);
    }
    iframeRefreshTimeoutsRef.current = {};
  }
}, [threadId]);
```

#### 7j. Remove the `notebookPreviewKey` view-mode-reset effect (lines 2549–2556)

Remove the old reset effect:

```typescript
const notebookPreviewKey = useMemo(() => { ... }, [previewTarget]);
useEffect(() => { setNotebookViewMode('report'); }, [notebookPreviewKey]);
```

Each tab now has independent notebook mode state and defaults to `'report'` when absent from `tabNotebookViewModes`.

### 8. Update `ChatPreviewProvider` context

**File: `src/components/chat-preview/preview-context.tsx`**

No changes needed — `openPreviewTarget` and `clearPreviewTarget` still work the same way from the consumer's perspective (file preview chips in chat messages call `openPreviewTarget` to open a file). The internal implementation change (opening a tab vs. setting a single target) is transparent.

### 9. Replace `previewPanelBody` in Chat.tsx (lines 2604–2787)

Replace the current `previewPanelBody` block with a unified structure that delegates to the new components:

```tsx
const previewPanelBody = previewTabs.length > 0 && previewTarget ? (
  <>
    {/* Row 1: Tab row */}
    <PreviewTabRow
      tabs={previewTabs}
      activeTabId={activeTabId!}
      onTabSelect={selectTab}
      onTabClose={closeTab}
    />

    {/* Row 2: Action toolbar */}
    <PreviewToolbar
      activeTarget={previewTarget}
      vanityUrl={appPreviewVanityUrl}
      vanityHost={previewDomains.vanityHost}
      isPublic={appIsPublic}
      isAdmin={isAdmin}
      onRefresh={() => {
        if (previewTarget.kind === 'app') {
          refreshActiveIframe();
        } else {
          refreshActiveFilePreview();
        }
      }}
      onOpenExternal={() => {
        if (previewTarget.kind === 'app') {
          window.open(appPreviewVanityUrl, '_blank');
        } else {
          window.open(fileComputerOpenUrl, '_blank');
        }
      }}
      onBugReport={() => {
        setBugReportOpen(true);
        setBugReportStatus('idle');
        setBugReportError(null);
      }}
      appShareButton={
        previewTarget.kind === 'app' ? (
          <ShareStatusButton
            threadId={threadId}
            scriptName={previewTarget.scriptName}
            isPublic={appIsPublic}
            isAdmin={Boolean(isAdmin)}
            onStatusChange={setAppIsPublic}
          />
        ) : undefined
      }
      notebookViewMode={isNotebookPreview ? notebookViewMode : undefined}
      onNotebookViewModeChange={setActiveNotebookViewMode}
      filePreviewOpenUrl={filePreviewOpenUrl}
    />

    {/* Content area — key on activeTabId to force proper unmount/remount on tab switch */}
    <div key={activeTabId} className="flex-1 min-h-0 overflow-hidden">
      {previewTarget.kind === 'app' ? (
        previewLoading ? (
          <div className="w-full h-full flex items-center justify-center bg-muted/30">
            <div className="flex flex-col items-center gap-3">
              <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Loading preview...</span>
            </div>
          </div>
        ) : (
          <iframe
            ref={iframeRef}
            key={iframeKey}
            src={appPreviewUrl || 'about:blank'}
            className="w-full h-full bg-white"
            title="Deployed App Preview"
          />
        )
      ) : (
        <div className={cn('h-full', !isNotebookPreview && 'p-3')}>
          <FilePreviewContent
            filename={previewFileName}
            previewUrl={filePreviewUrl}
            contentType={previewTarget.contentType}
            layout="panel"
            notebookViewMode={isNotebookPreview ? notebookViewMode : undefined}
          />
        </div>
      )}
    </div>
  </>
) : null;
```

Where `fileComputerOpenUrl` is a new memo:

```typescript
const fileComputerOpenUrl = useMemo(() => {
  if (previewTarget?.kind !== 'file') return '';
  return `/computer/${previewTarget.workspaceId}?file=${encodeURIComponent(previewTarget.path)}`;
}, [previewTarget]);
```

**Key detail:** The `key={activeTabId}` on the content `div` ensures React properly unmounts and remounts the content when switching tabs. This is important for:
- Cleaning up iframe event listeners when switching away from an app tab
- Resetting file preview scroll position
- Avoiding stale notebook state

#### 9a. Update ResizablePanel conditional (line 2953)

Replace `previewTarget &&` with `previewTabs.length > 0 &&`:

```tsx
{previewTabs.length > 0 && (
  <>
    <ResizableHandle withHandle />
    <ResizablePanel
      defaultSize="50%"
      minSize="25%"
      maxSize="70%"
      className="flex flex-col min-h-0 min-w-0 bg-background"
    >
      {previewPanelBody}
    </ResizablePanel>
  </>
)}
```

Also update the chat panel `defaultSize` (line 2946):

```tsx
<ResizablePanel
  defaultSize={previewTabs.length > 0 ? "50%" : "100%"}
  minSize="30%"
  className="flex flex-col min-h-0 min-w-0"
>
```

#### 9b. Update mobile layout (lines 2911–2939)

Replace `previewTarget` checks with `previewTabs.length > 0`:

```tsx
{isMobile ? (
  <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
    {previewTabs.length > 0 ? (
      <>
        <div className="relative flex-1 min-h-0 overflow-hidden">
          <div
            className={cn(
              "flex h-full w-[200%] will-change-transform motion-safe:transition-transform motion-safe:duration-300 motion-safe:ease-out",
              showMobilePreview ? "-translate-x-1/2" : "translate-x-0"
            )}
          >
            <div className="flex w-1/2 shrink-0 flex-col min-h-0">
              {chatPanelContent}
            </div>
            <div className="flex w-1/2 shrink-0 flex-col min-h-0 bg-background">
              {previewPanelBody}
            </div>
          </div>
        </div>
        <div className="shrink-0 border-t border-border bg-background">
          <MobileViewSwitcher value={mobileView} onChange={setMobileView} />
        </div>
      </>
    ) : (
      <div className="flex flex-1 min-h-0 flex-col">
        {chatPanelContent}
      </div>
    )}
  </div>
) : ( /* desktop layout */ )}
```

Also update `showMobilePreview` (line 2601):

```typescript
const showMobilePreview = previewTabs.length > 0 && mobileView === 'preview';
```

### 10. Add `.tsv` to `SPREADSHEET_EXTENSIONS` in file-type-utils.ts

**File: `src/components/chat-file-preview/file-type-utils.ts`** (line 28)

The existing `SPREADSHEET_EXTENSIONS` set is missing `tsv`. Add it:

```typescript
const SPREADSHEET_EXTENSIONS = new Set(['csv', 'tsv', 'xlsx', 'xls']);
```

This ensures `.tsv` files are categorized as `spreadsheet` by `getFileCategory()` consistently with the new `getToolbarFileType()` in `preview-utils.ts`.

### 11. Add `.jsonl` to `CODE_EXTENSIONS` in file-type-utils.ts

**File: `src/components/chat-file-preview/file-type-utils.ts`** (line 29)

The existing `CODE_EXTENSIONS` set includes `json` but not `jsonl`. Add it:

```typescript
const CODE_EXTENSIONS = new Set([
  'txt', 'json', 'jsonl', 'xml', 'html', /* ... rest unchanged ... */
]);
```

---

## Files to Modify (Summary)

| File | Change |
|------|--------|
| `src/types.ts` | Add `PreviewTab` interface |
| `src/components/preview-panel/preview-utils.ts` | **New** — `getTabIcon`, `getTabLabel`, `getToolbarFileType`, `getPreviewTabId` helpers |
| `src/components/preview-panel/preview-tabs.tsx` | **New** — `PreviewTabRow` component (Row 1) |
| `src/components/preview-panel/preview-toolbar.tsx` | **New** — `PreviewToolbar`, `ToolbarButton`, `AppToolbarActions`, `NotebookToolbarActions`, `ClickToCopyUrlBar`, `DownloadButton`, `triggerDownload` (Row 2) |
| `src/components/Chat.tsx` | Replace single `previewTarget` state with tab list + active tab; add per-tab state maps (including per-tab app loading); sync active tab changes back to DO; update `setAppIsPublic` to modify tab target; update `handleRealtimeSideChannelEvent`; replace `previewPanelBody` with new two-row layout; update ResizablePanel + mobile conditionals; open files externally via `/computer/:workspaceId?file=...` |
| `src/components/chat-file-preview/file-type-utils.ts` | Add `tsv` to `SPREADSHEET_EXTENSIONS`, add `jsonl` to `CODE_EXTENSIONS` |
| `src/components/chat-preview/preview-context.tsx` | No changes — API stays the same |
| `workers/main/src/durable-objects.ts` | No changes — server still stores single active target |

## Components Used

All of these shadcn components are already installed in `src/components/ui/`:

- `Button` — toolbar actions with `variant="ghost" size="icon-sm"` (size-6, icon size-3)
- `Tooltip` / `TooltipTrigger` / `TooltipContent` — hover labels for toolbar buttons
- `DropdownMenu` / `DropdownMenuTrigger` / `DropdownMenuContent` / `DropdownMenuItem` — download format picker (future), existing share status
- `Tabs` / `TabsList` / `TabsTrigger` — notebook Report/Notebook toggle in toolbar (using existing `variant="outline"`)
- `Separator` — vertical dividers between action groups
- `cn()` from `@/lib/utils` — conditional class merging

**Not installed but referenced in the original plan:** `toggle-group` — **not needed**. The notebook Report/Notebook toggle uses shadcn `Tabs` with `variant="outline"` (already in use, line 2712 of Chat.tsx).

**Lucide icons:** `RefreshCw`, `ExternalLink`, `X`, `Download`, `Bug`, `Globe`, `AppWindow`, `NotebookPen`, `Braces`, `FileText`, `FileCode`, `FileSpreadsheet`, `FileImage`, `File`

## Validation Checklist

- **Unit tests (`preview-utils`)**
  - `getPreviewTabId()` includes workspace/source/path for file IDs.
  - `getToolbarFileType()` returns expected values for `ipynb`, `md`, `txt`, `csv`, `tsv`, `json`, `jsonl`, `svg`, raster image, and fallback extensions.
- **Unit tests (`file-type-utils`)**
  - `.tsv` is categorized as `spreadsheet`.
  - `.jsonl` resolves to `code`/`text preview` path (not `other`).
- **Chat tab state behavior (component/integration test or manual in dev)**
  - Opening a second preview adds a tab and keeps the first tab available.
  - Selecting a different tab updates active content and sends `set_preview_target` with that tab’s target.
  - Closing the active tab activates neighbor tab and syncs new active target to DO.
  - Closing the last tab hides preview panel and syncs `target: null`.
  - Version-bump `preview_state` refreshes the correct tab key by tab ID (no reliance on current active tab).
- **Open External behavior**
  - App tab opens vanity URL.
  - File tabs open `/computer/:workspaceId?file=<encoded path>` in a new browser tab.
- **Regression checks**
  - Bug report still works from active app tab.
  - Public/Private status changes still update active app tab target.
  - Mobile chat/preview switch still works when tabs exist.

## Not in Scope

- **Server-side tab persistence** — Tab list is client-only. On reconnect, the server replays the last active target which becomes a single tab. This is intentional: tabs are ephemeral session state.
- **Format conversion downloads** — The download component supports multi-format dropdowns, but actual PDF/XLSX/PNG conversion requires server endpoints. Only original-format download is functional initially.
- **Tab reordering** — Tabs are in insertion order. Drag-to-reorder is not included.
- **Tab limit** — No maximum tab count. The horizontal scroll handles overflow.
- **Mobile tab UX** — Mobile still shows one preview at a time with the existing chat/preview slide switcher. Tabs are rendered but scroll may be tight on small screens — acceptable for now.
- **Keyboard shortcuts** — No Ctrl+W to close tab, no Ctrl+Tab to switch. Can be added later.
- **Inactive tab iframe persistence** — When switching tabs, inactive content (including app iframes) is unmounted. This simplifies state management at the cost of a reload when switching back. A future optimization could keep app iframes alive but hidden.
