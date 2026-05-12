# Preview Toolbar Standardization — Implementation Feedback

The implementation correctly lands the three-zone layout, splits open-elsewhere into `'app'` / `'computer'` / `null`, removes the dead `/api/.../uploads/...` and `/api/.../outputs/...` open-in-new-tab behavior, and replaces both text toggles with the shared `PreviewSourceToggle`. Structurally this is good. The notes below are visual polish + two small content/animation issues that need fixing before this ships.

---

## 1. (Accepted) Computer icon swapped to `AppWindowMac`

[preview-toolbar.tsx:85-95](src/components/preview-panel/preview-toolbar.tsx#L85-L95) uses `AppWindowMac` instead of `PanelsTopLeft` for the `'computer'` open-elsewhere kind. The intent — matching the sidebar's Computer icon — is correct. No change needed; just recording the deviation from the plan so it's traceable.

---

## 2. Toggle is too tall and visually flat

**File:** [src/components/preview-panel/preview-source-toggle.tsx](src/components/preview-panel/preview-source-toggle.tsx)

Two distinct issues in one component.

### 2a. Height inconsistency — toggle is 28px, every other toolbar element is 24px

The action row is **24px tall everywhere except the toggle**, where it jumps to 28px and introduces visible vertical padding around the pill. Quick audit:

| Element | Height |
|---|---|
| `Refresh`, `Open elsewhere`, `Bug`, `Download` (icon variant) — `ToolbarButton` uses `size="icon-sm"` → `size-6` | 24px |
| `ClickToCopyUrlBar`, `ClickToCopyFileChip` — `px-2 py-1` on text-xs content | ~24px |
| `ShareStatusButton` trigger — `h-6 px-2` | 24px |
| `DownloadButton` (notebook labeled variant) — `h-6 px-2` | 24px |
| **`PreviewSourceToggle` — `TabsList variant="outline" className="h-7"`** | **28px** |

The `h-7` on the `TabsList` plus the `outline` variant's intrinsic `p-0.5` and border push the toggle outside the 24px grid.

**Fix:** drop the toggle to h-6 to match the rest of the row. Two safe ways to do it:

Option A (smallest diff) — override outline variant padding so the outer container hits h-6 with inner h-5 triggers:

```tsx
// preview-source-toggle.tsx
<TabsList variant="outline" className="h-6 p-0">
  …
  <TabsTrigger value="preview" className="h-6 w-7 p-0 rounded-[5px]" aria-label="Preview">
    <PreviewIcon className="h-3.5 w-3.5" />
  </TabsTrigger>
  <TabsTrigger value="source" className="h-6 w-7 p-0 rounded-[5px]" aria-label="Source code">
    <Code2 className="h-3.5 w-3.5" />
  </TabsTrigger>
</TabsList>
```

Option B — accept a 1px outer border bump and use `h-6` with the variant's default `p-0.5`, then shrink triggers to `h-[20px]`. Slightly more fiddly; Option A is preferred.

Either way, verify against `ClickToCopyFileChip` (also nominally 24px) — they should sit on the exact same baseline and read as the same height visually. Use the dev tools box model to confirm.

### 2b. Visual design — match the file chip, then lift the active state

Looking at the current state in dark mode: the toggle trough is so faint it reads as a different visual primitive than the adjacent file chip, and both icons look identical in opacity so you can't tell which is selected. The whole control is fighting itself.

**Design principle:** the toggle and the file chip are peers in the toolbar — they should share visual language. Match the chip's background exactly for the trough. Then the active trigger lifts cleanly out of that shared trough using background opacity (light mode) or a foreground overlay (dark mode). No border, no ring, no shadow.

Reference values from the chip ([preview-toolbar.tsx:209-210](src/components/preview-panel/preview-toolbar.tsx#L209-L210)): `bg-muted/50`, `rounded-md`, hover `bg-muted`. The toggle adopts the same trough shade and the same radius so the two controls read as one family.

**Full spec — replace the current `PreviewSourceToggle` body with this:**

```tsx
// src/components/preview-panel/preview-source-toggle.tsx
import { Code2 } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { PreviewTarget } from '@/types';
import { getTabIcon } from './preview-utils';

export type PreviewSourceMode = 'preview' | 'source';

interface Props {
  target: PreviewTarget;
  value: PreviewSourceMode;
  onChange: (mode: PreviewSourceMode) => void;
}

const triggerClasses = cn(
  // sizing — sits on the 24px toolbar baseline
  'h-[22px] w-7 rounded-[4px] p-0 transition-colors',
  // inactive — muted icon on a transparent trigger so the trough shows through
  'text-muted-foreground hover:text-foreground',
  // active — lifts out of the shared trough by becoming more opaque
  'data-active:bg-background data-active:text-foreground',
  'dark:data-active:bg-foreground/10 dark:data-active:text-foreground'
);

export function PreviewSourceToggle({ target, value, onChange }: Props) {
  const PreviewIcon = getTabIcon(target);
  return (
    <Tabs
      value={value}
      onValueChange={(v) => { if (v === 'preview' || v === 'source') onChange(v); }}
      className="shrink-0 gap-0"
    >
      <TabsList
        variant="outline"
        className="h-6 rounded-md border-transparent bg-muted/50 p-px"
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <TabsTrigger value="preview" className={triggerClasses} aria-label="Preview">
              <PreviewIcon className="h-3.5 w-3.5" />
            </TabsTrigger>
          </TooltipTrigger>
          <TooltipContent>Preview</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <TabsTrigger value="source" className={triggerClasses} aria-label="Source code">
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

**Why each piece is the way it is:**

- **Trough = `bg-muted/50`.** Exactly the chip's default background. Side-by-side, the toggle and the chip now share the same fill — they read as one visual family.
- **Trough = `border-transparent`.** The outline variant's border was competing with the toolbar's own `border-b` and adding chunk. Kill it.
- **Trough = `rounded-md`.** Matches the chip's radius. They feel like the same kind of object.
- **Trough = `h-6 p-px`.** Outer container is 24px, same as every other element in the row. `p-px` gives the triggers a hairline of breathing room without bumping the outer height; combined with `h-[22px]` triggers the math works to exactly 24px.
- **Active light-mode bg = `bg-background` (white).** Brightest possible value on a white-leaning page. Pops cleanly off the `bg-muted/50` trough.
- **Active dark-mode bg = `bg-foreground/10`.** A 10% white overlay. In dark mode, `bg-background` would be *darker* than the trough (recessed look — wrong), so we invert: a translucent light overlay rises off the dark trough. Tune to `/15` if `/10` reads as too subtle in your monitor calibration.
- **Inactive icon = `text-muted-foreground`.** Standard muted color — visible, not washed out. Don't push lower than this; you walked back the `/40` for good reason.
- **Active icon = `text-foreground`.** Full strength. The contrast between `text-muted-foreground` (inactive) and `text-foreground` (active) is a real, perceivable second contrast channel on top of the background lift — but neither value is so extreme that it looks broken or ghosted.
- **Hover = `text-foreground` on the inactive trigger.** Gives the inactive side a "you can click me" cue without competing with the active state.

**Visual target:** standing next to the file chip, the toggle should look like a sibling — same trough color, same radius, same height. The active half is the only thing that breaks out of that shared trough, and it does so by being *more opaque*, not by gaining a border. Test light and dark side-by-side and verify the active state is identifiable from across the room.

> If `cn(...)` merging fights the base `TabsTrigger` CVA (it shouldn't — the conflicting properties are all `data-active:`-scoped and Tailwind JIT keeps the latest one in default ordering), inline the trigger as a styled `<TabsPrimitive.Trigger>` from `radix-ui` directly inside this file rather than importing the wrapped one. Cleaner than fighting class precedence.

---

## 3. File chip copy interaction — content shifts and uses the wrong icon

**File:** [preview-toolbar.tsx:168-228](src/components/preview-panel/preview-toolbar.tsx#L168-L228) (`ClickToCopyFileChip`)

Three problems in one component:

### 3a. Filename text gets replaced with `Copied!` on click → chip shrinks

```tsx
// preview-toolbar.tsx:214-217 (current)
<span className="truncate text-muted-foreground">
  {copied ? 'Copied!' : displayName}
</span>
```

Because the truncate span sizes to its content, swapping `"my-long-analysis-file.ipynb"` for `"Copied!"` collapses the chip's intrinsic width. The user reads this as the whole chip "shrinking." The filename should stay visible at all times — copying a path shouldn't make the user lose visual reference to what they just copied.

**Fix:** keep the filename text static. Only the hint slot to its right changes.

### 3b. The "Copy" hover hint should become a green check on click — not the filename text

Right now:
- Hover → `"Copy"` hint fades in to the right of the filename
- Click → entire filename becomes `"Copied!"` and the hint disappears

Desired:
- Hover → `"Copy"` hint fades in
- Click → that slot swaps to a green check icon (and the filename stays put)
- After 1.5s → returns to hover state

**Fix:** reserve a fixed-width slot to the right of the filename so the swap doesn't cause any layout shift, and render either the hover label or the check icon into it. Sketch:

```tsx
// import { Check } from 'lucide-react';

<span
  className={cn(
    'flex h-3 w-3 shrink-0 items-center justify-center',
    !copied && 'opacity-0 transition-opacity group-hover/file:opacity-100'
  )}
  aria-hidden
>
  {copied ? (
    <Check className="h-3 w-3 text-green-500" />
  ) : (
    <span className="text-[10px] text-muted-foreground/60">Copy</span>
  )}
</span>
```

Notes:
- The slot is fixed-size (`h-3 w-3`) so the chip never re-flows. Use a width that fits both the `"Copy"` text and the check icon comfortably — `w-3` is a starting guess; `w-8` may be needed for the text to render without clipping. Test both states and pick the smallest width that fits.
- `aria-live="polite"` on the slot, with the check getting an `aria-label="Copied to clipboard"`, would be nice for screen readers.
- Drop the `bg-green-500/10` background pulse — it's no longer needed because the green check carries the success signal.

### 3c. Use the file-type icon, not generic `FileText`

[preview-toolbar.tsx:214](src/components/preview-panel/preview-toolbar.tsx#L214):

```tsx
<FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
```

The chip should use the **same icon the tab bar and toggle use** for that file type. The single source of truth is `getTabIcon` from [preview-utils.ts:52-71](src/components/preview-panel/preview-utils.ts#L52-L71) — already imported by `PreviewSourceToggle`. Reuse it here.

```tsx
import { getTabIcon } from './preview-utils';

function ClickToCopyFileChip({ target }: { target: Extract<PreviewTarget, { kind: 'file' }> }) {
  const FileIcon = getTabIcon(target);
  // …
  <FileIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
}
```

This gives `NotebookPen` for `.ipynb`, `FileSpreadsheet` for `.csv`, etc. — and inherits any future tab-icon changes automatically. Remove the now-unused `FileText` import from this file if nothing else in the toolbar needs it.

---

## 4. Apply the same chip fixes to `ClickToCopyUrlBar`

**File:** [preview-toolbar.tsx:101-162](src/components/preview-panel/preview-toolbar.tsx#L101-L162)

The URL chip has the identical "swap text on copy → chip shrinks" pattern ([line 150](src/components/preview-panel/preview-toolbar.tsx#L150)). The user only called out the file chip, but the URL chip should get the same treatment for consistency:

- Keep `displayHost` visible at all times (don't replace with `"Copied!"`).
- Hover hint slot swaps from `"Copy"` → green check on click, fixed width, no chip resize.
- Drop the `bg-green-500/10` pulse if the check is sufficient.

URL chip icon (`Globe`) stays — apps don't have a per-file-type icon, and `Globe` is already the right semantic match for "live URL." Don't change it.

---

## 5. Sanity checklist after these fixes

- [ ] All elements in the action row sit on the same 24px baseline. Drag the dev-tools ruler across the row — no element pokes above or below.
- [ ] Toggle active state is obvious at a glance, in both light and dark modes.
- [ ] Clicking the file chip leaves the filename text in place; only a small green check appears on the right.
- [ ] Clicking the URL chip leaves the host in place; same green check behavior.
- [ ] No visible width change on either chip during the click → 1.5s → reset cycle.
- [ ] File chip icon matches the active tab's icon for every covered file type (test at minimum: `.ipynb`, `.md`, `.csv`, `.json`, `.py`, `.png`).
- [ ] Keyboard: tabbing through the toolbar still hits each control once; arrow keys still move between toggle halves.

---

## What was implemented correctly (no action needed)

- Three-zone layout: refresh + toggle (left) → identity chip (center, flex-1) → open-elsewhere + share + bug + download (right).
- Open-elsewhere ordering: first child in the right zone, immediately after the center chip. Matches the agreed principle.
- `OpenElsewhereButton` correctly returns `null` for `kind === null`, so upload-source and output-source files render no button.
- `fileExternalOpenUrl` returns `""` for non-workspace sources; raw `/api/.../uploads/...` and `/api/.../outputs/...` URLs are no longer generated.
- `handlePreviewOpenElsewhere` has a redundant-but-defensive `source !== "workspace"` guard. Fine to keep.
- `onBugReportOpen` is now optional and gated on `readOnly` at the callsite — matches the original admin-only intent.
- All four `*ToolbarActions` sub-components were deleted as planned; the unified render is in place.
- `Tabs` / `TabsList` / `TabsTrigger` imports removed from `preview-toolbar.tsx`. Toggle owns those now.
- Tests file ([tests/preview-toolbar-notebook-download.test.tsx](tests/preview-toolbar-notebook-download.test.tsx)) was updated alongside — verify the changes there still cover the notebook download path after these toggle/chip fixes; no new test changes expected from this round.
