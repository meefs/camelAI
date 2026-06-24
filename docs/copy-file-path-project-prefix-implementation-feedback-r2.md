# Copy File Path Project Prefix Implementation Feedback R2

The previously reported stale-project bug is fixed: `Chat` now refreshes mention sources when a VM preview references a project that is missing from the current mention map, and the formatter now resolves project handles by normalized key.

I found one remaining copy-path edge before PR.

## VM Search Copy Misses Root-Level Files

Severity: P2

`src/components/tool-call/details/search-details.tsx` only treats a search result line as a file path when the base path starts with `/`, `./`, `../`, or contains `/`:

```ts
if (
  base.startsWith('/') ||
  base.startsWith('./') ||
  base.startsWith('../') ||
  base.includes('/')
) {
  // parsed as a copyable path
}
```

That misses root-level VM project files like `test.html` or `README.md`. The project VM `find`/`grep` output can return paths relative to the searched root, so searching `/workspace` for the user’s repro files can produce:

```text
Found 2 files
test.html
test-2.html
```

Because neither line contains `/`, `parsedLines` is empty and the component falls back to `OutputBlock copyValue={lines}`. That copied output is not routed through `formatCopyFilePath`, so the clipboard still lacks the project prefix:

```text
test.html
test-2.html
```

Expected for a VM search result list:

```text
@test - test.html
@test - test-2.html
```

Recommended fix:

- Teach `SearchDetails` to accept bare relative file paths for VM search result lists.
- Keep the existing conservative parser for unrelated output, but for `location === "vm"` and `mode === "glob"` every filtered result line is a file path.
- For `mode === "grep"`, allow the colon prefix to be a bare filename when the line is already in parsed search results, e.g. `test.html:12:hello`.
- Add a regression test in `tests/tool-detail-file-copy.test.tsx` with `mode="glob"`, `location="vm"`, `project="Thread Review Dashboard"`, and result lines `test.html` plus `nested/page.html`. Assert both copied lines are prefixed.

The existing test only covers `/src/App.tsx` and `/src/lib/query.ts:...`, so it does not exercise this root-level path case.

## Verification Run

Already run during review:

```bash
bun run test:run -- tests/file-path-copy.test.ts tests/preview-toolbar-notebook-download.test.tsx tests/tool-detail-file-copy.test.tsx tests/chat-mention-sources-refresh.test.tsx
bun run typecheck
```

Both passed.
