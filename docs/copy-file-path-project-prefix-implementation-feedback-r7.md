# Copy File Path Project Prefix Implementation Feedback R7

This follow-up covers the two new code-review findings:

- P2: project mention resolution picks the first normalized-name match when two project names normalize to the same key.
- P2: VM glob root-level filenames with spaces are omitted from the rendered/copied file list.

## 1. Prefer Exact Project Identity Before Normalized Fallback

Severity: P2

`src/lib/file-path-copy.ts` currently resolves project mentions by normalizing the copied target's project name and comparing that key against every project name in `mentionSlugMap`:

```ts
normalizeProjectCopyLookupKey(mentionTarget.name ?? '') === projectKey
```

That is not deterministic when two distinct project names normalize to the same key:

```text
My App -> my_app
my-app -> my_app
```

If the map contains both, copying a path from `my-app` can emit `@my_app - /path` for `My App`, which can paste back into the wrong project VM.

### Required Architecture

Change resolution from a single normalized scan to ordered disambiguation:

1. Match exact project id, when the copy target has one.
2. Match exact project name.
3. Use normalized-name fallback only when it is unambiguous.

Extend the copy target shape to carry ids opportunistically:

```ts
export interface CopyFilePathTarget {
  path: string;
  source?: "workspace" | "upload" | "output" | "vm" | string | null;
  project?: string | null;
  projectId?: string | null;
}
```

Then relax the formatter generic so map values can expose ids:

```ts
export interface FormatCopyFilePathOptions<
  T extends { kind?: string; id?: string; name?: string },
> {
  mentionSlugMap?: ReadonlyMap<string, T> | null;
  fallbackProjectMention?: boolean;
}
```

Update `resolveProjectMentionSlug()` to accept an optional id:

```ts
export function resolveProjectMentionSlug<
  T extends { kind?: string; id?: string; name?: string },
>(
  projectName: string,
  mentionSlugMap?: ReadonlyMap<string, T> | null,
  options: { projectId?: string | null } = {},
): string | null
```

Recommended algorithm:

```ts
const exactProjectId = options.projectId?.trim();
if (exactProjectId) {
  for (const [projectSlug, target] of mentionSlugMap) {
    if (target.kind === "project" && target.id === exactProjectId) {
      return projectSlug;
    }
  }
}

const exactProjectName = projectName.trim();
for (const [projectSlug, target] of mentionSlugMap) {
  if (target.kind === "project" && (target.name ?? "").trim() === exactProjectName) {
    return projectSlug;
  }
}

const normalizedMatches: string[] = [];
for (const [projectSlug, target] of mentionSlugMap) {
  if (
    target.kind === "project" &&
    normalizeProjectCopyLookupKey(target.name ?? "") === projectKey
  ) {
    normalizedMatches.push(projectSlug);
  }
}

return normalizedMatches.length === 1 ? normalizedMatches[0] : null;
```

This preserves the existing handle-style behavior for unique projects:

```text
Thread Review Dashboard + thread-review-dashboard -> @thread_review_dashboard
```

But it fails closed when the normalized name is ambiguous and neither exact name nor id can disambiguate. Returning the raw path is better than copying an `@project` mention that points at the wrong VM.

### Carry Project Ids Where Available

Update `copyTargetFromToolInput()` to read ids from tool inputs:

```ts
const projectId =
  typeof input.projectId === "string"
    ? input.projectId
    : typeof input.project_id === "string"
      ? input.project_id
      : undefined;
```

Return that as `projectId` on the copy target.

If preview targets already have a project id in a local call site, pass it through too. Do not make the whole fix depend on adding ids to every preview target; exact-name matching is enough to fix the `My App` / `my-app` case when the copied target has the real project name.

Also update the mention-refresh check in `src/components/Chat.tsx` to call the resolver with `projectId` if `VmProjectReference` is extended to carry it. If not, exact-name matching still makes the existing refresh check safer.

### Tests

Extend `tests/file-path-copy.test.ts`.

Add a collision test that proves exact names win over normalized insertion order:

```ts
const mentionSlugMap = buildSlugMap([
  project({ id: "project-a", name: "My App", created_at: 1 }),
  project({ id: "project-b", name: "my-app", created_at: 2 }),
]);

expect(formatCopyFilePath({
  path: "/src/App.tsx",
  source: "vm",
  project: "my-app",
}, { mentionSlugMap })).toBe("@my_app-2 - /src/App.tsx");
```

Add an id-precedence test:

```ts
expect(formatCopyFilePath({
  path: "/src/App.tsx",
  source: "vm",
  project: "My App",
  projectId: "project-b",
}, { mentionSlugMap })).toBe("@my_app-2 - /src/App.tsx");
```

Add an ambiguous normalized fallback test:

```ts
expect(formatCopyFilePath({
  path: "/src/App.tsx",
  source: "vm",
  project: "my_app",
}, { mentionSlugMap })).toBe("/src/App.tsx");
```

Keep the existing unique normalized-handle test so `thread-review-dashboard` still resolves when there is exactly one matching project.

## 2. Accept Root VM Glob Filenames With Spaces

Severity: P2

`src/components/tool-call/details/search-details.tsx` currently rejects root-level VM glob result lines with whitespace:

```ts
return /^[^\s/][^\s]*$/.test(line);
```

That rejects valid project VM filenames such as:

```text
My Notes.md
```

When any sibling result parses, the spaced filename is omitted from both the visible list and copied output. When it is the only result, `parsedLines` is empty and the UI falls back to raw unprefixed output.

### Required Architecture

Keep the bracketed-notice and no-result protections from R4, but stop using whitespace as a blanket non-path signal for VM glob output.

The VM glob/find tool returns file paths line by line. After filtering known sentinels and notices, a root-level line without `/` can still be a valid filename even if it contains spaces.

Change `isVmGlobBareRelativePath()` to accept internal whitespace:

```ts
function isVmGlobBareRelativePath(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (isSearchNoticeLine(trimmed)) return false;
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return false;
  if (trimmed.includes("\0")) return false;
  if (trimmed.includes(":")) return false;
  if (trimmed === "." || trimmed === "..") return false;
  if (trimmed.startsWith("/") || trimmed.startsWith("./") || trimmed.startsWith("../")) return false;
  if (trimmed.includes("/")) return false;
  return true;
}
```

The `base.includes("/")` branch already handles nested relative paths, including nested filenames with spaces:

```text
docs/My Notes.md
```

Keep colon handling unchanged for this fix. In `grep` mode, colon separates suffixes; supporting root-level glob filenames with colons would require a separate parser decision and is not part of this review finding.

### Tests

Extend `tests/tool-detail-file-copy.test.tsx`.

Add a mixed VM glob result test:

```text
Found 2 files
My Notes.md
nested/page.html
```

Expected rendered rows:

```text
My Notes.md
nested/page.html
```

Expected copied list:

```text
@thread_review_dashboard - /My Notes.md
@thread_review_dashboard - /nested/page.html
```

Add a single-result regression test so this does not fall back to raw output:

```text
Found 1 files
My Notes.md
```

Expected behavior:

- `Copy list` is present.
- `Copy output` is not the only copy path.
- Copied value is `@thread_review_dashboard - /My Notes.md`.

Keep the existing bracketed-notice test and no-result sentinel test unchanged.

## Verification

Run:

```bash
bun run test:run -- tests/file-path-copy.test.ts tests/tool-detail-file-copy.test.tsx tests/preview-toolbar-notebook-download.test.tsx tests/chat-mention-sources-refresh.test.tsx
bun run typecheck
```
