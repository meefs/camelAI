# Models Settings — Source Switcher: Implementation Feedback

**Date:** 2026-06-12
**Plan:** `docs/models-settings-source-switcher-plan.md`
**Verified:** `bun run typecheck` clean; `bun run test:run -- tests/model-settings-ui.test.tsx tests/model-settings-action.test.ts tests/model-picker-config.test.ts` → 45/45 pass.

The implementation matches the plan: parser retention (§7.1), org retain/restore (§7.2–7.3), frozen workspace seeding with restore-or-snapshot (§6 + §7.4), provider-invisible fallback, segmented `Tabs` switcher with `activationMode="manual"`, optimistic source, read-only rows with the `default` marker, pill restyle, toast trimming, and the test coverage called for in §8. Items below are fixes, ordered by priority.

---

## 1. Copy changes (required — updated wording from Illiana)

Replace the description-line strings in `sourceDescription` ([src/routes/_app.settings.organization.models.tsx](src/routes/_app.settings.organization.models.tsx), the ternary near the top of `OrganizationModelsPage`). Exact strings:

| State | New copy |
|---|---|
| Org · camelAI defaults | `Kept up to date by camelAI. New models appear automatically and retired models are removed.` |
| Org · custom | `You manage this list. New models won't be added automatically.` |
| WS · follow org, org on defaults | `This workspace follows your org's setting, which is currently camelAI's default lineup.` |
| WS · follow org, org custom | `This workspace follows your org's setting, which is currently a custom list.` |
| WS · custom | unchanged |

Notes:

- The "Workspaces follow this unless customized." sentences are dropped from both org lines.
- No comma before "and" in the org-defaults line.
- The follow-org lines switch from the em-dash construction to ", which is currently …" and **no longer interpolate the model count** — the `${data.config.inPicker.length}` usage goes away.

Update the four UI test assertions that pin the old strings in `tests/model-settings-ui.test.tsx`: `shows workspace override controls for a single-workspace org`, `renders org defaults as a read-only picker list`, `renders org custom lists with edit controls`, and `describes a workspace following a custom org list` (this one currently asserts the `of 2 models` count — assert the new static string instead).

## 2. Transient wrong description when switching WS Custom → Follow org (bug)

When the admin flips a custom workspace back to "Follow org", `pendingSource` becomes `"default"` immediately, but `data.config` is still the **workspace's own custom config** until revalidation lands. The follow-org branch of `sourceDescription` reads `data.config.usePlatformDefaults` from that stale config, so for a beat it claims the org's setting is "currently a custom list" even when the org is on camelAI defaults.

Fix: the dynamic clause is only trustworthy when the loader data was actually computed in follow-org mode (`data.useOrgDefaults === true`). While the optimistic flip is in flight, render the sentence without the clause:

```tsx
const orgResolvedDataAvailable = data.useOrgDefaults; // loader's config is org-resolved
// WS · follow-org branch:
orgResolvedDataAvailable
  ? data.config.usePlatformDefaults
    ? "This workspace follows your org's setting, which is currently camelAI's default lineup."
    : "This workspace follows your org's setting, which is currently a custom list."
  : "This workspace follows your org's setting."
```

Add a UI test case: render with the fetcher mock's `formData` set to `{ intent: "setUseOrgDefaults", useOrgDefaults: "true" }` and `useOrgDefaults: false` loader data, and assert the clause-free sentence.

## 3. Use the helper in the workspace seeding branch (optional cleanup)

`customConfigFromRetainedOrSnapshot` was added per the plan but is only used by the org path; the `setUseOrgDefaults` handler reimplements restore-or-snapshot inline (`canRestoreWorkspaceList` + the two-branch ternary). The inline logic is correct, but the duplication is what the helper existed to avoid. Equivalent unification:

```ts
const nextConfig =
  !useOrgDefaults && target.config.use_org_defaults
    ? {
        ...customConfigFromRetainedOrSnapshot(
          target.config,
          target.orgConfig,
          target.visibleModelIds,
        ),
        use_org_defaults: false,
      }
    : { ...target.config, use_org_defaults: useOrgDefaults };
```

Behavior note: the inline version gates restore on `use_platform_defaults === false` while the helper only checks normalized `models.length`. The two are equivalent for every state this code can write (retained lists are always stored with `use_platform_defaults: false`; legacy live-follow rows have empty `models`), so the swap is safe. Keep the action tests green as the proof.

## 4. Audit detail claims seeding on restores (optional)

`setUseOrgDefaults` logs `seeded_from_org_defaults: true` even when it restored a retained workspace list (nothing was seeded from the org). Make the details truthful:

```ts
details: {
  intent,
  workspace_id: target.workspace.id,
  use_org_defaults: useOrgDefaults,
  restored_retained_list: canRestoreWorkspaceList,
  seeded_from_org_defaults:
    !useOrgDefaults && target.config.use_org_defaults && !canRestoreWorkspaceList,
}
```

(If item 3 is taken, derive `canRestoreWorkspaceList` the same way the helper does, or have the helper report which branch it took.)

## 5. Empty-list message references controls that read-only mode doesn't have (optional)

A workspace following an org with an intentionally-empty custom list renders `No models in the picker. Add at least one below for your team to chat.` — but in read-only mode there is no add section "below". Gate the copy:

```tsx
{editable
  ? "No models in the picker. Add at least one below for your team to chat."
  : "No models in the picker."}
```
