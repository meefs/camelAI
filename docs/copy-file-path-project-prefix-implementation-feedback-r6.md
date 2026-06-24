# Copy File Path Project Prefix Implementation Feedback R6

This follow-up covers the new code-review finding:

- P2: VM grep results from a single-file search root are resolved as nested paths.

## Resolve Single-File VM Grep Roots Correctly

Severity: P2

The R5 implementation resolves relative VM search output by joining the parsed result path under the normalized `input.path`:

```ts
const joinedPath = normalizedSearchRoot === "/"
  ? `/${normalizedResultPath}`
  : `${normalizedSearchRoot}/${normalizedResultPath}`;
```

That is correct when `input.path` is a directory:

```text
input.path: /src
output:     App.tsx:12:...
target:     /src/App.tsx
```

It is wrong when `input.path` is a single file. The VM project-runtime grep implementation does:

```py
rel = os.path.relpath(file_path, root if os.path.isdir(root) else os.path.dirname(root))
```

So a grep run against one file emits the file basename relative to the file's directory:

```text
input.path: /src/App.tsx
output:     App.tsx:12:...
```

Current UI resolution turns that into:

```text
@thread_review_dashboard - /src/App.tsx/App.tsx:12:...
```

The correct copied/opened target is:

```text
@thread_review_dashboard - /src/App.tsx:12:...
```

### Required Architecture

Make VM search result resolution aware of the search mode and the possibility that a grep root is a file.

Change the helper signature in `src/components/tool-call/details/search-details.tsx` from:

```ts
function resolveVmSearchResultPath(
  resultPath: string,
  searchRoot: string,
): string | null;
```

to something that receives the mode:

```ts
function resolveVmSearchResultPath(
  resultPath: string,
  searchRoot: string,
  options: { mode: SearchDetailsProps["mode"] },
): string | null;
```

Then pass `options.mode` from `parseLine()` whenever resolving VM rows.

### Relative Root Selection

Do not change absolute-result behavior. If the parsed result path starts with `/`, normalize it directly as today.

For relative results, choose the base directory before joining:

```ts
const relativeRoot = getVmSearchResultRelativeRoot({
  mode,
  normalizedSearchRoot,
  originalSearchRoot: searchRoot,
  normalizedResultPath,
});
```

Recommended behavior:

- For `glob`/find result rows, keep using the normalized search root as the relative root.
- For `grep` result rows, keep using the normalized search root for directory searches.
- For `grep` result rows where the searched path looks like the exact file that produced the result, use the dirname of the normalized search root.

The narrow file-root detection should be basename-based, not extension-based:

```ts
function shouldResolveGrepFromSearchRootDir(
  normalizedSearchRoot: string,
  originalSearchRoot: string,
  normalizedResultPath: string,
): boolean {
  if (normalizedSearchRoot === "/") return false;
  if (originalSearchRoot.trim().replace(/\\/g, "/").endsWith("/")) return false;
  return stripLeadingDotSlash(normalizedResultPath) === basenameVmPath(normalizedSearchRoot);
}
```

This handles files without extensions such as `Makefile`, and it avoids changing ordinary directory searches:

```text
/src + App.tsx       -> /src/App.tsx
/src/App.tsx + App.tsx -> /src/App.tsx
```

Avoid a broad rule like “grep always resolves relative output against `dirname(input.path)`.” That would regress directory-root grep output.

### Helper Shape

Add small path helpers alongside the existing VM normalizer:

```ts
function basenameVmPath(path: string): string {
  return path.split("/").filter(Boolean).pop() || "";
}

function dirnameVmPath(path: string): string {
  const segments = path.split("/").filter(Boolean);
  if (segments.length <= 1) return "/";
  return `/${segments.slice(0, -1).join("/")}`;
}

function stripLeadingDotSlash(path: string): string {
  let value = path;
  while (value.startsWith("./")) value = value.slice(2);
  return value;
}
```

Then resolve relative rows using the selected root:

```ts
const relativeRoot =
  options.mode === "grep" &&
  shouldResolveGrepFromSearchRootDir(
    normalizedSearchRoot,
    searchRoot,
    normalizedResultPath,
  )
    ? dirnameVmPath(normalizedSearchRoot)
    : normalizedSearchRoot;

const joinedPath = relativeRoot === "/"
  ? `/${normalizedResultPath}`
  : `${relativeRoot}/${normalizedResultPath}`;

return normalizeVmProjectPath(joinedPath);
```

Keep `normalizeVmProjectPath()` as the final safety gate so `..`, workspace-root aliases, duplicate slashes, and backslashes are handled consistently.

### Tests

Extend `tests/tool-detail-file-copy.test.tsx`.

Add a VM grep single-file-root copy test:

```ts
<SearchDetails
  mode="grep"
  tool={makeTool("grep", {
    location: "vm",
    project: "Thread Review Dashboard",
    pattern: "query",
    path: "/src/App.tsx",
  })}
  result={makeResult([
    "Found 1 matches",
    "App.tsx:12:const query = true",
  ].join("\n"))}
/>
```

Expected copied list:

```text
@thread_review_dashboard - /src/App.tsx:12:const query = true
```

Also assert the copied value does not contain:

```text
/src/App.tsx/App.tsx
```

Keep or add a paired directory-root grep regression test:

```text
input.path: /src
output: App.tsx:12:const query = true
expected: @thread_review_dashboard - /src/App.tsx:12:const query = true
```

That paired test protects against the tempting but incorrect “always use dirname for grep” fix.

If the R5 click-target test exists, add the same single-file-root case there too. Clicking `App.tsx` from the `/src/App.tsx` grep result should open:

```ts
{
  kind: "file",
  source: "vm",
  workspaceId: "thread-ws",
  project: "Thread Review Dashboard",
  path: "/src/App.tsx",
}
```

Do not drop the existing `/workspace` root, `/src` directory root, bracketed-notice, or no-result tests.

## Verification

Run:

```bash
bun run test:run -- tests/tool-detail-file-copy.test.tsx tests/file-path-copy.test.ts tests/preview-toolbar-notebook-download.test.tsx tests/chat-mention-sources-refresh.test.tsx
bun run typecheck
```
