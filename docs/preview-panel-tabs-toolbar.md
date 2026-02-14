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

Each file type gets a distinct icon from Lucide. These replace the colored dots.

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

- **Refresh**: Reloads iframe (`setIframeKey(prev => prev + 1)`)
- **URL bar**: Non-editable field showing vanity domain (e.g. `my-dashboard--org.chiridion.app`). Styled like a mini browser URL bar: `bg-muted/50 rounded-md px-2 py-1 text-xs font-mono text-muted-foreground truncate`. On click, copies full URL (with `https://` prefix) to clipboard. Brief "Copied!" flash — field background pulses `bg-green-500/10` for ~1.5s then resets. Show a subtle "Copy" label on hover (`opacity-0 group-hover:opacity-100 text-[10px]`)
- **Public/Private**: Existing `ShareStatusButton` — no changes
- **Bug report**: Existing bug button — no changes
- **Open in new tab**: Opens `appPreviewVanityUrl` via `window.open()`

**Notebook (.ipynb)**
```
[ ↻ Refresh ] │ [ Report │ Notebook ] │ [ ↓ Download ▾ ] ──────── [ ⧉ Open ]
```

- **Refresh**: Re-fetches notebook (`setFilePreviewKey(prev => prev + 1)`)
- **Report / Notebook toggle**: Existing segmented control (shadcn `Tabs` with `variant="outline"`) — move from Row 1 to Row 2. Same implementation: `TabsList variant="outline" className="h-7"`, `TabsTrigger className="h-6 px-3 text-xs"`
- **Download**: Single download icon button (`Download` icon). Click opens a `DropdownMenu`:
  - "Download as PDF"
  - "Download notebook (.ipynb)"
- **Open in new tab**: Opens file in computer tab

**Markdown (.md)**
```
[ ↻ Refresh ] │ [ ↓ Download ▾ ] ──────────────────────── [ ⧉ Open ]
```

- **Download**: Click opens `DropdownMenu`:
  - "Download as PDF"
  - "Download markdown (.md)"

**Text (.txt)**
```
[ ↻ Refresh ] │ [ ↓ Download ] ────────────────────────── [ ⧉ Open ]
```

- **Download**: Direct download (no submenu — single format)

**Spreadsheet (.csv, .tsv)**
```
[ ↻ Refresh ] │ [ ↓ Download ▾ ] ──────────────────────── [ ⧉ Open ]
```

- **Download** submenu:
  - "Download CSV" (or "Download TSV" — matches original format)
  - "Download as Excel (.xlsx)"

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
[ ↻ Refresh ] │ [ ↓ Download ▾ ] ──────────────────────── [ ⧉ Open ]
```

- **Download** submenu:
  - "Download SVG"
  - "Download as PNG"

**Raster images (.png, .jpg, etc.)**
```
[ ↻ Refresh ] │ [ ↓ Download ] ────────────────────────── [ ⧉ Open ]
```

- **Download**: Direct download (no submenu)

### Download Button Behavior

The download button is always just the `Download` icon — no caret, no chevron, no visual indicator that it's a dropdown. The user clicks, and:
- If single format → immediate download
- If multiple formats → `DropdownMenu` appears below with options

Downloads use the existing `filePreviewOpenUrl` (the `/api/workspaces/:id/fs/content/*` endpoint) with appropriate download headers. For format conversions (PDF, XLSX, PNG), the initial implementation should download the original format only. Format conversion can be added later as a separate feature.

### Open in New Tab Behavior

- **Live apps**: `window.open(appPreviewVanityUrl, '_blank')`
- **All files**: `window.open(filePreviewOpenUrl, '_blank')` — opens the raw file content URL

---

## Implementation

### 1. Define tab state types and extend `PreviewTarget`

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

No changes needed to the existing `PreviewTarget` type.

### 2. Create the preview panel tab/toolbar components

**New file: `src/components/preview-panel/preview-tabs.tsx`**

This component renders the full two-row header (tab row + action toolbar).

```typescript
interface PreviewTabsProps {
  tabs: PreviewTab[];
  activeTabId: string;
  onTabSelect: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  /** Action toolbar props — passed through to active tab's toolbar */
  toolbarProps: PreviewToolbarProps;
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

The download button renders as a plain icon. If the file type has multiple download formats, it opens a `DropdownMenu`. Otherwise it triggers a direct download.

```tsx
function DownloadButton({ activeTarget, filePreviewOpenUrl }: {
  activeTarget: PreviewTarget;
  filePreviewOpenUrl?: string;
}) {
  const formats = getDownloadFormats(activeTarget);
  const downloadUrl = activeTarget.kind === 'file' ? filePreviewOpenUrl : undefined;

  if (!downloadUrl) return null;

  // Single format: direct download
  if (formats.length <= 1) {
    return (
      <ToolbarButton
        icon={Download}
        tooltip="Download"
        onClick={() => triggerDownload(downloadUrl, formats[0]?.filename)}
      />
    );
  }

  // Multiple formats: dropdown
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

```typescript
function getDownloadFormats(target: PreviewTarget): { label: string; filename?: string }[] {
  if (target.kind === 'app') return [];

  const ext = getFileExtension(target.path).toLowerCase();
  const name = target.filename || target.path.split('/').pop() || 'file';

  switch (ext) {
    case 'ipynb':
      return [
        { label: 'Download as PDF', filename: name.replace(/\.ipynb$/, '.pdf') },
        { label: 'Download notebook (.ipynb)', filename: name },
      ];
    case 'md':
      return [
        { label: 'Download as PDF', filename: name.replace(/\.md$/, '.pdf') },
        { label: 'Download markdown (.md)', filename: name },
      ];
    case 'csv':
      return [
        { label: 'Download CSV', filename: name },
        { label: 'Download as Excel (.xlsx)', filename: name.replace(/\.csv$/, '.xlsx') },
      ];
    case 'tsv':
      return [
        { label: 'Download TSV', filename: name },
        { label: 'Download as Excel (.xlsx)', filename: name.replace(/\.tsv$/, '.xlsx') },
      ];
    case 'svg':
      return [
        { label: 'Download SVG', filename: name },
        { label: 'Download as PNG', filename: name.replace(/\.svg$/, '.png') },
      ];
    default:
      return [{ label: `Download ${ext.toUpperCase() || 'file'}`, filename: name }];
  }
}
```

**Note on format conversion:** The download submenu items for converted formats (PDF, XLSX, PNG) should initially just download the original file. True format conversion requires server-side work (Puppeteer for PDF, a library for XLSX, resvg for SVG→PNG) that is out of scope for this plan. The submenu structure is put in place now so the UI is ready. When conversion endpoints exist, the `triggerDownload` calls simply point at different URLs. Until then, only the "Download original" option should be functional — conversion options should either be hidden or shown as disabled with a "(coming soon)" note.

**Recommended approach for the initial build:** Only show download formats that can actually be served right now. This means single-format download for all types (the original file). The multi-format dropdown structure exists in code and can be enabled per-type as conversion endpoints are added. This avoids showing broken menu items.

### 6. Create helper: `getTabIcon` and `getTabLabel`

**Add to: `src/components/preview-panel/preview-utils.ts`**

```typescript
import { AppWindow, FileText, NotebookPen, FileSpreadsheet, Braces, FileCode, FileImage, File } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { PreviewTarget } from '@/types';
import { getFileExtension } from '@/components/chat-file-preview/file-type-utils';

export function getTabIcon(target: PreviewTarget): LucideIcon {
  if (target.kind === 'app') return AppWindow;

  const ext = getFileExtension(target.path).toLowerCase();

  // Specific overrides beyond file-type-utils categories
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
  return `file:${target.source}:${target.path}`;
}
```

### 7. Add tab state management to Chat.tsx

**File: `src/components/Chat.tsx`**

Replace the single `previewTarget` state with a tab list + active tab:

**New state (replaces lines ~717–725):**

```typescript
// ── Preview tab state ──
const [previewTabs, setPreviewTabs] = useState<PreviewTab[]>(() => {
  if (!initialPreviewTarget) return [];
  return [{ id: getPreviewTabId(initialPreviewTarget), target: initialPreviewTarget }];
});
const [activeTabId, setActiveTabId] = useState<string | null>(() => {
  return initialPreviewTarget ? getPreviewTabId(initialPreviewTarget) : null;
});
const previewTabsRef = useRef(previewTabs);
const activeTabIdRef = useRef(activeTabId);

// Derived: the active tab's target (replaces old previewTarget)
const activeTab = useMemo(
  () => previewTabs.find((t) => t.id === activeTabId) ?? null,
  [previewTabs, activeTabId]
);
const previewTarget = activeTab?.target ?? null;

// Keep existing refs in sync
const previewTargetRef = useRef<PreviewTarget | null>(previewTarget);
useEffect(() => { previewTargetRef.current = previewTarget; }, [previewTarget]);
useEffect(() => { previewTabsRef.current = previewTabs; }, [previewTabs]);
useEffect(() => { activeTabIdRef.current = activeTabId; }, [activeTabId]);

// Existing state that stays unchanged:
const [iframeKey, setIframeKey] = useState(0);
const [filePreviewKey, setFilePreviewKey] = useState(0);
const [notebookViewMode, setNotebookViewMode] = useState<'report' | 'notebook'>('report');
const [previewLoading, setPreviewLoading] = useState(false);
const [mobileView, setMobileView] = useState<'chat' | 'preview'>('chat');
const previewVersionRef = useRef<number>(0);
```

**Tab operations (new callbacks):**

```typescript
/** Open a target as a tab. If the same target is already a tab, just activate it. */
const openTabForTarget = useCallback((target: PreviewTarget) => {
  const id = getPreviewTabId(target);
  setPreviewTabs((prev) => {
    const existing = prev.find((t) => t.id === id);
    if (existing) {
      // Update the target data (e.g. isPublic may have changed)
      return prev.map((t) => (t.id === id ? { ...t, target } : t));
    }
    return [...prev, { id, target }];
  });
  setActiveTabId(id);
}, []);

const closeTab = useCallback((tabId: string) => {
  setPreviewTabs((prev) => {
    const idx = prev.findIndex((t) => t.id === tabId);
    if (idx === -1) return prev;
    const next = prev.filter((t) => t.id !== tabId);
    // If closing the active tab, activate the nearest neighbor
    if (tabId === activeTabIdRef.current) {
      if (next.length === 0) {
        setActiveTabId(null);
        setMobileView('chat');
      } else {
        const newIdx = Math.min(idx, next.length - 1);
        setActiveTabId(next[newIdx].id);
      }
    }
    return next;
  });
}, []);

const selectTab = useCallback((tabId: string) => {
  setActiveTabId(tabId);
}, []);
```

**Update `setPreviewTargetForThread`:**

The existing function sends a WebSocket message to ChatThreadDO to persist the "active" preview target. With tabs, this now just persists whichever target is active. The tab list itself is client-only state — not persisted server-side. On reconnect, the server replays the last active target and that becomes the single initial tab.

```typescript
const setPreviewTargetForThread = useCallback((target: PreviewTarget | null) => {
  if (!threadId) return;
  const socket = wsRef.current;
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    if (target === null) {
      // Close all tabs
      setPreviewTabs([]);
      setActiveTabId(null);
      setPreviewLoading(false);
      return;
    }
    toast.error('Preview is unavailable while reconnecting.');
    return;
  }

  socket.send(JSON.stringify({ type: 'set_preview_target', target, threadId }));

  if (target) {
    openTabForTarget(target);
    if (target.kind === 'app') {
      setPreviewLoading(true);
      setIframeKey((prev) => prev + 1);
    } else {
      setPreviewLoading(false);
    }
  }
  // Note: target=null from agent clears server state but doesn't close tabs
}, [threadId, openTabForTarget]);
```

**Update `openPreviewTarget`:**

```typescript
const openPreviewTarget = useCallback((target: PreviewTarget) => {
  setPreviewTargetForThread(target);
  setMobileView('preview');
}, [setPreviewTargetForThread]);
```

**Update `clearPreviewTarget`:**

This is now "close all tabs" — called when the user wants to dismiss the preview panel entirely:

```typescript
const clearPreviewTarget = useCallback(() => {
  setPreviewTargetForThread(null);
  setPreviewTabs([]);
  setActiveTabId(null);
  setMobileView('chat');
}, [setPreviewTargetForThread]);
```

**Update `handleRealtimeSideChannelEvent` for `preview_state`:**

When the server broadcasts a new preview target (e.g. Claude sets a new file preview via MCP), open it as a new tab:

```typescript
if (data.type === 'preview_state') {
  const nextTarget = coercePreviewTarget(data.target);
  const newVersion = typeof data.version === 'number' ? data.version : 0;
  const hasVersionBump = newVersion > previewVersionRef.current;
  previewVersionRef.current = newVersion;

  if (nextTarget) {
    openTabForTarget(nextTarget);

    const nextId = getPreviewTabId(nextTarget);
    const currentId = activeTabIdRef.current;
    const currentTarget = previewTargetRef.current;
    const isSameItem = currentId === nextId;

    if (nextTarget.kind === 'app' && hasVersionBump) {
      // App deploy refresh logic (existing)
      if (iframeRefreshTimeoutRef.current) clearTimeout(iframeRefreshTimeoutRef.current);
      setPreviewLoading(true);
      iframeRefreshTimeoutRef.current = setTimeout(() => {
        setPreviewLoading(false);
        setIframeKey((prev) => prev + 1);
        iframeRefreshTimeoutRef.current = null;
      }, 1500);
    } else if (nextTarget.kind === 'file' && isSameItem && hasVersionBump) {
      setFilePreviewKey((prev) => prev + 1);
      setPreviewLoading(false);
    } else {
      setPreviewLoading(false);
    }
  } else {
    // Server cleared the preview target — don't close tabs, just update server state tracking
    setPreviewLoading(false);
  }
  return;
}
```

**Thread change reset (update the effect at ~line 756):**

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
  previewVersionRef.current = 0;
}, [threadId, initialPreviewTarget]);
```

### 8. Update `ChatPreviewProvider` context

**File: `src/components/chat-preview/preview-context.tsx`**

No changes needed — `openPreviewTarget` and `clearPreviewTarget` still work the same way from the consumer's perspective. The internal implementation change (opening a tab vs. setting a single target) is transparent.

### 9. Replace `previewPanelBody` in Chat.tsx

**File: `src/components/Chat.tsx`**

Replace the current `previewPanelBody` block (~lines 2604–2787) with a unified structure that delegates to the new components:

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
          setIframeKey((prev) => prev + 1);
        } else {
          setFilePreviewKey((prev) => prev + 1);
        }
      }}
      onOpenExternal={() => {
        if (previewTarget.kind === 'app') {
          window.open(appPreviewVanityUrl, '_blank');
        } else {
          window.open(filePreviewOpenUrl, '_blank');
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
      onNotebookViewModeChange={(mode) => setNotebookViewMode(mode)}
      filePreviewOpenUrl={filePreviewOpenUrl}
    />

    {/* Content area */}
    <div className="flex-1 min-h-0 overflow-hidden">
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

**Important:** The `ResizablePanel` conditional (`previewTarget &&`) should now check `previewTabs.length > 0` instead:

```tsx
{previewTabs.length > 0 && (
  <>
    <ResizableHandle withHandle />
    <ResizablePanel ...>
      {previewPanelBody}
    </ResizablePanel>
  </>
)}
```

Same for the mobile view conditional — replace `previewTarget` checks with `previewTabs.length > 0`.

### 10. Update `file-type-utils.ts` icon mapping

**File: `src/components/chat-file-preview/file-type-utils.ts`**

The existing `getFileIcon()` returns `FileCode` for notebooks. This is fine for the general file card use case, but the new tab icons use a separate `getTabIcon()` in `preview-utils.ts` that returns `NotebookPen`. No changes needed to `file-type-utils.ts`.

### 11. Handle per-tab state isolation

Each tab needs its own refresh key and (for notebooks) view mode. Currently these are single values. Refactor to per-tab maps:

**In Chat.tsx state:**

```typescript
// Per-tab state maps (keyed by tab ID)
const [tabIframeKeys, setTabIframeKeys] = useState<Record<string, number>>({});
const [tabFilePreviewKeys, setTabFilePreviewKeys] = useState<Record<string, number>>({});
const [tabNotebookViewModes, setTabNotebookViewModes] = useState<Record<string, 'report' | 'notebook'>>({});

// Helpers to get per-active-tab values
const iframeKey = activeTabId ? (tabIframeKeys[activeTabId] ?? 0) : 0;
const filePreviewKey = activeTabId ? (tabFilePreviewKeys[activeTabId] ?? 0) : 0;
const notebookViewMode = activeTabId ? (tabNotebookViewModes[activeTabId] ?? 'report') : 'report';

// Refresh helpers
const refreshActiveIframe = useCallback(() => {
  if (!activeTabId) return;
  setTabIframeKeys((prev) => ({ ...prev, [activeTabId]: (prev[activeTabId] ?? 0) + 1 }));
}, [activeTabId]);

const refreshActiveFilePreview = useCallback(() => {
  if (!activeTabId) return;
  setTabFilePreviewKeys((prev) => ({ ...prev, [activeTabId]: (prev[activeTabId] ?? 0) + 1 }));
}, [activeTabId]);

const setActiveNotebookViewMode = useCallback((mode: 'report' | 'notebook') => {
  if (!activeTabId) return;
  setTabNotebookViewModes((prev) => ({ ...prev, [activeTabId]: mode }));
}, [activeTabId]);
```

When a tab is closed, clean up its entries from these maps:

```typescript
const closeTab = useCallback((tabId: string) => {
  setPreviewTabs((prev) => { /* ... same as before ... */ });
  // Clean up per-tab state
  setTabIframeKeys((prev) => { const { [tabId]: _, ...rest } = prev; return rest; });
  setTabFilePreviewKeys((prev) => { const { [tabId]: _, ...rest } = prev; return rest; });
  setTabNotebookViewModes((prev) => { const { [tabId]: _, ...rest } = prev; return rest; });
}, []);
```

---

## Files to Modify (Summary)

| File | Change |
|------|--------|
| `src/types.ts` | Add `PreviewTab` interface |
| `src/components/preview-panel/preview-utils.ts` | **New** — `getTabIcon`, `getTabLabel`, `getToolbarFileType`, `getPreviewTabId` helpers |
| `src/components/preview-panel/preview-tabs.tsx` | **New** — `PreviewTabRow` component (Row 1) |
| `src/components/preview-panel/preview-toolbar.tsx` | **New** — `PreviewToolbar`, `ToolbarButton`, `ClickToCopyUrlBar`, `DownloadButton` components (Row 2) |
| `src/components/Chat.tsx` | Replace single `previewTarget` state with tab list + active tab; replace `previewPanelBody` with new two-row layout; update all preview state callbacks |
| `src/components/chat-preview/preview-context.tsx` | No changes — API stays the same |
| `src/components/chat-file-preview/file-type-utils.ts` | No changes needed |
| `workers/main/src/durable-objects.ts` | No changes — server still stores single active target |

## Components Used

- `Button` (shadcn) — toolbar actions with `variant="ghost" size="icon-sm"`
- `Tooltip` / `TooltipTrigger` / `TooltipContent` (shadcn) — hover labels for toolbar buttons
- `DropdownMenu` / `DropdownMenuTrigger` / `DropdownMenuContent` / `DropdownMenuItem` (shadcn) — download format picker, existing share status
- `Tabs` / `TabsList` / `TabsTrigger` (shadcn) — notebook Report/Notebook toggle in toolbar
- `Separator` (shadcn) — vertical dividers between action groups
- `cn()` from `@/lib/utils` — conditional class merging
- Lucide icons: `RefreshCw`, `ExternalLink`, `X`, `Download`, `Bug`, `Globe`, `Lock`, `AppWindow`, `NotebookPen`, `Braces`, `FileText`, `FileCode`, `FileSpreadsheet`, `FileImage`, `File`

## Not in Scope

- **Server-side tab persistence** — Tab list is client-only. On reconnect, the server replays the last active target which becomes a single tab. This is intentional: tabs are ephemeral session state.
- **Format conversion downloads** — The download submenu structure is built, but actual PDF/XLSX/PNG conversion requires server endpoints. Only original-format download is functional initially. Show only the formats that work.
- **Tab reordering** — Tabs are in insertion order. Drag-to-reorder is not included.
- **Tab limit** — No maximum tab count. The horizontal scroll handles overflow.
- **Mobile tab UX** — Mobile still shows one preview at a time with the existing chat/preview slide switcher. Tabs are rendered but scroll may be tight on small screens — acceptable for now.
- **Keyboard shortcuts** — No Ctrl+W to close tab, no Ctrl+Tab to switch. Can be added later.
