# Models Settings — Source Switcher Plan

**Date:** 2026-06-12
**Branch:** `illianaa/salvador`
**Scope:** Replace the two checkboxes on `Settings → Models` ("Use org defaults for this workspace" + "Use platform model defaults") with a single segmented source switcher per scope, a dynamic description line, and a read-only model list when the scope is not in custom mode. This is primarily a **UI restyle**: the existing loader, action intents, and storage shape are kept. There are two small behavior changes: freeze the workspace seeding snapshot (§6) and retain custom lists when switching away from them (§7).

---

## 1. Objective

Today the page ([src/routes/_app.settings.organization.models.tsx](src/routes/_app.settings.organization.models.tsx)) stacks two independent checkboxes whose interaction is hard to reason about:

```
( Org default )  ( ⬤ Default Workspace [CUSTOM] )  ( ⬤ test )

☑ Use org defaults for this workspace        ← only at ws scope (line 771-791)
☑ Use platform model defaults                ← both scopes (line 801-819)

In your picker                                          13 of 13
 Ⓐ Sonnet 4.6        [disabled ☆] [disabled remove]    ← disabled buttons when not custom
 ...
```

The new design answers one question per scope — *where does this list come from?* — with a single segmented control, and makes one consequence unmistakable via the description line: **a custom list does not receive new models automatically.**

Mental model (three possible sources for a picker):

1. **camelAI's default lineup** — managed by us, always current. Models get added and retired over time.
2. **The org's custom list** — a snapshot the admin owns. We never modify it.
3. **A workspace's custom list** — same, scoped to one workspace.

Each scope makes exactly one choice:

- **Org:** camelAI defaults, or a custom list.
- **Workspace:** follow the org (whatever it resolves to, including future org changes), or a custom list.

---

## 2. State model — UI ↔ storage mapping

No new storage fields, no new intents, no loader payload changes. The segmented control is a pure projection of flags already in the loader data:

| Scope | Segment shown active | Loader condition |
|---|---|---|
| Org | `camelAI defaults` | `config.usePlatformDefaults === true` |
| Org | `Custom list` | `config.usePlatformDefaults === false` |
| Workspace | `Follow org` | `useOrgDefaults === true` |
| Workspace | `Custom list` | `useOrgDefaults === false` |

Selecting a segment submits the **existing** intents:

| Scope | Segment selected | Submits |
|---|---|---|
| Org | `camelAI defaults` | `intent=setUsePlatformDefaults, usePlatformDefaults=true` |
| Org | `Custom list` | `intent=setUsePlatformDefaults, usePlatformDefaults=false` |
| Workspace | `Follow org` | `intent=setUseOrgDefaults, useOrgDefaults=true` |
| Workspace | `Custom list` | `intent=setUseOrgDefaults, useOrgDefaults=false` |

The existing handlers already implement the spec's switching semantics in three of the four directions:

- Org → custom: materializes a snapshot of the current lineup (`visibleModelRows`, [lines 503-507](src/routes/_app.settings.organization.models.tsx#L503-L507)). ✓ frozen from that moment.
- Org → defaults: returns to the live lineup. ✓
- WS → follow: flips `use_org_defaults` back, list re-resolves from org. ✓
- WS → custom: seeds from the org config — **mostly** correct; one gap fixed in §6.

Legacy edge: a workspace stored with `use_org_defaults: false, use_platform_defaults: true` (live-follows the platform lineup — possible under the old checkbox design) maps to **Custom list**. Its list renders editable; the first add/remove freezes it via the existing materialization in the action (`visibleModelRows` at [lines 378-393](src/routes/_app.settings.organization.models.tsx#L378-L393)). No data migration — the state converges on first edit. (The `Additional models` section is gated on `usePlatformDefaults === false` and stays hidden in this legacy state until the first edit materializes the list; that matches today's behavior.)

---

## 3. Layout

Order, top to bottom, one quiet column: page header → scope pills → source switcher → description line → model list. No cards, no alert boxes, no decorative icons. Switching is instant — no reload, no modal, no confirmation dialog.

### State A — Org scope, camelAI defaults (read-only list)

```
Models
Choose which models appear in your team's picker.

(● Org default)  ( ⬤ Default Workspace ・)  ( ⬤ test )  ( ⬤ sprite )

┌────────────────────┬─────────────┐
│  camelAI defaults  │ Custom list │          ← segmented control, left active
└────────────────────┴─────────────┘
Kept up to date by camelAI. New models appear automatically,
and retired models are removed. Workspaces follow this unless
customized.

In the picker                                            13 of 13
──────────────────────────────────────────────────────────────────
 Ⓐ  Fable 5                                          ← muted rows,
──────────────────────────────────────────────────────────────────    no actions
 Ⓐ  Opus 4.8
──────────────────────────────────────────────────────────────────
 Ⓞ  GPT-5.5
──────────────────────────────────────────────────────────────────
 ...
Switch to a custom list to edit which models appear.     ← muted line
```

### State B — Org scope, custom list (editable)

```
┌──────────────────┬───────────────┐
│ camelAI defaults │ ▌Custom list▐ │
└──────────────────┴───────────────┘
Your org manages this list. New models won't be added
automatically. Workspaces follow this unless customized.

In your picker                                           11 of 13
──────────────────────────────────────────────────────────────────
 Ⓐ  Fable 5                                    ★      [ remove ]
──────────────────────────────────────────────────────────────────
 Ⓐ  Opus 4.8                                   ☆      [ remove ]
──────────────────────────────────────────────────────────────────
 ...

Additional models                                      2 available
 Ⓖ  Gemini 3.5 Flash                                   [  add   ]
 Ⓓ  DeepSeek V4 Flash                                  [  add   ]
```

### State C — Workspace scope, follow org (read-only list)

```
( Org default )  (● ⬤ Default Workspace )  ( ⬤ test )  ( ⬤ sprite )

┌──────────────┬─────────────┐
│ ▌Follow org▐ │ Custom list │
└──────────────┴─────────────┘
This workspace follows your org's setting — currently your
org's custom list of 11 models.                  ← dynamic, see copy table

In the picker                                            11 of 13
──────────────────────────────────────────────────────────────────
 Ⓐ  Fable 5                                      default          ← muted rows;
──────────────────────────────────────────────────────────────────   default shown
 Ⓐ  Opus 4.8                                                          as muted text
──────────────────────────────────────────────────────────────────
 ...
Switch to a custom list to edit which models appear.
```

### State D — Workspace scope, custom list (editable)

```
┌──────────────┬───────────────┐
│  Follow org  │ ▌Custom list▐ │
└──────────────┴───────────────┘
This workspace has its own list. New models won't be added
automatically, and changes to org settings won't affect it.

In your picker                                            9 of 13
 (identical editable list + Additional models as State B)
```

---

## 4. Copy table

The description line is the personality of the screen — it always states the consequence of the current selection. Exact strings:

| State | Description line |
|---|---|
| Org · camelAI defaults | `Kept up to date by camelAI. New models appear automatically, and retired models are removed. Workspaces follow this unless customized.` |
| Org · custom | `Your org manages this list. New models won't be added automatically. Workspaces follow this unless customized.` |
| WS · follow org, org on defaults | `This workspace follows your org's setting — currently camelAI's default lineup, kept up to date.` |
| WS · follow org, org custom | `This workspace follows your org's setting — currently your org's custom list of {N} models.` |
| WS · custom | `This workspace has its own list. New models won't be added automatically, and changes to org settings won't affect it.` |

The dynamic follow-org variants need **no loader changes**: at ws scope with `useOrgDefaults === true`, the loader's `config` is already the org-resolved effective config ([lines 235-238](src/routes/_app.settings.organization.models.tsx#L235-L238)), so `config.usePlatformDefaults` distinguishes the two variants and `{N}` = `config.inPicker.length`.

Other strings:

| Element | Copy |
|---|---|
| Switcher segments, org scope | `camelAI defaults` / `Custom list` |
| Switcher segments, ws scope | `Follow org` / `Custom list` |
| List header, custom (editable) | `In your picker` |
| List header, not custom (read-only) | `In the picker` |
| Count (right of header) | `{used} of {max}` — unchanged |
| Read-only footer line | `Switch to a custom list to edit which models appear.` |

The header variation (`In the picker` vs `In your picker`) matches the prototype: "the" when showing inherited context, "your" when the admin owns the list.

---

## 5. UI implementation

All changes are in [src/routes/_app.settings.organization.models.tsx](src/routes/_app.settings.organization.models.tsx). Delete the two `<Checkbox>` blocks (lines 771-791 and 801-819) and the `Checkbox` import.

### 5.1 Source switcher — shadcn `Tabs` styled as a segmented control

Use the existing `Tabs`/`TabsList`/`TabsTrigger` primitives from [src/components/ui/tabs.tsx](src/components/ui/tabs.tsx) with **no `TabsContent`** — the default `TabsList` variant (`bg-muted rounded-lg p-[3px]`, active trigger gets `bg-background`) is exactly the segmented look in the mock. Do not use `ToggleGroup` here (single-type toggle groups allow deselection; Tabs cannot be deselected, which is the semantics we want).

```tsx
type Source = "default" | "custom";

const SOURCE_SEGMENTS = {
  org: [
    { value: "default", label: "camelAI defaults" },
    { value: "custom", label: "Custom list" },
  ],
  ws: [
    { value: "default", label: "Follow org" },
    { value: "custom", label: "Custom list" },
  ],
} as const;

function submitSource(next: Source) {
  if (data.scope === "ws") {
    submitForm({ intent: "setUseOrgDefaults", useOrgDefaults: String(next === "default") });
  } else {
    submitForm({ intent: "setUsePlatformDefaults", usePlatformDefaults: String(next === "default") });
  }
}

<Tabs
  value={source}                     // optimistic — see §5.4
  onValueChange={(value) => submitSource(value as Source)}
  activationMode="manual"            // arrow keys move focus; Enter/Space commits
>
  <TabsList>
    {SOURCE_SEGMENTS[data.scope].map((segment) => (
      <TabsTrigger
        key={segment.value}
        value={segment.value}
        disabled={isSubmitting}
        className="px-3"
      >
        {segment.label}
      </TabsTrigger>
    ))}
  </TabsList>
</Tabs>
```

`activationMode="manual"` matters: each activation POSTs a mutation, so arrow-key focus must not fire it. `submitForm` is the existing fetcher pattern (`fetcher.submit(..., { method: "post", action: pathname + search })`).

Directly under the switcher, the description line:

```tsx
<p className="text-sm text-muted-foreground">{descriptionLine}</p>
```

Group switcher + description in a `space-y-2` div so they read as one unit; keep the page's outer `space-y-6`. Drop the current `readOnly` banner (`"Inheriting from org defaults. Turn off the toggle to customize."`, [lines 795-799](src/routes/_app.settings.organization.models.tsx#L795-L799)) — the description line replaces it.

### 5.2 Derived state

```tsx
const source: Source =
  data.scope === "ws"
    ? (data.useOrgDefaults ? "default" : "custom")
    : (data.config.usePlatformDefaults ? "default" : "custom");
const editable = source === "custom";
```

`editable` replaces the current `readOnly` flag ([line 688](src/routes/_app.settings.organization.models.tsx#L688)). Keep `editingCustomList` ([line 689](src/routes/_app.settings.organization.models.tsx#L689)) as the gate for the `Additional models` section and the star/remove `disabled` props — it handles the legacy ws state (§2) exactly as today.

### 5.3 Scope pills

Keep the existing `ToggleGroup` ([lines 735-768](src/routes/_app.settings.organization.models.tsx#L735-L768)) with two restyles to match the mock:

- Pills are fully rounded: add `className="rounded-full px-3"` to each `ToggleGroupItem` (keep the `outline` variant and avatars).
- Replace the loud `<Badge variant="secondary">CUSTOM</Badge>` with a quiet indicator on workspaces that have a custom list: `<span aria-hidden className="size-1.5 rounded-full bg-muted-foreground/50" />` plus `<span className="sr-only">has custom list</span>`. The pills should be quiet; the description line carries the explanation once a pill is selected.

Keep the existing visibility rule (selector hidden for single-workspace orgs, ws scope still reachable via `?scope=ws&workspaceId=`, [lines 690-695](src/routes/_app.settings.organization.models.tsx#L690-L695)) — the two cases in `tests/model-settings-ui.test.tsx` stay valid.

### 5.4 Model list

Replace the current `space-y-2` row stack with hairline dividers: wrap rows in `<div className="divide-y divide-border/60">`, rows `py-2.5` (drop per-row `py-1`).

Two render modes for `ModelSettingsRow`, switched by the `editable` flag rather than disabling buttons:

- **Editable (custom mode):** unchanged from today — provider logo, label, star default toggle, `remove` outline button, existing `disabled` wiring. The `Additional models` section renders below a `Separator`, with `add` buttons (existing add pattern is fine per spec).
- **Read-only (defaults / follow-org):** logo + label only, rendered muted (`text-muted-foreground` on the label, `opacity-60` on the logo). **No buttons at all** — not disabled buttons. If the row is the resolved default model, render `<span className="text-xs text-muted-foreground">default</span>` on the right so admins can see what users in that scope get. After the list, one muted line: `Switch to a custom list to edit which models appear.` The `Additional models` section and trailing `Separator` are not rendered.

Keep the empty-custom-list message (`No models in the picker...`) and the existing min-one-model server guard.

### 5.5 Instant switching (optimistic segment + description)

Derive the active segment optimistically from the in-flight fetcher so the switcher and description flip on click, before revalidation:

```tsx
const fd = fetcher.formData;
const pendingSource: Source | null =
  fd?.get("intent") === "setUseOrgDefaults"
    ? (fd.get("useOrgDefaults") === "true" ? "default" : "custom")
    : fd?.get("intent") === "setUsePlatformDefaults"
      ? (fd.get("usePlatformDefaults") === "true" ? "default" : "custom")
      : null;
const source = pendingSource ?? derivedSource;
```

The list itself updates when revalidation lands. That is visually safe: switching to custom snapshots the list the admin was just looking at, and switching back re-resolves — in the common case the rows barely change, only the row chrome (buttons/muting) swaps.

### 5.6 Toasts

Drop the success toasts for the two source-switch intents — the segment + description changing **is** the feedback, and toasts on every flip would fight the "calm and administrative" feel. Keep error toasts everywhere, and keep success toasts for add/remove/set-default as today.

---

## 6. Required behavior fix — freeze the workspace snapshot

One existing-handler gap breaks the description line's honesty and must be fixed; it is ~3 lines inside the existing `setUseOrgDefaults` handler ([lines 446-456](src/routes/_app.settings.organization.models.tsx#L446-L456)).

Today, turning off org defaults seeds the workspace by **copying** `orgConfig.use_platform_defaults`. When the org is on platform defaults, the workspace ends up with `use_platform_defaults: true` — i.e. it keeps live-following platform updates. The new ws-custom description says *"New models won't be added automatically"*, which would be false in exactly that state. The spec is explicit: *"Selecting 'Custom list' snapshots whatever the scope currently resolves to... From that moment the list is frozen with respect to platform updates."*

Change the seeded config to always freeze:

```ts
// inside setUseOrgDefaults, when !useOrgDefaults && target.config.use_org_defaults:
{
  use_org_defaults: false,
  use_platform_defaults: false,                                   // was: orgConfig.use_platform_defaults
  models: visibleModelRows(target.orgConfig, target.visibleModelIds), // was: orgConfig.models
  default_model: target.orgConfig.default_model,
}
```

`visibleModelRows` already does the right thing for both org states: it returns the org's custom rows when the org is custom, and materializes the visible platform lineup when the org is on defaults. Everything else in the handler (normalization, audit details, the `useOrgDefaults=true` direction) is unchanged.

No other action changes. In particular, keep the existing intents and the existing lenient behaviors (e.g. `removeModel` from platform defaults materializing an override) — the new UI simply never sends those requests outside custom mode, and the ws-scope guard at [lines 479-484](src/routes/_app.settings.organization.models.tsx#L479-L484) already covers the follow-org case.

---

## 7. Retain custom lists when switching away

The spec leaves this open (*"Decide whether we retain the custom list so toggling back restores it, or drop it."*) — **decision: retain.** The spec justifies having no confirmation dialog with *"the action is reversible"*; with today's drop semantics it isn't — an org with a curated 5-model list that flips to camelAI defaults and back gets a re-snapshot of the full lineup, not its 5 models. Retaining makes the switcher safe to explore.

Changes:

1. **Parsers** ([src/lib/model-picker-config.ts:93-94](src/lib/model-picker-config.ts#L93-L94) and [117-118](src/lib/model-picker-config.ts#L117-L118)): `const models = usePlatformDefaults ? [] : normalizeModelRows(record.models)` → `const models = normalizeModelRows(record.models)`. The legacy-migration early-returns above those lines are untouched. Every consumer gates on the `use_platform_defaults` flag, not `models.length` (`resolveModelPickerCatalog`, `resolveEffectivePickerConfig`, `buildAdditionalRows`, `visibleModelRows`, loader `hasCustomConfig`) — verify with `grep` before landing.
2. **Org → defaults** ([lines 496-502](src/routes/_app.settings.organization.models.tsx#L496-L502)): stop clearing `models`/`default_model`; only set `use_platform_defaults: true`.
3. **Org → custom** ([lines 503-507](src/routes/_app.settings.organization.models.tsx#L503-L507)): restore-or-snapshot — if the normalized retained `models` are non-empty, use them; else materialize via `visibleModelRows` (current behavior).
4. **WS → custom** (§6 handler): restore-or-snapshot — if the workspace has a retained custom list (`use_platform_defaults === false` and normalized `models` non-empty), only flip `use_org_defaults: false`; else seed the frozen snapshot from §6. (WS → follow already retains today.)

Items 3 and 4 share a shape; if it keeps the action tidy, extract a small helper in the route file, e.g. `restoreOrSnapshot(retained: ModelPickerModelConfig[], snapshot: () => ModelPickerModelConfig[])`, rather than duplicating the branch. Do **not** unify the two intents into one — they set different flags at different scopes, and the existing intent names are load-bearing in tests and audit details.

---

## 8. Tests

**`tests/model-settings-ui.test.tsx`**
- Switcher renders `camelAI defaults`/`Custom list` at org scope and `Follow org`/`Custom list` at ws scope; no checkboxes remain.
- Description line matches the copy table per state, including both dynamic follow-org variants.
- Read-only mode: rows have no buttons, footer line present, `Additional models` absent, header says `In the picker`.
- Custom mode: remove/star/add render, header says `In your picker`.
- Keep the two single-workspace-org cases as-is.

**`tests/model-settings-action.test.ts`**
- Update `seeds workspace picker overrides from org config when disabling org defaults`: when the org is on platform defaults, expect `use_platform_defaults: false` with materialized `models` (the §6 fix).
- Keep the org-custom seeding case (`preserves a null org default when seeding workspace overrides`) — expectations unchanged apart from the frozen flag.
- New retention cases (§7): org → defaults retains `models`/`default_model`; org → custom restores a retained list; ws → custom restores a retained workspace list; a retained list whose models are all provider-invisible falls back to a fresh snapshot.
- All other existing cases (`removing a model from platform defaults creates a custom override list`, provider-compatibility, loader cases) remain valid as-is.

**`tests/model-picker-config.test.ts`**
- New: both parsers retain `models` when `use_platform_defaults: true` (§7). Existing legacy-migration cases exercise the early-return paths and are unchanged.

Run: `bun run typecheck`, `bun run test:run -- tests/model-settings-ui.test.tsx tests/model-settings-action.test.ts tests/model-picker-config.test.ts`.

---

## 9. Out of scope

- The chat composer's model picker and `resolveModelPickerCatalog` resolution order — unchanged.
- Loader payload, action intent names, DO methods (`getModelPickerConfig` / `setModelPickerConfig`), storage schema — all unchanged.
- Setting an org default model while on camelAI defaults (the star remains custom-mode-only, as today). Real feature gap, separate task.
- Drag-to-reorder, model metadata changes, pricing.
