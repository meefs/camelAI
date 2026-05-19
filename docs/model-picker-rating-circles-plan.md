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

## Per-model scores

Replace the bucketed `Intelligence` / `Speed` string-union types with a numeric `RatingScore` type that allows any of the 10 half-steps from `0.5` through `5.0`. Each model gets its own intelligence and speed score, set per-model in the catalog, so we are no longer forced to give clusters of models identical ratings.

### Type change in [src/lib/model-catalog.ts](../src/lib/model-catalog.ts)

Replace lines 32–33:

```ts
export type Intelligence = "low" | "medium" | "high";
export type Speed = "slow" | "balanced" | "fast";
```

with:

```ts
// Half-step rating, 0.5 through 5.0. Used for both intelligence and speed.
// Renders as 5 circles in the model picker hover tooltip.
export type RatingScore =
  | 0.5 | 1 | 1.5 | 2 | 2.5 | 3 | 3.5 | 4 | 4.5 | 5;
```

And update the interface (lines 35–44):

```ts
export interface ModelCatalogEntry {
  id: LlmModel;
  label: string;
  providerLogo: ProviderLogoType;
  providerOrder: number;
  modelOrder: number;
  cost: CostBucket;
  intelligence: RatingScore;
  speed: RatingScore;
}
```

The `Intelligence` and `Speed` exports are removed — no other file in the repo imports them (verified: `grep -r "type Intelligence\|type Speed\b" src/ workers/ tests/` returns zero non-definition hits).

### Proposed per-model scores

This is a first-draft proposal — **every cell is yours to tweak before this plan is handed to the implementer**. Edit any number you disagree with directly in this file.

Notation: scores are out of 5, in 0.5 steps. The "Visual" columns show what each score renders as (● = full, ◐ = half, ○ = empty) so you can eyeball the picker as you tune.

| Model                   | Provider | Cost  | Intelligence | Visual          | Speed | Visual          | Quick justification                                  |
| ----------------------- | -------- | ----- | -----------: | --------------- | ----: | --------------- | ---------------------------------------------------- |
| Opus 4.7                | Claude   | `$$$` | **5.0**      | ● ● ● ● ●        | **2.0** | ● ● ○ ○ ○        | Newest flagship; deeper thinking → slowest.          |
| Opus 4.6                | Claude   | `$$$` | **4.5**      | ● ● ● ● ◐        | **2.0** | ● ● ○ ○ ○        | Prior flagship; nearly as smart, slightly faster.    |
| Sonnet 4.6              | Claude   | `$$`  | **4.0**      | ● ● ● ● ○        | **4.0** | ● ● ● ● ○        | Workhorse — strong all-rounder, brisk.               |
| Haiku 4.5               | Claude   | `$`   | **2.5**      | ● ● ◐ ○ ○        | **5.0** | ● ● ● ● ●        | Smallest Claude; very fast.                          |
| GPT-5.5                 | OpenAI   | `$$$` | **5.0**      | ● ● ● ● ●        | **3.0** | ● ● ● ○ ○        | Newest OpenAI flagship; mid-pack on speed.           |
| GPT-5.4                 | OpenAI   | `$$`  | **4.5**      | ● ● ● ● ◐        | **3.5** | ● ● ● ◐ ○        | Prior flagship; a touch faster than 5.5.             |
| GPT-5.4 Mini            | OpenAI   | `$`   | **2.5**      | ● ● ◐ ○ ○        | **5.0** | ● ● ● ● ●        | Small/fast OpenAI variant.                           |
| Gemini 3.5 Flash        | Gemini   | `$`   | **4.5**      | ● ● ● ● ◐        | **4.5** | ● ● ● ● ◐        | Fast high-intelligence Gemini.                       |
| Gemini 3 Flash Preview  | Gemini   | `$`   | **2.5**      | ● ● ◐ ○ ○        | **5.0** | ● ● ● ● ●        | Small/fast Gemini.                                   |
| DeepSeek V4 Pro         | DeepSeek | `$`   | **3.5**      | ● ● ● ◐ ○        | **3.5** | ● ● ● ◐ ○        | Strong mid-tier open-source.                         |
| DeepSeek V4 Flash       | DeepSeek | `$`   | **2.0**      | ● ● ○ ○ ○        | **5.0** | ● ● ● ● ●        | Smallest DeepSeek; very fast.                        |
| Kimi K2.6               | Kimi     | `$`   | **3.5**      | ● ● ● ◐ ○        | **3.5** | ● ● ● ◐ ○        | Comparable to DeepSeek V4 Pro.                       |
| Grok 4.3                | Grok     | `$`   | **3.5**      | ● ● ● ◐ ○        | **4.5** | ● ● ● ● ◐        | Mid-intelligence, leans fast.                        |

**How the scores were anchored:**
- Top of intelligence (`5.0`) reserved for the two newest frontier flagships (Opus 4.7, GPT-5.5). Their immediate predecessors and fast high-intelligence peers (Opus 4.6, GPT-5.4, Gemini 3.5 Flash) sit at `4.5` so the lineage shows.
- Sonnet 4.6 at `4.0` separates the "everyday Claude" from the very top tier (`4.5+`) and from the open-source mid-tier (`3.5`).
- Mini/Flash variants (Haiku, GPT Mini, Gemini Flash) cluster at `2.5` intelligence — clearly weaker than the pros but not punishingly low. DeepSeek Flash at `2.0` is the only one a half-step below; tweak if you disagree.
- Top of speed (`5.0`) reserved for the explicit "fast/mini/flash" variants. Sonnet 4.6 at `4.0` is the fastest non-mini. Opus 4.7 at `1.5` is the only one below `2.0` — it's noticeably slower than 4.6 in practice; bump to `2.0` if you'd rather not single it out.
- No model uses `0.5` or `1.0`. Reserve those slots for future cases if a truly punishing rating is ever appropriate; with a 10-step scale we don't need to use every step.

> **Tweaking workflow:** edit numbers directly in the table above. The implementing agent will lift these into [src/lib/model-catalog.ts](../src/lib/model-catalog.ts) verbatim, so whatever you finalize here is what ships.

### Why move to per-model numerics (not keep buckets + remap)

- The user's stated reason: the previous 3-bucket type forced models with meaningfully different qualitative levels into the same value (e.g., Opus 4.7 and Opus 4.6 both `"high"`). The new 10-value scale lets each model's score reflect its actual position.
- The catalog file is already the canonical place each model is tuned (cost bucket, ordering, label). Adding per-model numeric scores keeps all tuning in one file rather than scattering a remap table inside the picker.
- Type safety: `RatingScore` as a numeric union prevents typos like `4.7` (not a half-step). Tests can simply assert "is one of the 10 allowed values" rather than maintaining a bucket-list.

---

## Visual design

### Goal layout

Using the proposed scores. Sonnet 4.6 → intelligence 4.0, speed 4.0:

```
┌─────────────────────────────────────┐
│ Sonnet 4.6                          │ ← model name (unchanged)
│ ─────────────────────────────────── │ ← divider (unchanged)
│ cost              $$                │ ← cost row (unchanged)
│ intelligence      ● ● ● ● ○         │ ← was "medium"; now 4.0
│ speed             ● ● ● ● ○         │ ← was "balanced"; now 4.0
└─────────────────────────────────────┘
```

A few more example rows in context:

```
Opus 4.7                              Haiku 4.5
─────────────────────────────         ─────────────────────────────
cost               $$$                cost               $
intelligence       ● ● ● ● ●          intelligence       ● ● ◐ ○ ○
speed              ● ◐ ○ ○ ○          speed              ● ● ● ● ●

GPT-5.5                               Grok 4.3
─────────────────────────────         ─────────────────────────────
cost               $$$                cost               $
intelligence       ● ● ● ● ●          intelligence       ● ● ● ○ ○
speed              ● ● ● ○ ○          speed              ● ● ● ● ◐
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

### 2. Update `MODEL_CATALOG` to use the per-model numeric scores

In [src/lib/model-catalog.ts](../src/lib/model-catalog.ts), edit each entry's `intelligence` and `speed` fields to the values from the [Per-model scores](#per-model-scores) table. (No bucket→score map exists; the catalog *is* the source of truth.)

For example, the Opus 4.7 entry ([src/lib/model-catalog.ts:87-96](../src/lib/model-catalog.ts#L87-L96)) becomes:

```ts
"opus-4.7": {
  id: "opus-4.7",
  label: "Opus 4.7",
  providerLogo: "claude",
  providerOrder: 0,
  modelOrder: 0,
  cost: "$$$",
  intelligence: 5,
  speed: 1.5,
},
```

Apply the analogous edit to all 13 entries using the table values. Type-check (`bun run typecheck`) catches any number that isn't one of the 10 allowed half-steps.

The picker import only needs `ModelCatalogEntry` now — no `Intelligence` / `Speed` types to import (they no longer exist):

```tsx
import { MODEL_CATALOG, type ModelCatalogEntry } from '@/lib/model-catalog';
```

### 3. Update `ModelMetadataCard` to use rating dots for intelligence and speed

Replace the body of `ModelMetadataCard` ([src/components/model-picker.tsx:52-66](../src/components/model-picker.tsx#L52-L66)) with:

```tsx
function ModelMetadataCard({ entry }: { entry: ModelCatalogEntry }) {
  return (
    <HoverCardContent side="right" align="start" sideOffset={8} className="w-48">
      <div className="space-y-2">
        <div className="font-medium">{entry.label}</div>
        <div className="h-px bg-border/60" />
        <div className="space-y-1.5">
          <MetadataRow label="cost" value={entry.cost} />
          <RatingRow
            label="intelligence"
            score={entry.intelligence}
            ariaLabel={`Intelligence rating: ${entry.intelligence} out of 5`}
          />
          <RatingRow
            label="speed"
            score={entry.speed}
            ariaLabel={`Speed rating: ${entry.speed} out of 5`}
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

### 4. Update the picker test

[tests/model-picker.test.tsx:89-104](../tests/model-picker.test.tsx#L89-L104) currently asserts:

```ts
expect(screen.getByText('high')).toBeInTheDocument();
expect(screen.queryByText('slow')).not.toBeInTheDocument();
expect(screen.getByText('balanced')).toBeInTheDocument();
```

These will break — those words no longer render. Replace them with assertions on the `aria-label`s of the rating clusters, which are stable and meaningful. Use the proposed scores from the [Per-model scores](#per-model-scores) table — Opus 4.6 = 4.5 intel / 2.0 speed; Sonnet 4.6 = 4.0 intel / 4.0 speed:

```ts
// Opus 4.6: intelligence 4.5, speed 2
fireEvent.focus(getModelItem('Opus 4.6'));
expect(screen.getByRole('tooltip')).toHaveTextContent('Opus 4.6');
expect(
  screen.getByLabelText('Intelligence rating: 4.5 out of 5'),
).toBeInTheDocument();
expect(
  screen.getByLabelText('Speed rating: 2 out of 5'),
).toBeInTheDocument();

// Sonnet 4.6: intelligence 4, speed 4
fireEvent.focus(getModelItem('Sonnet 4.6'));
expect(screen.getByRole('tooltip')).toHaveTextContent('Sonnet 4.6');
expect(
  screen.getByLabelText('Intelligence rating: 4 out of 5'),
).toBeInTheDocument();
expect(
  screen.getByLabelText('Speed rating: 4 out of 5'),
).toBeInTheDocument();
expect(screen.getAllByText('cost')).toHaveLength(1);
```

The other test in the file (`'delays pointer metadata and cancels pending opens on leave'`, [tests/model-picker.test.tsx:106-126](../tests/model-picker.test.tsx#L106-L126)) only asserts on the tooltip's `Opus 4.6` / `Sonnet 4.6` text — those still render — so it doesn't need changes.

### 5. Update the catalog test

[tests/model-catalog.test.ts:105-114](../tests/model-catalog.test.ts#L105-L114) currently asserts:

```ts
expect(['low', 'medium', 'high']).toContain(entry.intelligence);
expect(['slow', 'balanced', 'fast']).toContain(entry.speed);
```

Replace with assertions that the values are valid `RatingScore`s:

```ts
const ALLOWED_SCORES = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];
expect(ALLOWED_SCORES).toContain(entry.intelligence);
expect(ALLOWED_SCORES).toContain(entry.speed);
```

[tests/model-catalog.test.ts:11-66](../tests/model-catalog.test.ts#L11-L66) (`NEW_OPENROUTER_MODELS`) hard-codes string values for `intelligence` and `speed` and feeds them into `toMatchObject`. Update each entry's expected values to match the numeric scores from the proposal table:

| id                       | intelligence | speed |
| ------------------------ | -----------: | ----: |
| `gemini-3-flash-preview` |          2.5 |     5 |
| `gemini-3.5-flash`       |          4.5 |   4.5 |
| `deepseek-v4-pro`        |          3.5 |   3.5 |
| `deepseek-v4-flash`      |            2 |     5 |

(Also widen the field types on the `NEW_OPENROUTER_MODELS` array declaration from `string` to `number` for `intelligence` / `speed`.)

### 6. Nothing else changes

Explicitly do NOT modify:
- The `cost` field anywhere — it stays as `$` / `$$` / `$$$` text.
- The hover-card open/close timing, anchor, or trigger logic in `ModelPicker` ([src/components/model-picker.tsx:78-180](../src/components/model-picker.tsx#L78-L180)).
- The dropdown menu items (logo, label, check icon) — only the floating tooltip card content changes.
- The tooltip width (`w-48`) — the cluster fits.
- The org settings models page ([src/routes/_app.settings.organization.models.tsx](../src/routes/_app.settings.organization.models.tsx)) — it doesn't display intelligence/speed today and shouldn't start now.
- Any pricing logic in [services/sandbox-host/internal/app/usage_pricing.go](../services/sandbox-host/internal/app/usage_pricing.go) — intelligence/speed are display-only metadata and have no effect on billing.

---

## Edge cases & verification

| Case                                                                          | Expected                                                                                            |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Hovering each model in the picker                                             | Tooltip shows model name, divider, `cost: $/$$/$$$`, intelligence dots, speed dots.                 |
| Each model's circles match its catalog score                                  | E.g. Opus 4.7 intelligence = 5.0 → 5 full; Sonnet 4.6 intelligence = 4.0 → 4 full + 1 empty; Grok 4.3 speed = 4.5 → 4 full + 1 half. (Cross-reference the [Per-model scores](#per-model-scores) table.) |
| A score of 5.0                                                                | Five fully-filled circles, no empty.                                                                |
| A score of 0.5                                                                | One half + four empty (renderer must handle this even though no current model uses it).             |
| A score that ends in `.0` vs `.5`                                             | `.0` scores show whole-circle counts only; `.5` scores include exactly one half-pip in the position immediately after the last full pip. |
| Light vs dark mode                                                            | Filled circles use `text-foreground`; empty circles use a solid `text-muted-foreground/30` fill. Both adapt automatically. |
| Hovering the same model repeatedly                                            | Tooltip re-renders identically. No layout shift between text rows and circle rows.                  |
| Keyboard navigation (`↑/↓`) through the dropdown                              | Tooltip swaps content between models without flicker. Aria labels announce the new score.           |
| Focus moves to a different model while a previous tooltip is closing          | Existing single-tooltip-at-a-time behavior in [src/components/model-picker.tsx:99-105](../src/components/model-picker.tsx#L99-L105) is unchanged.        |
| Screen reader user                                                            | Hears "Intelligence rating: X out of 5" and "Speed rating: Y out of 5" instead of just "circle circle circle". |
| Half-circle on Safari                                                         | `clipPath="inset(0 50% 0 0)"` renders as left half filled, right half empty. (Verified support; flag if not.) |
| Tooltip cluster width vs `w-48`                                               | 5 × 12px + 4 × 4px gap = 76px. Plus left label and `gap-6`, comfortably fits the 192px tooltip.     |

---

## Verification checklist

- [ ] `bun run typecheck` passes (catches any out-of-step number assigned to `intelligence` / `speed`).
- [ ] `bun run lint` passes.
- [ ] `bun run test:run tests/model-picker.test.tsx tests/model-catalog.test.ts` passes (with the assertion updates from steps 4 and 5).
- [ ] `bun run test:run tests/model-logo-and-pricing.test.ts tests/model-settings-ui.test.tsx tests/model-picker-config.test.ts` still pass (no expected changes — these don't touch intelligence/speed).
- [ ] Open the chat composer model picker locally (`bun run dev`), hover each of the 13 models, and visually confirm the dot counts match the [Per-model scores](#per-model-scores) table cell-for-cell.
- [ ] Half-pip renders cleanly (left half foreground, right half muted, no jagged seam) in both light and dark themes.
- [ ] Empty pip is a solid muted-color fill (not an outlined ring), matching the screenshot.
- [ ] Cluster sits flush-right against the tooltip's right padding, vertically centered with the label.
- [ ] Tab through the picker with the keyboard — aria-labels announce the score correctly via screen reader (or VoiceOver / NVDA quick check).

---

## Out of scope

- Showing the numeric score as a label next to the circles (e.g., "3.5 ● ● ● ◐ ○"). The visual *is* the value.
- Displaying ratings anywhere outside the picker tooltip (settings page, model selection in onboarding, paywall, etc.). Those surfaces don't show intelligence/speed today.
- Tooltip-on-the-rating ("Intelligence: 3.5/5 means…"). The category label and the visual are sufficient; an explanation tooltip is a separate UX call.
- Animating the dots in/out on hover.
- Changing the cost row's representation.
