# Models Settings — Source Switcher: Implementation Feedback (Round 2)

**Date:** 2026-06-12
**Plan:** `docs/models-settings-source-switcher-plan.md`
**Prior feedback:** `docs/models-settings-source-switcher-feedback.md` (round 1)
**Verified:** `bun run typecheck` clean; `bun run test:run -- tests/model-settings-ui.test.tsx tests/model-settings-action.test.ts tests/model-picker-config.test.ts` → 47/47 pass.

Round-1 feedback is fully addressed: shortened description copy is in place; the transient wrong-description bug is fixed via the `orgResolvedDataAvailable = data.useOrgDefaults` gate (falls back to the clause-free "This workspace follows your org's setting." while an optimistic flip is in flight); `customConfigFromRetainedOrSnapshot` now returns `{ config, restoredRetainedList }` and is used by both the org and workspace-seeding paths; audit details report `restored_retained_list` with a corrected `seeded_from_org_defaults`; and the empty-picker message is gated on `editable`. Nothing to revisit there.

---

## 1. Empty state for "Additional models" (new — requested)

**Verdict: good idea, keep it — just capitalize the sentence.** When the custom list contains every visible model, the `Additional models` section renders its header and `0 available` over an empty `divide-y` div, which looks like it's hanging. A muted empty-state line fixes that and reads as intentional.

The copy is also *accurate*, which is why it's worth adding rather than generic filler. The additional list is, by definition, every visible model **not** in the picker — so it's empty precisely when the picker holds everything, and the only way to repopulate it is to remove a model. "Models you remove will show up here." states that truthfully and teaches the two lists' relationship in one line. (It's correct in both cases the section can be empty: immediately after switching to a custom list — the snapshot starts with every model — and after adding everything back.)

Capitalize "Models" since it stands alone as a sentence. Implementation mirrors the existing empty-state pattern already used by "In your picker" (`py-2 text-sm text-muted-foreground`):

```tsx
<div className="flex items-center justify-between">
  <h2 className="text-sm font-medium">Additional models</h2>
  <span className="text-sm text-muted-foreground">
    {data.config.additional.length} available
  </span>
</div>
{data.config.additional.length === 0 ? (
  <p className="py-2 text-sm text-muted-foreground">
    Models you remove will show up here.
  </p>
) : (
  <div className="divide-y divide-border/60">
    {data.config.additional.map((entry) => (
      <ModelSettingsRow
        key={entry.id}
        row={{ entry }}
        actionLabel="add"
        onAction={(model) => submit("addModel", model)}
        editable
        actionDisabled={isSubmitting}
      />
    ))}
  </div>
)}
```

Add a UI test in `tests/model-settings-ui.test.tsx`: a custom-scope loader payload with `config.additional: []` asserts `Models you remove will show up here.` is present and no `add` button renders. The `renders org custom lists with edit controls` case already covers the non-empty branch.

## 2. Minor — read-only empty picker stacks two muted lines (optional)

A scope that is read-only **and** has an empty picker (e.g. a workspace following an org whose custom list is intentionally empty) renders both `No models in the picker.` and, just below it, `Switch to a custom list to edit which models appear.` The second line is technically true but reads oddly stacked under the first, and "switch to a custom list" isn't really the fix for an empty *org* list when you're a follower.

Low priority — this only occurs with an intentionally-empty upstream custom list. If you want it tidy, suppress the footer line when the picker is empty:

```tsx
{!editable && data.config.inPicker.length > 0 && (
  <p className="text-sm text-muted-foreground">
    Switch to a custom list to edit which models appear.
  </p>
)}
```

No other issues. Items: §1 requested, §2 optional. Re-run `bun run typecheck` and the three test files after §1.
