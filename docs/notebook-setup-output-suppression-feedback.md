# Notebook Setup Output Suppression Feedback

## Findings

### 1. Regenerate the bundled Pi skills file before merging

**Severity:** High

`sandbox/skills/data-analysis/SKILL.md` was updated with the new notebook guidance, but `workers/main/src/pi-skills-bundle.ts` was not regenerated.

This matters because the Worker Durable Object serves bundled skills from `workers/main/src/pi-skills-bundle.ts` when it cannot read the host filesystem directly. The generated file explicitly says to regenerate it when `sandbox/skills` changes, and the repo check currently fails:

```text
$ bun run check:pi-skills
workers/main/src/pi-skills-bundle.ts is stale. Run `bun run generate:pi-skills`.
```

Fix:

```bash
bun run generate:pi-skills
```

Then include the resulting `workers/main/src/pi-skills-bundle.ts` diff.

Relevant files:

- `sandbox/skills/data-analysis/SKILL.md`
- `workers/main/src/pi-skills-bundle.ts`
- `scripts/generate-pi-skills-bundle.mjs`

## Notes

The core renderer/export implementation is aligned with the plan:

- `isIgnorableTextOutput()` stays in `utils.ts`.
- Report mode filters before the `reportOutputs.length === 0` check, so ignorable-only cells do not leave empty wrappers.
- Report export/PDF uses the same filter.
- Notebook mode is untouched.
- `getOutputRender()` is untouched.
- The helper is conservative and avoids the broad generic `<.* object at 0x...>` pattern.

The validator and UI helper intentionally duplicate the same pattern policy in Python and TypeScript. That is acceptable for this change, but future additions should update both sides together and add tests in both places.

## Verification

Focused tests pass:

```bash
bun run test:run -- tests/notebook-preview-utils.test.ts tests/notebook-report-export-model.test.ts tests/validate-notebook.test.ts
```

Result:

```text
Test Files  3 passed (3)
Tests      38 passed (38)
```

Generated-skill check fails until the bundle is regenerated:

```bash
bun run check:pi-skills
```
