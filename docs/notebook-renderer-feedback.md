# Notebook Renderer — Revision Feedback

Four issues to address, ordered by priority.

---

## 1. Remove the Wrapper Container — Notebooks Should Fill the Full Preview Area

**Problem:** The `NotebookPreview` root element in `index.tsx` wraps everything in a bordered, rounded, padded container (`rounded-md border bg-muted/20`). This creates a box-inside-a-box effect — the preview panel already *is* the container. The notebook content should use all available space.

On top of that, `Chat.tsx` line 2775 wraps `FilePreviewContent` in `<div className="flex-1 min-h-0 overflow-hidden p-3">` — that `p-3` padding further shrinks the available area. For notebooks specifically, this extra padding should be removed.

**Fix — `index.tsx` (lines 20–26):**

Replace the wrapper div:
```tsx
// BEFORE
<div
  data-notebook-scroll-root="true"
  className={cn(
    'overflow-auto rounded-md border bg-muted/20',
    layout === 'panel' ? 'h-full max-h-full' : 'max-h-[60vh]'
  )}
>
```

With a borderless, background-less container:
```tsx
// AFTER
<div
  data-notebook-scroll-root="true"
  className={cn(
    'overflow-auto',
    layout === 'panel' ? 'h-full max-h-full' : 'max-h-[60vh]'
  )}
>
```

**Fix — `Chat.tsx` line 2775:**

Make the padding conditional — remove it for notebook previews so the notebook content controls its own padding:
```tsx
// BEFORE
<div className="flex-1 min-h-0 overflow-hidden p-3">

// AFTER
<div className={cn("flex-1 min-h-0 overflow-hidden", !isNotebookPreview && "p-3")}>
```

This way, the report mode's own `px-4 py-6` and notebook mode's own `p-3` become the sole sources of padding, and there's no double-padding.

---

## 2. Table of Contents Should Be Sticky *Within* the Scroll Container and Responsive to Panel Width

Two subproblems here.

### 2a. Sticky positioning is anchored to the wrong scroll context

The sidebar has `sticky top-4`, but the notebook renders inside a scroll container (the `overflow-auto` div with `data-notebook-scroll-root`). CSS `position: sticky` works relative to the nearest scrolling ancestor. Currently this *should* work since the notebook scroll root is that ancestor — but the sidebar's `top-4` (16px) may be too small. It should stick to the top of the scrollable area, clearing the panel header.

Verify that the sidebar actually sticks when scrolling the report. If the entire report (including sidebar) scrolls together, it means the sidebar is not a direct child of the scroll container at the right level. The layout in `report-mode.tsx` is:

```
<div class="flex gap-8 px-4 py-6">     ← this is the flex row
  <ReportSidebar />                      ← sticky element
  <div class="min-w-0 max-w-3xl flex-1"> ← content column
```

This structure is correct for sticky — the sidebar is a flex child alongside the content column, and the parent scrolls. **But** the sidebar needs `self-start` so it doesn't stretch to match the content column's height (which would prevent sticking):

```tsx
// report-sidebar.tsx line 49
// BEFORE
<nav className="sticky top-4 hidden w-44 shrink-0 pt-2 lg:block">

// AFTER
<nav className="sticky top-4 hidden w-44 shrink-0 self-start pt-2 lg:block">
```

Without `self-start` (or `align-self: flex-start`), the nav stretches to the height of the flex row and `sticky` has no room to "stick" because the element is already as tall as its container.

### 2b. Responsive behavior for narrow panel widths

The sidebar uses `hidden lg:block` — but the `lg:` breakpoint (1024px) is based on the *viewport* width, not the *panel* width. The preview panel can be resized to be quite narrow even on a wide screen. A 50% split on a 1440px monitor gives a ~720px panel — well below `lg:` — but the user likely still has plenty of room for a sidebar.

The right approach is a **container query** instead of a media query. This lets the sidebar respond to the *panel's* width, not the viewport's.

**Fix — `index.tsx`:**

Add a container query context on the notebook scroll root:
```tsx
<div
  data-notebook-scroll-root="true"
  className={cn(
    '@container overflow-auto',
    layout === 'panel' ? 'h-full max-h-full' : 'max-h-[60vh]'
  )}
>
```

**Fix — `report-sidebar.tsx` line 49:**

Switch from viewport breakpoint to container query breakpoint. Tailwind v4 supports `@` container variants natively:
```tsx
// BEFORE
<nav className="sticky top-4 hidden w-44 shrink-0 self-start pt-2 lg:block">

// AFTER
<nav className="sticky top-4 hidden w-44 shrink-0 self-start pt-2 @3xl:block">
```

`@3xl` corresponds to a container width of 768px. So the sidebar appears when the *notebook panel itself* is at least 768px wide, regardless of viewport size. On narrower panels, it hides.

The content column in `report-mode.tsx` should also gain a bit more horizontal padding on narrow widths to compensate for the missing sidebar:

```tsx
// report-mode.tsx line 66
// BEFORE
<div className="notebook-report flex gap-8 px-4 py-6">

// AFTER
<div className="notebook-report flex gap-8 px-6 py-6 @3xl:px-4">
```

This gives slightly more breathing room on narrow panels where the sidebar is hidden.

---

## 3. Charts and HTML Outputs Need Flexible Height

**Problem:** Every HTML output (including Plotly charts) is given a fixed height: `h-[420px]` for panel layout, `h-[360px]` for dialog. When a cell produces multiple charts, or when a chart is inherently tall (e.g., a stacked subplots figure), content gets clipped or has excessive whitespace.

**Root cause:** `html-output.tsx` lines 40–43 apply a fixed height class to every iframe:
```tsx
layout === 'panel' ? 'h-[420px]' : 'h-[360px]'
```

**Fix — use `aspect-ratio` with a min-height instead of a fixed height:**

The challenge with iframes is that they can't auto-size to their content (cross-origin restriction with `sandbox`). But we can do better than one fixed height for all charts.

**Approach A — Aspect-ratio based (recommended):**

Replace the fixed height with a responsive aspect ratio that gives charts a reasonable default shape, plus a min-height so tiny charts don't collapse:

```tsx
// html-output.tsx — iframe className
// BEFORE
layout === 'panel' ? 'h-[420px]' : 'h-[360px]'

// AFTER
'aspect-[4/3] min-h-[280px] max-h-[600px]'
```

This makes the chart width-responsive: on a wide panel it'll be taller, on a narrow panel it'll be shorter, but always maintaining a 4:3 proportion. The `max-h-[600px]` prevents it from growing absurdly tall on very wide panels.

**Approach B — Plotly-specific postMessage height negotiation (optional enhancement, can defer):**

For Plotly charts specifically, modify `buildPlotlyHtmlDocument` in `utils.ts` to add a `ResizeObserver` inside the iframe that posts its content height back to the parent:

```javascript
// Inside the Plotly iframe's <script>
const observer = new ResizeObserver(() => {
  const root = document.getElementById('plotly-root');
  if (root) {
    window.parent.postMessage({ type: 'chiridion:iframe-height', height: root.scrollHeight }, '*');
  }
});
observer.observe(document.getElementById('plotly-root'));
```

Then in `NotebookHtmlOutput`, listen for the message and dynamically set the iframe height:
```tsx
useEffect(() => {
  const handler = (e: MessageEvent) => {
    if (e.data?.type === 'chiridion:iframe-height') {
      setContentHeight(e.data.height);
    }
  };
  window.addEventListener('message', handler);
  return () => window.removeEventListener('message', handler);
}, []);
```

This is more complex but gives pixel-perfect chart sizing. **Approach A is sufficient for the initial fix.** Approach B can be done later if needed.

**Static images** also have a hard cap (`max-h-[420px]` in `output-renderers.tsx` line 42). This should be relaxed to allow images to take their natural size up to the panel width:

```tsx
// output-renderers.tsx line 42
// BEFORE
className="max-h-[420px] w-auto max-w-full rounded"

// AFTER
className="w-auto max-w-full rounded"
```

If vertical capping is still desired, use a larger value like `max-h-[800px]` so only truly enormous images get constrained.

---

## 4. Switch Display Font from Instrument Serif to Source Serif 4

**File: `src/root.tsx` line 34**

Replace `Instrument+Serif:ital,wght@0,400;1,400` with `Source+Serif+4:ital,opsz,wght@0,8..60,200..900;1,8..60,200..900` in the Google Fonts URL.

Source Serif 4 is a variable font with optical sizing and weight axes, so the import covers all weights and sizes in one request.

```
// BEFORE
...&family=Instrument+Serif:ital,wght@0,400;1,400&display=swap

// AFTER
...&family=Source+Serif+4:ital,opsz,wght@0,8..60,200..900;1,8..60,200..900&display=swap
```

**File: `src/styles/globals.css`**

Update the `--font-display` variable:
```css
/* BEFORE */
--font-display: "Instrument Serif", ui-serif, Georgia, "Times New Roman", serif;

/* AFTER */
--font-display: "Source Serif 4", ui-serif, Georgia, "Times New Roman", serif;
```

No other changes needed — all components already reference `var(--font-display)`.

---

## Summary

| # | Issue | Files | Complexity |
|---|-------|-------|------------|
| 1 | Remove wrapper container | `index.tsx`, `Chat.tsx` | Low |
| 2a | Fix sidebar sticky (`self-start`) | `report-sidebar.tsx` | Low |
| 2b | Container query for sidebar responsiveness | `index.tsx`, `report-sidebar.tsx`, `report-mode.tsx` | Low |
| 3 | Flexible chart/image heights | `html-output.tsx`, `output-renderers.tsx` | Medium |
| 4 | Switch to Source Serif 4 font | `root.tsx`, `globals.css` | Low |
