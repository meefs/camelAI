# Copy File Path Project Prefix Implementation Feedback R5

This follow-up covers the new code-review finding:

- P2: VM search result rows are copied and opened as raw result paths instead of paths resolved against the searched root.

## Resolve VM Search Results Against The Search Root

Severity: P2

`src/components/tool-call/details/search-details.tsx` currently parses each result line into `entry.path`, then uses that same value for both `Copy list` and the rendered `FileLink`.

That is wrong for VM `find`/`grep` output. The project runtime resolves the searched `input.path`, then returns paths relative to that search root. For example, a VM search under `/src` can return:

```text
App.tsx
nested/page.html
```

Those rows refer to:

```text
/src/App.tsx
/src/nested/page.html
```

Current behavior copies or opens:

```text
@thread_review_dashboard - App.tsx
@thread_review_dashboard - nested/page.html
```

The rendered `FileLink` has the same problem because it receives `path={entry.path}` without a VM `previewTarget`; `FileLink` then falls back to `buildFilePreviewLinkTarget({ path })`, which treats the path as a workspace-root file.

### Required Architecture

Separate the parsed display path from the resolved file target path.

Update the parsed row shape in `search-details.tsx` so it carries both values:

```ts
type ParsedLine = {
  path: string;          // display path from tool output, e.g. "App.tsx"
  resolvedPath: string;  // VM preview/copy path, e.g. "/src/App.tsx"
  suffix: string;        // grep suffix, e.g. ":42:const query = true"
  raw: string;
};
```

For non-VM searches, `resolvedPath` can equal `path`. For VM searches, derive it by resolving the parsed result path against the normalized `input.path`.

### VM Path Resolution Rules

Add a small browser-safe helper in `search-details.tsx` or a nearby shared utility if that keeps the component cleaner:

```ts
function resolveVmSearchResultPath(resultPath: string, searchRoot: string): string | null;
```

The helper should mirror the normalization contract used by `src/lib/file-preview-target.ts`:

- Convert backslashes to slashes.
- Collapse repeated slashes.
- Treat `/workspace`, `/home/claude`, and `/root` as project-root aliases and strip them.
- Return canonical absolute project paths such as `/src/App.tsx`.
- Reject paths that still contain `..` after normalization rather than creating clickable/copyable unsafe targets.

Resolution rules:

- Absolute VM output such as `/workspace/src/App.tsx`, `/home/claude/src/App.tsx`, `/root/src/App.tsx`, or `/src/App.tsx` should normalize to `/src/App.tsx`.
- Relative output such as `App.tsx`, `nested/page.html`, or `./App.tsx` should be joined under the normalized search root.
- `../` output should only be accepted if the normalized result stays inside the project root; otherwise treat the line as non-clickable/non-copyable output.
- A search root of `/workspace`, `/home/claude`, `/root`, or `/` should resolve `test.html` to `/test.html`.
- A search root of `/workspace/src` or `/src` should resolve `App.tsx` to `/src/App.tsx`.

Do not change the `Path:` detail row behavior. That row represents the searched root and can keep using `copyTargetFromToolInput(input, path)`.

### Copy Formatting

Do not format the raw result line as a path. Format the resolved path, then append the grep suffix.

Current behavior effectively does this for grep lines:

```ts
formatCopyFilePath({ path: "App.tsx:42:const query = true", source: "vm", project })
```

Instead, build copied lines from parsed entries:

```ts
const formattedPath =
  previewContext?.formatFilePathForCopy?.(copyTargetFromToolInput(input, entry.resolvedPath)) ??
  formatCopyFilePath(copyTargetFromToolInput(input, entry.resolvedPath), {
    fallbackProjectMention: true,
  });

return `${formattedPath}${entry.suffix}`;
```

That preserves grep context while keeping only the actual filename in the path formatter:

```text
@thread_review_dashboard - /src/App.tsx:42:const query = true
```

For glob/list rows without suffixes, copy one formatted `resolvedPath` per line.

### FileLink Preview Targets

Pass a VM-aware preview target into the rendered file links. The display can remain the raw path from the tool output, but click behavior should use the resolved path.

Use `buildFilePreviewLinkTarget` with the same location/project metadata as the tool input:

```tsx
const previewTarget = buildFilePreviewLinkTarget({
  path: entry.resolvedPath,
  location: input.location,
  project: input.project,
});

<FileLink
  path={entry.resolvedPath}
  previewTarget={previewTarget}
  mono
  className="truncate text-muted-foreground/80"
>
  {entry.path}
</FileLink>
```

This prevents VM search results from opening workspace files with the same relative name.

### Tests

Extend `tests/tool-detail-file-copy.test.tsx`.

Add a VM glob test that searches a non-root path:

```ts
tool={makeTool("glob", {
  location: "vm",
  project: "Thread Review Dashboard",
  pattern: "*.tsx",
  path: "/src",
})}
result={makeResult([
  "Found 2 files",
  "App.tsx",
  "nested/page.tsx",
].join("\n"))}
```

Expected copy:

```text
@thread_review_dashboard - /src/App.tsx
@thread_review_dashboard - /src/nested/page.tsx
```

Add a VM grep test under `/src`:

```text
Found 1 matches
App.tsx:42:const query = true
```

Expected copy:

```text
@thread_review_dashboard - /src/App.tsx:42:const query = true
```

Update the existing VM glob `/workspace` test. Since `/workspace` normalizes to the project root, root-level output should copy as:

```text
@thread_review_dashboard - /test.html
@thread_review_dashboard - /nested/page.html
```

Add coverage for the click target if practical. Either mock `FileLink` and assert it receives `path="/src/App.tsx"` plus a VM `previewTarget`, or click the rendered link and assert the preview context receives:

```ts
{
  kind: "file",
  source: "vm",
  workspaceId: "thread-ws",
  project: "Thread Review Dashboard",
  path: "/src/App.tsx",
}
```

Keep the bracketed-notice and no-result regression tests from R4.

## Verification

Run:

```bash
bun run test:run -- tests/tool-detail-file-copy.test.tsx tests/file-path-copy.test.ts tests/preview-toolbar-notebook-download.test.tsx tests/chat-mention-sources-refresh.test.tsx
bun run typecheck
```
