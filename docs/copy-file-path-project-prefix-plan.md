# Add Project Mention Prefix To Copied File Paths

## Goal

When a copied file path points at a project VM file, copy enough context for the agent to know which project owns the path.

Desired clipboard format:

```text
@thread_review_dashboard - /plans/phase-2-automation.md
```

Keep existing clipboard behavior for non-project paths:

```text
/plans/phase-2-implementation-feedback.md
```

The copied `@...` text should use the same project mention slug that the chat `@` menu uses, including collision suffixes like `@stripe-2`.

## Current State

Project file previews and several tool-call rows already carry project context:

- `PreviewTarget` supports file targets with `source: "vm"` and `project?: string` in `src/types.ts`.
- Backend `set_preview` flows already set `target.project` for VM file previews in `workers/main/src/chat-thread-do.ts` and `workers/main/src/mcp-handler.ts`.
- Tool details for read/write/edit/notebook build preview targets from `input.location` and `input.project` via `src/lib/file-preview-target.ts`.
- Chat builds the canonical mention slug map in `src/components/Chat.tsx` from connections plus projects using `buildSlugMap()`.

The key missing piece is that copy-to-clipboard paths use the raw path string directly.

## Important Constraint: Use The Real Mention Slug

Do not format the prefix by blindly doing `@${slug(projectName)}` in the main chat UI.

`src/lib/mentions.ts` gives connections precedence over projects when slugs collide. For example, if a connection and project are both named `Stripe`, the project slug becomes `stripe-2` or later, not `stripe`. Copying `@stripe - /file` could resolve to a connection chip instead of a project chip.

Use the current `mentionSlugMap` whenever available:

1. Find an entry where `target.kind === "project"` and `target.name === projectName`.
2. Use that map key as the copied slug.
3. Only fall back to `slug(projectName)` when there is no mention map/context at all.
4. If a mention map exists but the project is not present, avoid emitting a possibly wrong `@` mention. Prefer raw path, or `projectName - path` if product wants a visible non-chip fallback.

This avoids the project/connection same-name issue the request called out.

## Proposed Architecture

Add one shared formatter and route all file-path clipboard behavior through it.

### 1. Shared Formatting Helper

Create `src/lib/file-path-copy.ts`.

Suggested API shape:

```ts
export interface CopyFilePathTarget {
  path: string;
  source?: "workspace" | "upload" | "output" | "vm" | string | null;
  project?: string | null;
}

export interface FormatCopyFilePathOptions<T extends { kind?: string; name?: string }> {
  mentionSlugMap?: ReadonlyMap<string, T> | null;
  fallbackProjectMention?: boolean;
}

export function formatCopyFilePath<T extends { kind?: string; name?: string }>(
  target: CopyFilePathTarget,
  options?: FormatCopyFilePathOptions<T>,
): string;
```

Behavior:

- Trim `path` and return `""` for an empty path.
- Only add a project prefix when `target.source === "vm"` and `target.project` is non-empty.
- Resolve the exact project mention slug from `mentionSlugMap` by matching `kind === "project"` and `name === target.project`.
- Return `@${projectSlug} - ${path}` when the project slug is found.
- If no map was provided and `fallbackProjectMention` is true, use `slug(target.project)` as a best-effort fallback.
- If a map was provided but no matching project was found, do not emit a guessed `@` slug.

Use plain ASCII `" - "` as the delimiter.

### 2. Expose The Formatter Through Chat Preview Context

Extend `src/components/chat-preview/preview-context.tsx`:

```ts
interface ChatPreviewContextValue {
  openPreviewTarget: (target: PreviewTarget) => void;
  clearPreviewTarget: () => void;
  resolveAppVisibility?: (scriptName: string) => Promise<boolean | null>;
  workspaceId?: string | null;
  formatFilePathForCopy?: (target: CopyFilePathTarget) => string;
}
```

In `src/components/Chat.tsx`, define:

```ts
const formatFilePathForCopy = useCallback(
  (target: CopyFilePathTarget) =>
    formatCopyFilePath(target, { mentionSlugMap }),
  [mentionSlugMap],
);
```

Pass it into `ChatPreviewProvider`.

This keeps the formatter available to both the preview panel and message/tool-call components without threading `mentionSlugMap` through every tool detail component.

### 3. Update Preview Toolbar Copy

File: `src/components/preview-panel/preview-toolbar.tsx`

Current behavior:

```ts
await navigator.clipboard.writeText(target.path);
```

Change `ClickToCopyFileChip` to use:

```ts
const previewContext = useChatPreviewContext();
const copyValue =
  previewContext?.formatFilePathForCopy?.(target) ??
  formatCopyFilePath(target, { fallbackProjectMention: true });
```

Then copy `copyValue`.

Expected results:

- Workspace file: `/plans/notes.md`
- Upload/output file: existing current path value
- VM file with project in map: `@thread_review_dashboard - /plans/phase-2-automation.md`
- VM file rendered outside chat context: best-effort `@${slug(project)} - /path`

Do not change the visible chip label unless product asks; it should continue to show the filename.

### 4. Update Tool Detail Path Copies

Files:

- `src/components/tool-call/details/read-details.tsx`
- `src/components/tool-call/details/write-details.tsx`
- `src/components/tool-call/details/edit-details.tsx`
- `src/components/tool-call/details/notebook-details.tsx`
- `src/components/tool-call/details/search-details.tsx`

These currently pass `copyValue={path}`.

Add a small helper near the tool-call details, for example `src/components/tool-call/details/file-copy.ts`:

```ts
export function copyTargetFromToolInput(
  input: Record<string, unknown>,
  path: string,
): CopyFilePathTarget {
  const location = typeof input.location === "string" ? input.location : undefined;
  const project = typeof input.project === "string" ? input.project : undefined;
  return {
    path,
    source: location,
    project,
  };
}
```

Then use a copied-path-aware prop rather than raw `copyValue`.

Recommended `DetailRow` change in `src/components/tool-call/details/shared.tsx`:

```ts
interface DetailRowProps {
  copyValue?: string;
  copyFileTarget?: CopyFilePathTarget;
}
```

Inside `DetailRow`, resolve:

```ts
const previewContext = useChatPreviewContext();
const formattedCopyValue = copyFileTarget
  ? previewContext?.formatFilePathForCopy?.(copyFileTarget) ??
    formatCopyFilePath(copyFileTarget, { fallbackProjectMention: true })
  : copyValue;
```

Use `formattedCopyValue` for the `CopyButton`.

This keeps generic copy rows like pattern, URL, command, and output unchanged.

### 5. Update Search Result List Copy

File: `src/components/tool-call/details/search-details.tsx`

There are two search copy flows:

- The `Path:` row.
- The `Copy list` button for parsed file/match results.

For the `Path:` row, pass `copyFileTarget={copyTargetFromToolInput(input, path)}`.

For `Copy list`, when the search input has `location === "vm"` and `project`, prefix each copied line with the same formatted project prefix. Preserve suffixes such as `:12:matched text`.

Example:

```text
@thread_review_dashboard - /src/App.tsx
@thread_review_dashboard - /src/lib/query.ts:42:const query = ...
```

Implementation shape:

```ts
const formatSearchCopyLine = (lineOrPath: string) =>
  formatFilePathForCopy({ path: lineOrPath, source: input.location, project: input.project });
```

Be careful not to treat `:line:content` as part of path normalization. For search result copying, prefix the raw parsed line; do not try to parse and reserialize line numbers unless the existing parser already split them cleanly.

### 6. Adjacent Clipboard Flows To Review

These are file-related clipboard flows found during discovery. Update only if the implementation can supply real project context.

- `src/components/tool-call/task-notification.tsx`: `Output file:` copies `outputFile`, but the block has no `location` or `project`. Leave unchanged unless the data model is expanded.
- `src/components/tool-call/details/team-create-details.tsx`: `Config:` copies `team_file_path`; no project context. Leave unchanged.
- `src/components/chat-file-preview/file-preview-popover.tsx`: the dialog header currently copies `filename`, not a file path, and the tooltip says `File name`. Treat this as out of scope for the project-prefix change. If product wants this to become a path-copy chip later, add optional `copyFileTarget` props and keep filename fallback behavior.
- `src/components/preview-panel/preview-toolbar.tsx` live app URL copy is not a file path. Leave unchanged.
- Code block copy, message copy, spreadsheet selection copy, connection mention copy, domain/DNS copy, app URL copy, and sandbox IP copy are unrelated. Leave unchanged.

## Tests To Add Or Update

### Unit Tests For Formatter

Add `tests/file-path-copy.test.ts`.

Cover:

- Workspace path returns raw path.
- Upload/output path returns raw path.
- VM path plus project and matching project mention map returns `@project_slug - /path`.
- Project/connection collision returns the suffixed project slug, not the connection slug.
- Map present but project missing does not emit guessed `@slug`.
- No map plus `fallbackProjectMention: true` emits best-effort `@slug(project) - /path`.

### Preview Toolbar Test

Update `tests/preview-toolbar-notebook-download.test.tsx`.

Existing test expects:

```ts
expect(writeText).toHaveBeenCalledWith('/reports/analysis.ipynb');
```

Keep that assertion for workspace files, and add a VM target case wrapped in `ChatPreviewProvider` with `formatFilePathForCopy` returning the formatter result. Assert:

```ts
expect(writeText).toHaveBeenCalledWith('@thread_review_dashboard - /plans/phase-2-automation.md');
```

### Tool Detail Tests

Add focused tests for path row copy if no equivalent exists.

Minimum coverage:

- Render `ReadDetails` with input `{ location: "vm", project: "Thread Review Dashboard", path: "/plans/phase-2-automation.md" }` under a provider whose formatter uses a map containing the matching project.
- Click the path copy button.
- Assert clipboard gets `@thread_review_dashboard - /plans/phase-2-automation.md`.

Add a `SearchDetails` test for `Copy list` if practical:

- VM grep result with two parsed lines.
- Assert each copied line is prefixed with the project mention.

## Verification Commands

Run:

```bash
bun run test:run -- tests/file-path-copy.test.ts tests/preview-toolbar-notebook-download.test.tsx
```

Also run the most relevant existing UI tests touched by implementation:

```bash
bun run test:run -- tests/file-preview-popover.test.tsx tests/file-link.test.tsx tests/mentions.test.ts
```

Finish with:

```bash
bun run typecheck
```

## Acceptance Criteria

- Copying the active preview toolbar file chip for a VM/project file copies `@<actual project mention slug> - <path>`.
- Same-name project/connection collisions copy the project slug with the correct suffix.
- Workspace, upload, output, and legacy file paths without project context keep their existing copied value.
- Generic clipboard buttons are not changed.
- Existing mention rendering and submission enrichment handles the copied `@project` text as a normal project mention when pasted into chat.
