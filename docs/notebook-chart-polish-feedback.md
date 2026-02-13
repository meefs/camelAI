# Notebook Chart Polish — Feedback

Three issues to address. All are in the Vega-Lite chart renderer and the report-mode layout.

---

## 1. Chart Subtitles Are Invisible in Dark Mode

**Problem:** Every chart in this notebook has a subtitle (e.g., "A heavily male-dominated executive class" under "Gender Distribution"). In dark mode these subtitles are invisible — the text renders in Vega-Lite's default subtitle color (a near-black gray) on a dark background.

**Root cause:** `buildThemedSpec` in `vega-lite-chart.tsx` patches `config.title.color` (the main title color) but never sets `subtitleColor`. Vega-Lite uses a separate property for subtitle text color.

The spec-level title objects look like this:
```json
{
  "text": "Gender Distribution",
  "subtitle": "A heavily male-dominated executive class"
}
```

And the current theming code at line 205 only sets `color`:
```tsx
title: {
  color: dark ? '#f4f4f5' : '#111827',
  ...existingTitle,
},
```

**Fix — `vega-lite-chart.tsx`, `buildThemedSpec` function, lines 205–208:**

Add `subtitleColor` to the title config:

```tsx
title: {
  color: dark ? '#f4f4f5' : '#111827',
  subtitleColor: dark ? '#a1a1aa' : '#6b7280',
  ...existingTitle,
},
```

This gives subtitles a muted-but-visible color in both modes. The `...existingTitle` spread still allows notebook-specified overrides to win.

**Also for Plotly** — the same gap exists in `plotly-chart.tsx`. The `buildThemedPlotlyFigure` function patches `layout.title.font.color` but does not patch `layout.annotations`. Plotly notebooks often use annotations for subtitles. Add annotation color patching after the title block (after line 227):

```tsx
// Patch annotation text colors for dark mode (subtitles, callouts, etc.)
if (Array.isArray(layout.annotations)) {
  layout.annotations = (layout.annotations as Record<string, unknown>[]).map((annotation) => {
    const next = { ...annotation };
    const annotationFont = asRecord(next.font);
    if (annotationFont.color == null) annotationFont.color = textColor;
    next.font = annotationFont;
    return next;
  });
}
```

---

## 2. Charts Within the Same Section Need More Breathing Room

**Problem:** When multiple charts appear in a section (either multiple outputs from one cell, or consecutive chart cells), they feel stacked too tightly together. The current spacing is `space-y-4` (16px) for outputs within a cell, and `space-y-6` (24px) between cells.

Charts are visually heavy elements. They need more vertical breathing room than text blocks do.

**Fix — `report-mode.tsx` line 94:**

Increase within-cell output spacing:
```tsx
// BEFORE
<div key={`cell-${index}`} className="min-w-0 space-y-4">

// AFTER
<div key={`cell-${index}`} className="min-w-0 space-y-8">
```

**Fix — `report-mode.tsx` line 72:**

Also increase the top-level cell spacing so chart-producing cells get more room:
```tsx
// BEFORE
<div className="space-y-6">

// AFTER
<div className="space-y-8">
```

This gives 32px between cells and between outputs within a cell — enough visual separation that each chart reads as its own distinct element.

---

## 3. First Donut Chart Gets Clipped — Height Calculation Needs Improvement

**Problem:** The first donut chart ("Gender Distribution") gets its bottom clipped. The second donut chart ("Paris vs. Province") renders fine. All other charts (bar, histogram, area, heatmap, density) render at good heights.

**Root cause:** Both donut charts specify `width: 280, height: 280` in their Vega-Lite spec. The theming function sets `width: 'container'` (line 152), making the chart fill the available horizontal space. But `height` is left at its original value of 280.

On a wide panel, the chart area becomes much wider than 280px, but the height stays at 280px. For the first donut chart, which has a legend, a title, and a subtitle all needing vertical space in addition to the 280px-tall donut, 280px total is not enough — the donut, legend, title, and subtitle compete for those 280 pixels.

The second donut chart likely renders fine because it has a shorter subtitle or fewer legend entries, but it's still tight.

**Why only donut/pie charts are affected:** Bar charts, histograms, and other axis-based charts have `width: 'container'` + a reasonable height (usually 300–400px) and don't have a large circular element that needs roughly equal width and height. Donut charts are unique because the aspect ratio matters — the circle needs comparable width and height, but the surrounding elements (title, subtitle, legend) need *additional* vertical space.

**Fix — `vega-lite-chart.tsx`, `buildThemedSpec` function, after line 152:**

When setting `width: 'container'`, also make height adaptive. The key insight: if the original spec has a fixed height that equals its fixed width (square aspect ratio, typical for donut/pie charts), the height should scale proportionally with the container width. But since we can't know the container width at spec-build time, we need a different approach.

**Approach: remove fixed height and let Vega-Lite auto-size, with a CSS aspect-ratio fallback for square charts.**

```tsx
// Force responsive sizing regardless of python-side fixed width.
nextSpec.width = 'container';

// If height equals width (square chart like donut/pie), remove the
// fixed height so the chart can use available vertical space.
// For non-square charts, keep height as-is (it usually works well).
const specWidth = typeof sourceSpec.width === 'number' ? sourceSpec.width : null;
const specHeight = typeof sourceSpec.height === 'number' ? sourceSpec.height : null;

if (specHeight != null && specWidth != null && specHeight === specWidth) {
  // Square chart (donut, pie, etc.) — remove fixed height.
  // The container CSS will enforce a reasonable aspect ratio.
  delete nextSpec.height;
} else if (specHeight != null) {
  // Non-square chart — keep original height, it's usually fine.
  // (already set from cloneSpec)
}
```

Then in the `VegaLiteChart` component's render output, add a minimum height that accounts for title + subtitle + legend overhead. Replace the inline `minHeight: 280` style:

```tsx
// vega-lite-chart.tsx, VegaLiteChart component render
<div
  ref={containerRef}
  aria-label={title}
  style={{ width: '100%', minHeight: 320 }}
  className={cn(
    'w-full min-w-0 overflow-hidden',
    isLoading ? 'min-h-[320px] opacity-0' : 'opacity-100'
  )}
/>
```

Bumping from 280 to 320 gives an extra 40px for title + subtitle that's universally beneficial and doesn't hurt non-donut charts.

**Alternative / additional approach:** If the above isn't enough for the first donut chart specifically, detect that the spec has `mark: 'arc'` (or a layer containing an arc mark) and bump the min-height further for those:

```tsx
// In buildThemedSpec or as a helper
function hasArcMark(spec: Record<string, unknown>): boolean {
  if (spec.mark === 'arc') return true;
  const mark = asRecord(spec.mark);
  if (mark.type === 'arc') return true;
  if (Array.isArray(spec.layer)) {
    return spec.layer.some((layer) => {
      const l = asRecord(layer);
      if (l.mark === 'arc') return true;
      const layerMark = asRecord(l.mark);
      return layerMark.type === 'arc';
    });
  }
  return false;
}
```

Then in the component:
```tsx
const isArcChart = useMemo(() => hasArcMark(spec), [spec]);
const containerMinHeight = isArcChart ? 380 : 320;
```

This gives arc/donut/pie charts extra headroom without affecting other chart types.

---

## Summary

| # | Issue | File | Complexity |
|---|-------|------|------------|
| 1 | Subtitle invisible in dark mode | `vega-lite-chart.tsx`, `plotly-chart.tsx` | Low |
| 2 | Charts too close together | `report-mode.tsx` | Low |
| 3 | Donut chart height clipping | `vega-lite-chart.tsx` | Medium |
