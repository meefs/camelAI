# Model Picker — Rating Circles Plan

**Date:** 2026-05-05
**Branch:** `illianaa/model-picker-rating-circles` (suggested)
**Primary files:**
- [src/lib/model-catalog.ts](../src/lib/model-catalog.ts) — replace `Intelligence` / `Speed` string-union types with a numeric `RatingScore` type (0.5–5.0 in 0.5 steps); update every model's `intelligence` and `speed` fields to the proposed numeric scores in the [Per-model scores](#per-model-scores) table.
- [src/components/model-picker.tsx](../src/components/model-picker.tsx) — `ModelMetadataCard`, `MetadataRow` (tooltip rendered on hover); add the `RatingDots` / `RatingDot` / `RatingRow` components and consume the new numeric fields directly.
- [tests/model-picker.test.tsx](../tests/model-picker.test.tsx) — picker tooltip tests (assertions on `"high"`, `"balanced"`, `"slow"` need updating).
- [tests/model-catalog.test.ts](../tests/model-catalog.test.ts) — type/shape assertions on `intelligence` and `speed` (currently checks `["low","medium","high"]` / `["slow","balanced","fast"]`) and the `NEW_OPENROUTER_MODELS` per-model expectations need updating.

---

## Objective

Replace the word-based intelligence/speed rows in the model picker hover tooltip with a 5-circle rating display (half-circle granularity supported). Cost continues to render as `$` / `$$` / `$$$` text — no change.

This is a **visual / display-only** change. The underlying catalog data, types, and any consumer outside the tooltip stay exactly as they are.

---

## Current state

The hover tooltip renders three rows: `cost`, `intelligence`, `speed`. Each row uses the same `MetadataRow` component, which is just a label on the left and a value string on the right.

[src/components/model-picker.tsx:37-50](../src/components/model-picker.tsx#L37-L50):

```tsx
function MetadataRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-6">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
```

[src/components/model-picker.tsx:52-66](../src/components/model-picker.tsx#L52-L66):

```tsx
function ModelMetadataCard({ entry }: { entry: ModelCatalogEntry }) {
  return (
    <HoverCardContent side="right" align="start" sideOffset={8} className="w-48">
      <div className="space-y-2">
        <div className="font-medium">{entry.label}</div>
        <div className="h-px bg-border/60" />
        <div className="space-y-1.5">
          <MetadataRow label="cost" value={entry.cost} />
          <MetadataRow label="intelligence" value={entry.intelligence} />
          <MetadataRow label="speed" value={entry.speed} />
        </div>
      </div>
    </HoverCardContent>
  );
}
```

The displayed words (`low/medium/high`, `slow/balanced/fast`) are pulled directly from `ModelCatalogEntry.intelligence` / `.speed`, which are typed unions defined in [src/lib/model-catalog.ts:32-33](../src/lib/model-catalog.ts#L32-L33).

---

## Mapping

Three buckets map to a fixed score on a 0–5 scale (half-step granularity). The mapping is the same for both intelligence and speed:

| Catalog value (intelligence)         | Score (out of 5) | Visual                        |
| ------------------------------------ | ---------------- | ----------------------------- |
| `"high"`                             | **5.0**          | ● ● ● ● ●                     |
| `"medium"`                           | **3.5**          | ● ● ● ◐ ○                     |
| `"low"`                              | **2.0**          | ● ● ○ ○ ○                     |

| Catalog value (speed)                | Score (out of 5) | Visual                        |
| ------------------------------------ | ---------------- | ----------------------------- |
| `"fast"`                             | **5.0**          | ● ● ● ● ●                     |
| `"balanced"`                         | **3.5**          | ● ● ● ◐ ○                     |
| `"slow"`                             | **2.0**          | ● ● ○ ○ ○                     |

**Rationale for these anchor values:**
- We have 3 buckets but want 5 circles with half-fill. A naive 1/3/5 mapping leaves the half-circle slot unused entirely — wasteful given the point of half-circles is to make the scale feel calibrated rather than coarse.
- Anchoring `"high"`/`"fast"` at 5.0 (not 4.5) is intentional: top-bucket models should look unambiguously top-tier.
- Anchoring `"low"`/`"slow"` at 2.0 (not 1.0 or 0.5) avoids making legitimate, intentionally-cheap-and-fast models look like they're failing some test. They're still clearly the bottom bucket compared to medium (3.5) and high (5.0).
- `"medium"` / `"balanced"` at 3.5 puts the half-circle into use and visually separates it from both extremes.

**Decision to keep buckets in the catalog data type (not expand to floats):**
- Keeping `Intelligence = "low" | "medium" | "high"` means the catalog stays compact and self-explanatory; reviewers don't have to debate "is this a 4 or a 4.5?" per model.
- All visual tuning is one constant table away in the picker component — easy to revisit if Illiana wants to spread models out later.
- If we later decide we *do* want per-model granular tuning (e.g., Opus 4.7 = 5.0 but Opus 4.6 = 4.5), that becomes a follow-up that expands the type without rewriting the rendering layer.

> **For Illiana to confirm:** Are these three anchor values (`5.0 / 3.5 / 2.0`) correct? If you want low/slow to read more punishing (e.g., 1.5) or medium to lean higher/lower (3.0 or 4.0), say so and the table above gets one edit.

---

## Visual design

### Goal layout

```
┌─────────────────────────────────────┐
│ Sonnet 4.6                          │ ← model name (unchanged)
│ ─────────────────────────────────── │ ← divider (unchanged)
│ cost              $$                │ ← cost row (unchanged)
│ intelligence      ● ● ● ◐ ○         │ ← was "medium"
│ speed             ● ● ● ◐ ○         │ ← was "balanced"
└─────────────────────────────────────┘
```

A few example rows in context:

```
Opus 4.7
─────────────────────────────────────
cost               $$$
intelligence       ● ● ● ● ●
speed              ● ● ○ ○ ○

Haiku 4.5
─────────────────────────────────────
cost               $
intelligence       ● ● ○ ○ ○
speed              ● ● ● ● ●

GPT-5.5
─────────────────────────────────────
cost               $$$
intelligence       ● ● ● ● ●
speed              ● ● ● ◐ ○
```

### Circle visual specs

Matches the attached screenshot: filled circles use the foreground color; empty circles are solid filled in a muted/low-contrast color (NOT outlined). The half-pip is exactly half foreground / half muted — both halves are solid fills.

| Property              | Value                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------- |
| Circle diameter       | `12px` (`size-3` in Tailwind) — matches the body line-height in the mockup                  |
| Gap between circles   | `4px` (`gap-1`) — matches the airy spacing in the screenshot                                |
| Filled color          | `text-foreground` (matches the `font-medium` color used by the cost text on the same row)   |
| Empty (filled) color  | `text-muted-foreground/30` — solid fill, low contrast against the popover background        |
| Half-fill direction   | Left half = foreground, right half = muted (matches how 5-star ratings read L→R)            |
| Row alignment         | Cluster of 5 circles right-aligns with the row, vertically centered with the label          |
| Tooltip width         | Unchanged — `w-48` (192px). Rating cluster: 5 × 12px + 4 × 4px = 76px, fits comfortably     |

> **Note on the empty pip:** the screenshot shows the empty state as a solid dark circle, not a bordered/outlined ring. The implementation below uses two stacked filled circles (muted base + foreground overlay) rather than stroke + fill — this is what produces the correct half-pip visual where both halves are solid colors.

### Why a custom small component instead of a Lucide icon

Lucide ships `Circle` (outlined only) and has no half-filled circle primitive. The screenshot's design (solid fills on both halves) doesn't match Lucide's bordered style anyway. A 15-line inline SVG component is simpler, smaller, and themes correctly via `currentColor`.

---

## Implementation

### 1. Add a `RatingDots` component inside `model-picker.tsx`

Add this above `MetadataRow` (around [src/components/model-picker.tsx:37](../src/components/model-picker.tsx#L37)). Keep it private to the file — there are no other consumers.

```tsx
const RATING_MAX = 5;

function RatingDot({ fill }: { fill: 'full' | 'half' | 'empty' }) {
  // 10x10 viewBox, two stacked solid circles:
  //   - base: muted-foreground/30 (always rendered, becomes the "empty" right half)
  //   - overlay: foreground, optionally clipped to the left half
  return (
    <svg
      viewBox="0 0 10 10"
      aria-hidden="true"
      className="size-3 shrink-0"
    >
      <circle
        cx="5"
        cy="5"
        r="5"
        fill="currentColor"
        className="text-muted-foreground/30"
      />
      {fill !== 'empty' && (
        <circle
          cx="5"
          cy="5"
          r="5"
          fill="currentColor"
          className="text-foreground"
          clipPath={fill === 'half' ? 'inset(0 50% 0 0)' : undefined}
        />
      )}
    </svg>
  );
}

function RatingDots({
  score,
  ariaLabel,
}: {
  score: number; // 0 to RATING_MAX, in 0.5 steps
  ariaLabel: string; // e.g. "Intelligence rating: 3.5 out of 5"
}) {
  const clamped = Math.max(0, Math.min(RATING_MAX, score));
  const dots: Array<'full' | 'half' | 'empty'> = [];
  for (let i = 0; i < RATING_MAX; i++) {
    const remaining = clamped - i;
    if (remaining >= 1) dots.push('full');
    else if (remaining >= 0.5) dots.push('half');
    else dots.push('empty');
  }
  return (
    <span
      className="flex items-center gap-1"
      role="img"
      aria-label={ariaLabel}
    >
      {dots.map((fill, i) => (
        <RatingDot key={i} fill={fill} />
      ))}
    </span>
  );
}
```

Notes:
- **`clipPath` value:** Tailwind doesn't ship a half-fill utility, so the inline SVG attribute `clipPath="inset(0 50% 0 0)"` is the simplest cross-browser way to render a left-half overlay. (Confirmed support across modern Chrome, Safari, Firefox.) If the implementer hits a rendering issue, fall back to two stacked SVGs with `overflow-hidden` on the outer wrapper at 50% width.
- **Two stacked solid circles (not stroke + clipped fill):** matches the screenshot, where empty pips are clearly *filled* dark circles, not bordered rings. The base layer is always rendered so the muted half of a half-pip naturally appears wherever the foreground overlay isn't drawn.
- **`currentColor` + `className` on `<circle>`:** the `className` sets `color`, and `fill="currentColor"` inherits it. This keeps both light and dark themes correct without a media query.
- **Accessibility:** the cluster is a single `role="img"` with an `aria-label` describing the score. Individual pips are `aria-hidden`. Screen readers will announce "Intelligence rating: 3.5 out of 5" rather than five "circle" announcements.

### 2. Add the score-mapping table

Place these two const maps just below the imports in `model-picker.tsx`:

```tsx
const INTELLIGENCE_SCORE: Record<Intelligence, number> = {
  low: 2,
  medium: 3.5,
  high: 5,
};

const SPEED_SCORE: Record<Speed, number> = {
  slow: 2,
  balanced: 3.5,
  fast: 5,
};
```

You'll need to import the types — extend the existing import:

```tsx
import {
  MODEL_CATALOG,
  type Intelligence,
  type ModelCatalogEntry,
  type Speed,
} from '@/lib/model-catalog';
```

(`Intelligence` and `Speed` are already exported from `model-catalog.ts` — see [src/lib/model-catalog.ts:32-33](../src/lib/model-catalog.ts#L32-L33). No edits to that file.)

### 3. Update `ModelMetadataCard` to use rating dots for intelligence and speed

Replace the body of `ModelMetadataCard` ([src/components/model-picker.tsx:52-66](../src/components/model-picker.tsx#L52-L66)) with:

```tsx
function ModelMetadataCard({ entry }: { entry: ModelCatalogEntry }) {
  const intelligenceScore = INTELLIGENCE_SCORE[entry.intelligence];
  const speedScore = SPEED_SCORE[entry.speed];
  return (
    <HoverCardContent side="right" align="start" sideOffset={8} className="w-48">
      <div className="space-y-2">
        <div className="font-medium">{entry.label}</div>
        <div className="h-px bg-border/60" />
        <div className="space-y-1.5">
          <MetadataRow label="cost" value={entry.cost} />
          <RatingRow
            label="intelligence"
            score={intelligenceScore}
            ariaLabel={`Intelligence rating: ${intelligenceScore} out of 5`}
          />
          <RatingRow
            label="speed"
            score={speedScore}
            ariaLabel={`Speed rating: ${speedScore} out of 5`}
          />
        </div>
      </div>
    </HoverCardContent>
  );
}
```

And add a `RatingRow` helper next to `MetadataRow` (keeps the cost row's API simple, since cost is still a string):

```tsx
function RatingRow({
  label,
  score,
  ariaLabel,
}: {
  label: string;
  score: number;
  ariaLabel: string;
}) {
  return (
    <div className="flex items-center justify-between gap-6">
      <span className="text-muted-foreground">{label}</span>
      <RatingDots score={score} ariaLabel={ariaLabel} />
    </div>
  );
}
```

`MetadataRow` stays exactly as is — it's still used for the cost row.

### 4. Update the existing picker test

[tests/model-picker.test.tsx:89-104](../tests/model-picker.test.tsx#L89-L104) currently asserts:

```ts
expect(screen.getByText('high')).toBeInTheDocument();
expect(screen.queryByText('slow')).not.toBeInTheDocument();
expect(screen.getByText('balanced')).toBeInTheDocument();
```

These will break — those words no longer render. Replace them with assertions on the `aria-label`s of the rating clusters, which are stable and meaningful:

```ts
// Opus 4.6: intelligence "high" → 5, speed "slow" → 2
fireEvent.focus(getModelItem('Opus 4.6'));
expect(screen.getByRole('tooltip')).toHaveTextContent('Opus 4.6');
expect(
  screen.getByLabelText('Intelligence rating: 5 out of 5'),
).toBeInTheDocument();
expect(
  screen.getByLabelText('Speed rating: 2 out of 5'),
).toBeInTheDocument();

// Sonnet 4.6: intelligence "medium" → 3.5, speed "balanced" → 3.5
fireEvent.focus(getModelItem('Sonnet 4.6'));
expect(screen.getByRole('tooltip')).toHaveTextContent('Sonnet 4.6');
expect(
  screen.getByLabelText('Intelligence rating: 3.5 out of 5'),
).toBeInTheDocument();
expect(
  screen.getByLabelText('Speed rating: 3.5 out of 5'),
).toBeInTheDocument();
expect(screen.getAllByText('cost')).toHaveLength(1);
```

The other test in the file (`'delays pointer metadata and cancels pending opens on leave'`, [tests/model-picker.test.tsx:106-126](../tests/model-picker.test.tsx#L106-L126)) only asserts on the tooltip's `Opus 4.6` / `Sonnet 4.6` text — those still render — so it doesn't need changes.

### 5. Nothing else changes

Explicitly do NOT modify:
- `MODEL_CATALOG`, `Intelligence`, or `Speed` in [src/lib/model-catalog.ts](../src/lib/model-catalog.ts).
- The `cost` field anywhere — it stays as `$` / `$$` / `$$$` text.
- The hover-card open/close timing, anchor, or trigger logic in `ModelPicker` ([src/components/model-picker.tsx:78-180](../src/components/model-picker.tsx#L78-L180)).
- The dropdown menu items (logo, label, check icon) — only the floating tooltip card content changes.
- The tooltip width (`w-48`) — the cluster fits.
- The org settings models page ([src/routes/_app.settings.organization.models.tsx](../src/routes/_app.settings.organization.models.tsx)) — it doesn't display intelligence/speed today and shouldn't start now.

---

## Edge cases & verification

| Case                                                                          | Expected                                                                                            |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Hovering each model in the picker                                             | Tooltip shows model name, divider, `cost: $/$$/$$$`, intelligence dots, speed dots.                 |
| Model with `intelligence: "high"` (e.g. Opus 4.7)                             | Five fully-filled circles for intelligence.                                                         |
| Model with `intelligence: "medium"` (e.g. Sonnet 4.6)                         | Three full + one half + one empty.                                                                  |
| Model with `intelligence: "low"` (e.g. Haiku 4.5)                             | Two full + three empty.                                                                             |
| Same cases for speed (`fast` / `balanced` / `slow`)                           | Same visual mapping as intelligence.                                                                |
| Light vs dark mode                                                            | Filled circles use `text-foreground`; empty circles use `text-muted-foreground/40`. Both adapt automatically. |
| Hovering the same model repeatedly                                            | Tooltip re-renders identically. No layout shift between text rows and circle rows.                  |
| Keyboard navigation (`↑/↓`) through the dropdown                              | Tooltip swaps content between models without flicker. Aria labels announce the new score.           |
| Focus moves to a different model while a previous tooltip is closing          | Existing single-tooltip-at-a-time behavior in [src/components/model-picker.tsx:99-105](../src/components/model-picker.tsx#L99-L105) is unchanged.        |
| Screen reader user                                                            | Hears "Intelligence rating: X out of 5" and "Speed rating: Y out of 5" instead of just "circle circle circle". |
| Half-circle on Safari                                                         | `clipPath="inset(0 50% 0 0)"` renders as left half filled, right half empty. (Verified support; flag if not.) |
| Tooltip cluster width vs `w-48`                                               | 5 × 10px + 4 × 2px gap = 58px. Plus left label and `gap-6`, comfortably fits the 192px tooltip.     |

---

## Verification checklist

- [ ] `bun run typecheck` passes.
- [ ] `bun run lint` passes.
- [ ] `bun run test:run tests/model-picker.test.tsx` passes (with the assertion updates from step 4).
- [ ] `bun run test:run tests/model-catalog.test.ts tests/model-logo-and-pricing.test.ts tests/model-settings-ui.test.tsx` still pass (no expected changes — these don't touch the tooltip).
- [ ] Open the chat composer model picker locally (`bun run dev`), hover each model, and visually confirm:
  - Cost row still shows `$` / `$$` / `$$$`.
  - Intelligence row shows 5 / 3.5 / 2 circles for `high` / `medium` / `low` models.
  - Speed row shows 5 / 3.5 / 2 circles for `fast` / `balanced` / `slow` models.
  - Half-circle renders cleanly (left half filled, no jagged edge) in both light and dark themes.
  - Empty circle outline is visible but clearly subordinate to the filled fill color.
  - Cluster sits flush right against the tooltip's right padding, vertically centered with the label.
- [ ] Tab through the picker with the keyboard — aria-labels announce the score correctly via screen reader (or VoiceOver / NVDA quick check).

---

## Out of scope

- Per-model fine-tuning (e.g., making Opus 4.7 a `4.5` instead of `5.0`). If desired later, expand the type in `model-catalog.ts` to a numeric and remove the bucket → score map.
- Showing the numeric score as a label next to the circles (e.g., "3.5 ● ● ● ◐ ○"). The visual *is* the value.
- Displaying ratings anywhere outside the picker tooltip (settings page, model selection in onboarding, paywall, etc.). Those surfaces don't show intelligence/speed today.
- Tooltip-on-the-rating ("Intelligence: 3.5/5 means…"). The category label and the visual are sufficient; an explanation tooltip is a separate UX call.
- Animating the dots in/out on hover.
- Changing the cost row's representation.
