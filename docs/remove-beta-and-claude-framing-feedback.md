# Feedback — Remove Beta Tag & Claude-Specific Framing

Reviewed against `docs/remove-beta-and-claude-framing-plan.md`.

## Summary

The source changes are correct and complete. One required fix: **4 test files
were deleted instead of updated.** They cover the file-editing-disabled behavior,
which still exists — only the *naming* ("beta") changed, not the behavior. Delete
was the wrong move; they need to be restored and updated so we keep regression
coverage on the file-mutation block.

(One incidental note: removing `useSidebar`/`state` from `app-sidebar.tsx` was
fine — the plan's warning to "keep `state`" was wrong; `state` had no other
references. No action needed there.)

---

## Required: restore and update the 4 deleted tests

The plan said to **update and run** these tests, not delete them. The behavior
they guard is still live and explicitly flagged in `AGENTS.md` ("Add tests when
changing … file safety, or persistence semantics"; "Computer tab file mutations
may be intentionally blocked … before changing write behavior"). Three of them
also fail *only* because of the rename, not because the behavior changed.

Restore each from git (they still exist at HEAD):

```bash
git checkout HEAD -- \
  tests/computer-file-editing-beta.test.tsx \
  tests/ext-files-write-beta.test.ts \
  tests/workspace-beta-file-edit-helper.test.ts \
  tests/workspace-file-mutation-beta-routes.test.ts
```

Then apply these edits so they match the renamed helper and new copy. The two
mechanical substitutions across all four files:

- `blockBetaFileEdit` → `blockFileEdit`
- `'File editing is disabled during beta.'` → `'File editing is disabled.'`

Per-file specifics:

### `tests/workspace-beta-file-edit-helper.test.ts`
- Import `{ blockFileEdit }` from `@/routes/api/workspaces.utils` (was
  `blockBetaFileEdit`).
- `describe('blockBetaFileEdit', …)` → `describe('blockFileEdit', …)`.
- Call `blockFileEdit()`; assert payload `{ error: 'File editing is disabled.' }`.

### `tests/ext-files-write-beta.test.ts`
- `vi.mock('@/routes/api/workspaces.utils', () => ({ blockFileEdit: blockFileEditMock }))`
  — the mocked export key **must** be `blockFileEdit`, or `ext.files.write.ts` /
  `ext.files.upload.ts` import `undefined` and the routes throw.
- Rename the mock var (`blockBetaFileEditMock` → `blockFileEditMock`) and update
  the mocked 403 body to `'File editing is disabled.'` and all assertions.

### `tests/workspace-file-mutation-beta-routes.test.ts`
- Same mock-key fix: export `blockFileEdit` from the `workspaces.utils` mock.
- Update `blockedResponse()` body and assertions to `'File editing is disabled.'`.

### `tests/computer-file-editing-beta.test.tsx`
- This one would still pass unchanged (it asserts the read-only badge renders and
  Save is disabled), but update the stale string on the `queryByText(...)` line
  from `'File editing is disabled during beta.'` → `'File editing is disabled.'`
  and rename the `describe('ComputerPageContent beta read-only mode', …)` title
  to drop "beta". Keep the test — its coverage (Read-only badge, disabled Save,
  no editing toggle) is still valid and worth keeping.

### Optional polish (recommended for consistency with the A5 rename)
Rename the files to drop "beta", matching the identifier rename:
- `workspace-beta-file-edit-helper.test.ts` → `workspace-file-edit-helper.test.ts`
- `ext-files-write-beta.test.ts` → `ext-files-write.test.ts`
- `workspace-file-mutation-beta-routes.test.ts` → `workspace-file-mutation-routes.test.ts`
- `computer-file-editing-beta.test.tsx` → `computer-file-editing.test.tsx`

Run `bun run test:run` on these four after updating, and `bun run typecheck`.

---

## Verified correct (no action needed)

- **Sidebar badge** removed cleanly; unused `Badge`, `useSidebar`, `state` all
  dropped. No dangling refs.
- **Welcome screen**: `BetaNotice`, `helpOpen`, and the orphaned `GetHelpDialog`
  + imports removed. Feedback still reachable via the sidebar "Get Help".
- **`beta-notice.tsx`** deleted (had only the one importer).
- **Onboarding subhead** reads exactly: "camelAI is your AI software engineer.
  Your agents have a permanent computer here, so they can build, deploy, and
  maintain applications for you."
- **Delete dialog** softened to the single sentence; the two `<br></br>` and the
  Claude sentence are gone.
- **File-editing copy**: constant `FILE_EDIT_DISABLED_MESSAGE = 'File editing is
  disabled.'`, all three render sites updated, `canMutate` comment reworded,
  read-only behavior preserved (not re-enabled).
- **A5 rename**: `blockBetaFileEdit` → `blockFileEdit` + message + doc comment in
  `workspaces.utils.ts`, and the import + "Beta:" comment updated across all 8
  fs/ext route files. No stale `blockBetaFileEdit` / `BETA_FILE_EDIT_DISABLED_MESSAGE`
  / "during beta" references remain in `src`, `workers`, or `tests`.
- **KEEP list honored**: model picker, providers, `/home/claude` paths, and
  internal/admin Claude references untouched. `get-help-dialog.tsx` untouched as
  planned (its now-unused optional `defaultCategory` prop is harmless — leave it).
