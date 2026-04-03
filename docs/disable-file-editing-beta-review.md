# Review: Disable File Editing in Computer Tab During Beta

## Verdict

Ready to merge. Route body restoration is correct, tests are solid, all 655 tests pass.

One minor known issue (not a blocker): 7 new TypeScript errors in dead code after the early `return`. See details below.

## Route changes (server-side)

All 7 mutation routes now follow the correct pattern: auth check, then `return blockBetaFileEdit()`, then the original implementation preserved as dead code below. Rollback is "remove one line per file + delete the helper."

Reviewed files:
- `src/routes/api/workspaces.$id.fs.write.ts` — correct
- `src/routes/api/workspaces.$id.fs.create.ts` — correct
- `src/routes/api/workspaces.$id.fs.delete.ts` — correct
- `src/routes/api/workspaces.$id.fs.mkdir.ts` — correct
- `src/routes/api/workspaces.$id.fs.move.ts` — correct
- `src/routes/api/workspaces.$id.fs.upload.ts` — correct
- `src/routes/api/ext.files.write.ts` — correct
- `src/routes/api/workspaces.utils.ts` — `blockBetaFileEdit()` helper is clean

### Known issue: 7 new TypeScript errors in dead code

The early `return blockBetaFileEdit()` makes the code below it unreachable. TypeScript's control flow analysis doesn't carry type narrowing past a `return`, so:

- **`ext.files.write.ts:18`** — `authResult` loses its `instanceof Response` narrowing in the dead path, so `getContainer(env, authResult)` sees the full `Response | TokenGrantRecord` union instead of just `TokenGrantRecord`.
- **`workspaces.$id.fs.upload.ts:40,41,50,55,74,75`** — `file` loses its `!file` null-check narrowing in the dead path (the null check is below the early return), so all `file.*` accesses see `File | null`.

These are harmless — the code is unreachable at runtime — and the project already has 21 pre-existing type errors (CI doesn't gate on typecheck). They'll disappear when the early return is removed. Not worth adding `// @ts-expect-error` noise to dead code.

Baseline: 21 type errors. With changes: 27 type errors (+6 in `upload.ts`, +1 in `ext.files.write.ts`). None in live code paths.

## Frontend changes

`src/components/pages/computer/computer-page-content.tsx` — all correct:

- `canMutate = false` cascades through 40+ references — editor read-only, all mutation controls disabled, drag-drop off, save shortcut no-op
- "Enable editing" toggle replaced with static "File editing is disabled during beta." label
- Confirmation dialog removed entirely
- Context menu "Enable editing..." replaced with disabled beta message item
- "Open a file to inspect it" — good copy change
- Read-only hint updated to beta message
- `editingEnabled` state, `confirmEditOpen` state, `handleEnableEditing` callback, `localStorage` persistence of editing state all removed cleanly
- Unused imports removed (`useFetcher`, `Switch`, `ConfirmDialog`, `Upload` icon) — all confirmed unused

## Tests

4 new test files, 9 tests total — all pass:

- **`workspace-beta-file-edit-helper.test.ts`** — unit test for `blockBetaFileEdit()` helper (status 403, correct error payload)
- **`workspace-file-mutation-beta-routes.test.ts`** — parameterized test covering all 6 workspace `fs/*` routes, verifies auth runs first, then block fires before body parsing (good: uses invalid JSON bodies to prove the body is never read)
- **`ext-files-write-beta.test.ts`** — same pattern for `ext.files.write`, verifies bearer auth runs first, then block fires
- **`computer-file-editing-beta.test.tsx`** — renders `ComputerPageContent`, asserts beta message visible, Save disabled, no Switch element, no "Enable editing" text

Full suite: **655 tests pass, 94 test files, 0 failures.**

## AGENTS.md

New "Computer Tab File Mutations" section is accurate and concise. Covers the block, the affected routes, and what remains enabled.

## Not reviewed (out of scope)

- External MCP `write_file` tool — separate path through `ExternalMcpDO` / sandbox-host, not through these routes
- Hidden `<input type="file">` element for upload trigger — harmless since `canMutate` is false client-side and server rejects with 403
