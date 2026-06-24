# Copy File Path Project Prefix Implementation Feedback R3

The previously flagged stale-project bug is fixed, and the root-level VM search result copy case is now covered.

I found one remaining regression in the new VM glob parsing.

## VM Glob No-Result Messages Become Fake File Paths

Severity: P2

`src/components/tool-call/details/search-details.tsx` now parses every VM glob result line as a file path:

```ts
if (options.isVmSearch && options.mode === 'glob') {
  return {
    path: trimmed,
    suffix: '',
    raw: trimmed,
  };
}
```

That correctly handles root-level files like `test.html`, but it also treats the no-results sentinel as a real file. Both relevant backends can return this exact text:

- `workers/main/src/project-runtime-service-vm.ts`: `No files found matching pattern`
- `workers/main/src/pi-container-tools.ts`: `No files found matching pattern`

For a VM glob with no matches, the details UI will now render a `Files` list containing `No files found matching pattern`, and `Copy list` will put this on the clipboard:

```text
@thread_review_dashboard - No files found matching pattern
```

Expected behavior: keep the old no-result output behavior and do not render/copy it as a file path.

Recommended fix:

- Filter no-result sentinels before `parseLine`, or make the VM glob bare-path branch reject them.
- At minimum, treat these as non-path output:
  - `/^No files found/i`
  - `/^No matches found/i`
- Add a regression test in `tests/tool-detail-file-copy.test.tsx` for VM glob no-results. Assert that there is no `Copy list` button and that the fallback output text is still shown/copyable as plain output, not project-prefixed path text.

The existing root-level VM glob test should stay; it covers the intended behavior for real bare relative file paths.

## Verification Run

Already run during review:

```bash
bun run test:run -- tests/file-path-copy.test.ts tests/preview-toolbar-notebook-download.test.tsx tests/tool-detail-file-copy.test.tsx tests/chat-mention-sources-refresh.test.tsx
bun run typecheck
```

Both passed.
