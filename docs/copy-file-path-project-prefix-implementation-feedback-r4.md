# Copy File Path Project Prefix Implementation Feedback R4

This follow-up covers the two code-review findings:

- P2: mention source refresh only scans `previewTabs`, so tool detail copy rows can still use a stale project map.
- P3: VM glob parsing treats too many non-path output lines as paths.

## 1. Refresh Mention Sources For Tool-Only VM Projects

Severity: P2

Current implementation in `src/components/Chat.tsx` refreshes `/api/workspaces/:id/mentions` when a VM file preview tab references a project that is missing from `mentionSlugMap`.

That fixes active preview copy, but tool detail rows use the same `formatFilePathForCopy()` context. If a newly-created VM project only appears in a read/write/edit/notebook/search tool call and no VM preview tab is open, the map remains stale and tool-row copy buttons fall back to raw paths.

### Required Architecture

Move from “scan preview tabs” to “scan every visible copy-path source that can reference a VM project.”

Add a shared client-side extractor near the copy formatter logic, for example `src/lib/file-path-copy.ts` or a new browser-safe `src/lib/file-copy-projects.ts`:

```ts
export interface VmProjectReference {
  project: string;
  source: "preview" | "tool";
}

export function collectVmProjectReferencesFromPreviewTabs(
  tabs: readonly PreviewTab[],
): VmProjectReference[];

export function collectVmProjectReferencesFromMessages(
  messages: readonly Message[],
): VmProjectReference[];
```

Keep this extractor pure and browser-safe. It should not import Worker modules.

### Message Extraction Rules

Only extract from tool inputs/results that actually produce file-copy targets:

- `tool_use` blocks for `read`, `write`, `edit`, `NotebookEdit`, `grep`, `glob`, and aliases normalized in `ToolCallDetails` (`Read`, `Write`, `Edit`, `Grep`, `Glob`, `NotebookEdit` if needed).
- A reference is valid when `input.location === "vm"` and `input.project` is a non-empty string.
- Do not infer projects from shell commands or arbitrary output text.
- Do not inspect generic markdown text; copied prose should not trigger mention refresh.

The path is not important for refresh. The project is.

### Chat Integration

Replace the current preview-tab-only loop with a combined source list:

```ts
const visibleVmProjectReferences = useMemo(
  () => [
    ...collectVmProjectReferencesFromPreviewTabs(previewTabs),
    ...collectVmProjectReferencesFromMessages(visibleMessages),
  ],
  [previewTabs, visibleMessages],
);
```

Then the existing refresh effect should iterate `visibleVmProjectReferences` instead of `previewTabs`.

Continue to:

- Skip projects already present in `mentionSlugMap` via `resolveProjectMentionSlug`.
- Normalize attempted refresh keys with `normalizeProjectCopyLookupKey`.
- Track attempted keys in a ref and clear it on `resolvedWorkspaceId` / `threadId`.
- Fetch at most one missing project per effect pass to avoid parallel duplicate `mentionSourcesFetcher.load()` calls.

This keeps the behavior bounded while covering both preview-toolbar and tool-row copy surfaces.

### Tests

Extend `tests/chat-mention-sources-refresh.test.tsx` with a tool-only case:

1. Render `Chat` with `initialMessages` containing an assistant `tool_use` block:

```ts
{
  type: "tool_use",
  id: "tool_read",
  name: "read",
  input: {
    location: "vm",
    project: "test",
    path: "/test.html",
  },
}
```

2. Do not provide `initialPreviewTabs`.
3. Initial `projects` should not include `test`.
4. Assert the mentions fetcher loads `/api/workspaces/ws-1/mentions`.
5. After setting fetcher data to include the project and rerendering, assert:

```ts
latestPreviewContextValue.current?.formatFilePathForCopy?.({
  source: "vm",
  project: "test",
  path: "/test.html",
}) === "@test - /test.html"
```

Also add a negative test for a non-VM tool input or a VM shell command so the extractor does not overfetch.

## 2. Make VM Glob Bare-Path Parsing Selective

Severity: P3

Current `SearchDetails.parseLine()` treats every non-empty, non-no-result VM glob line as a path:

```ts
if (options.isVmSearch && options.mode === "glob") {
  return { path: trimmed, suffix: "", raw: trimmed };
}
```

This handles root-level files like `test.html`, but it also catches legacy notices such as:

```text
[1000 results limit reached; narrow your search]
```

Those notices can render and copy as:

```text
@project - [1000 results limit reached; narrow your search]
```

### Required Architecture

Do not use a pure “everything is a path” branch. Introduce a narrower helper:

```ts
function isVmGlobBareRelativePath(line: string): boolean {
  if (!line) return false;
  if (isSearchNoticeLine(line)) return false;
  if (line.startsWith("[") && line.endsWith("]")) return false;
  if (line.includes("\0")) return false;
  if (line.includes(":")) return false;
  return /^[^\s/][^\s]*$/.test(line);
}
```

The exact implementation can differ, but the contract should be:

- Accept root-level relative filenames such as `test.html`, `README.md`, `package.json`, `.env.example`.
- Accept nested relative paths through the existing `base.includes("/")` branch.
- Reject bracketed notices.
- Reject no-result sentinels (`No files found...`, `No matches found...`) as it already does.
- Reject obvious prose with spaces.
- Preserve existing absolute/`./`/`../` behavior.

Then change the VM glob branch to:

```ts
if (options.isVmSearch && options.mode === "glob" && isVmGlobBareRelativePath(trimmed)) {
  return { path: trimmed, suffix: "", raw: trimmed };
}
```

### Tests

Extend `tests/tool-detail-file-copy.test.tsx`:

- Keep the existing root-level VM glob positive case.
- Add a mixed output case:

```text
Found 2 files
test.html
[1000 results limit reached; narrow your search]
nested/page.html
```

Expected copied list:

```text
@thread_review_dashboard - test.html
@thread_review_dashboard - nested/page.html
```

The bracketed notice should remain absent from the rendered `Files` list and copied value.

Also keep the no-result sentinel regression test from R3.

## Verification

Run:

```bash
bun run test:run -- tests/file-path-copy.test.ts tests/preview-toolbar-notebook-download.test.tsx tests/tool-detail-file-copy.test.tsx tests/chat-mention-sources-refresh.test.tsx
bun run typecheck
```

If a new extractor unit test is added, include it in the focused test command.
