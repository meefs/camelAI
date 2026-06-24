# Copy File Path Project Prefix Implementation Feedback

The implementation is mostly on the right track: the shared formatter, preview context plumbing, preview toolbar copy, and tool-detail path copy updates match the intended architecture. Targeted tests pass.

I found two issues to address before PR.

## 1. Newly Created Projects Are Missing Until Refresh

Severity: P1

Repro from product feedback:

1. In an existing chat, ask the agent to create a new project called `test` and write `/workspace/test.html`.
2. The agent sets the new project file as the active preview.
3. Without refreshing the page, click the preview toolbar file chip to copy the path.
4. Actual clipboard: `/workspace/test.html` or `/test.html`
5. Expected clipboard: `@test - /test.html`

Root cause:

- `Chat` builds `mentionSlugMap` from `resolvedMentionConnections` and `resolvedMentionProjects` at `src/components/Chat.tsx`.
- `resolvedMentionProjects` only comes from the initial route data or `/api/workspaces/:id/mentions` refreshes.
- That mentions refresh currently happens when the `@` menu opens, not when the agent creates a project or sets a VM preview.
- `formatCopyFilePath()` intentionally returns the raw path when a mention map exists but does not contain the project, so a stale map suppresses the prefix.

Recommended fix:

- When chat receives or displays a VM file preview target whose `project` is not in the current project mention map, trigger a one-shot mentions refresh.
- Do not rely on the existing 15s mention-menu throttle; this refresh is data consistency for preview copy, not menu freshness.
- Avoid infinite loops for clones or deleted projects, since clones are intentionally excluded from mentions. Track attempted project keys in a ref and fetch at most once per missing project per workspace/thread.

Implementation shape in `src/components/Chat.tsx`:

```ts
const attemptedProjectMentionRefreshesRef = useRef<Set<string>>(new Set());

useEffect(() => {
  attemptedProjectMentionRefreshesRef.current.clear();
}, [resolvedWorkspaceId, threadId]);

useEffect(() => {
  if (!resolvedWorkspaceId) return;
  if (mentionSourcesFetcher.state !== "idle") return;

  const missingProject = previewTabs
    .map((tab) => tab.target)
    .find((target) =>
      target.kind === "file" &&
      target.source === "vm" &&
      target.project &&
      !resolveProjectMentionSlug(target.project, mentionSlugMap)
    );

  if (!missingProject || missingProject.kind !== "file" || !missingProject.project) {
    return;
  }

  const key = normalizeProjectCopyLookupKey(missingProject.project);
  if (attemptedProjectMentionRefreshesRef.current.has(key)) return;
  attemptedProjectMentionRefreshesRef.current.add(key);

  mentionSourcesFetcher.load(
    `/api/workspaces/${encodeURIComponent(resolvedWorkspaceId)}/mentions`,
  );
}, [
  mentionSlugMap,
  mentionSourcesFetcher,
  previewTabs,
  resolvedWorkspaceId,
  threadId,
]);
```

Names above are illustrative; see issue 2 for `resolveProjectMentionSlug`.

Add a regression test that simulates a VM preview tab for a project absent from initial `projects`, verifies `/mentions` is loaded, then verifies copy includes `@test` after the projects response is applied. `tests/chat-mention-sources-refresh.test.tsx` is the closest existing test area.

## 2. Project Matching Is Too Exact

Severity: P2

`src/lib/file-path-copy.ts` currently resolves the project mention only when:

```ts
mentionTarget.kind === 'project' &&
mentionTarget.name === projectName
```

That is too strict. Project operations resolve names through normalized project keys, and agent/tool inputs can use handles like `thread-review-dashboard` while the mention source display name is `Thread Review Dashboard`. In that case, the backend can resolve the project and preview the file, but copied paths still lose the project prefix.

Recommended fix:

- Factor project mention lookup into an exported helper from `src/lib/file-path-copy.ts`, for reuse by both the formatter and the Chat refresh effect.
- Match projects by a normalized key, not exact display name.
- Return the actual slug key from `mentionSlugMap`, never a recomputed slug, so connection/project collision suffixes remain correct.

Suggested helper:

```ts
export function normalizeProjectCopyLookupKey(value: string): string {
  return slug(value);
}

export function resolveProjectMentionSlug<T extends { kind?: string; name?: string }>(
  projectName: string,
  mentionSlugMap?: ReadonlyMap<string, T> | null,
): string | null {
  const projectKey = normalizeProjectCopyLookupKey(projectName);
  if (!projectKey || !mentionSlugMap) return null;

  for (const [projectSlug, mentionTarget] of mentionSlugMap) {
    if (
      mentionTarget.kind === "project" &&
      normalizeProjectCopyLookupKey(mentionTarget.name ?? "") === projectKey
    ) {
      return projectSlug;
    }
  }

  return null;
}
```

Then `formatCopyFilePath()` should call `resolveProjectMentionSlug(projectName, mentionSlugMap)`.

Add formatter tests:

- Mention map has project name `Thread Review Dashboard`, target uses `thread-review-dashboard`, copy returns `@thread_review_dashboard - /src/App.tsx`.
- Same case with a colliding connection still returns the suffixed project slug from the map.

## Verification Run

Already run during review:

```bash
bun run test:run -- tests/file-path-copy.test.ts tests/preview-toolbar-notebook-download.test.tsx tests/tool-detail-file-copy.test.tsx
bun run typecheck
```

Both passed.
