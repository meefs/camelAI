# Copy File Path Project Prefix Implementation Feedback R8

This follow-up covers the new code-review finding:

- P3: VM grep diagnostics can be parsed as file matches because any colon-containing VM grep line is accepted.

## Avoid Parsing VM Grep Diagnostics As File Paths

Severity: P3

`src/components/tool-call/details/search-details.tsx` currently treats any VM grep line containing a colon as a parsed result:

```ts
(options.isVmSearch && options.mode === 'grep' && colonIndex >= 0)
```

That keeps bare grep matches such as:

```text
App.tsx:12:const query = true
```

But it also catches diagnostics and failures such as:

```text
FileNotFoundError: /workspace/missing
```

The details panel can then render/copy a bogus path like:

```text
@thread_review_dashboard - /src/FileNotFoundError: /workspace/missing
```

Expected behavior: failed grep output should remain visible as plain output, with `Copy output`, not be converted into a `Matches` file list.

### Required Architecture

Add two layers of protection:

1. Do not parse search result rows when the tool result is failed.
2. For VM grep colon parsing, require actual grep match syntax, not just any colon.

### Skip Parsing Failed Tool Results

In `SearchDetails`, compute failure status before building `parsedLines`:

```ts
function isFailedToolResult(result?: ToolResultBlock): boolean {
  return Boolean(
    result &&
      (
        result.is_error === true ||
        result.status === "failed"
      )
  );
}
```

Then skip parsed-list rendering for failed results:

```ts
const resultFailed = isFailedToolResult(result);
const displayText = resultFailed ? resultText : extractResultLines(resultText);
const fileLines = displayText.split(/\r?\n/).filter(Boolean);
const parsedLines = resultFailed
  ? []
  : fileLines
      .map(line => parseLine(line, { mode, isVmSearch, searchRoot: path }))
      .filter((entry): entry is ParsedLine => Boolean(entry));
```

Use the same `displayText` in the fallback `OutputBlock`:

```tsx
<OutputBlock
  value={displayText}
  label={mode === "glob" ? "Files" : "Matches"}
  copyValue={displayText}
/>
```

This preserves the raw diagnostic text and avoids trimming/filtering failure output through the successful-result path.

If the existing private helper in `src/components/tool-call/tool-status.ts` is useful, either export a shared helper from a small utility or keep a local copy in `search-details.tsx`. Avoid importing a UI status helper if that creates an awkward dependency.

### Require Grep Match Syntax

Replace the broad VM grep colon fallback with a parser for grep output rows.

Both VM grep implementations emit matches as:

```text
<relative-or-absolute-file-path>:<line-number>:<matched text>
```

Add a helper:

```ts
function parseGrepMatchLine(line: string): { path: string; suffix: string } | null {
  const match = line.match(/^(.+?):([1-9]\d*):(.*)$/);
  if (!match) return null;

  return {
    path: match[1].trim(),
    suffix: `:${match[2]}:${match[3]}`,
  };
}
```

Then in `parseLine()`, handle VM grep colon lines before the generic colon split:

```ts
if (options.isVmSearch && options.mode === "grep" && trimmed.includes(":")) {
  const grepMatch = parseGrepMatchLine(trimmed);
  if (!grepMatch) return null;

  const resolvedPath = resolveVmSearchResultPath(grepMatch.path, options.searchRoot, {
    mode: options.mode,
  });
  if (!resolvedPath) return null;

  return {
    path: grepMatch.path,
    resolvedPath,
    suffix: grepMatch.suffix,
    raw: trimmed,
  };
}
```

After that, keep the existing generic path handling for non-colon absolute/nested rows if needed:

```ts
const colonIndex = trimmed.indexOf(":");
const base = colonIndex >= 0 ? trimmed.slice(0, colonIndex) : trimmed;

if (
  base.startsWith("/") ||
  base.startsWith("./") ||
  base.startsWith("../") ||
  base.includes("/")
) {
  // existing resolution
}
```

Do not leave `(options.isVmSearch && options.mode === "grep" && colonIndex >= 0)` in the generic condition. That condition is the source of the diagnostic false positive.

The grep match regex should preserve matched text containing additional colons:

```text
App.tsx:12:const url = "https://example.com"
```

The suffix should remain:

```text
:12:const url = "https://example.com"
```

### Tests

Extend `tests/tool-detail-file-copy.test.tsx`.

Add a failed VM grep diagnostic test:

```ts
renderWithPreviewContext(
  <SearchDetails
    mode="grep"
    tool={makeTool("grep", {
      location: "vm",
      project: "Thread Review Dashboard",
      pattern: "query",
      path: "/src",
    })}
    result={{
      type: "tool_result",
      tool_use_id: "tool_result",
      is_error: true,
      status: "failed",
      content: "FileNotFoundError: /workspace/missing",
    }}
  />,
);
```

Expected assertions:

```ts
expect(screen.queryByRole("button", { name: "Copy list" })).not.toBeInTheDocument();
expect(screen.getByText("FileNotFoundError: /workspace/missing")).toBeInTheDocument();

fireEvent.click(screen.getByRole("button", { name: "Copy output" }));
await waitFor(() => {
  expect(writeText).toHaveBeenCalledWith("FileNotFoundError: /workspace/missing");
});
expect(writeText).not.toHaveBeenCalledWith(
  expect.stringContaining("@thread_review_dashboard - /src/FileNotFoundError"),
);
```

Add a non-error VM grep diagnostic-shaped line test:

```text
FileNotFoundError: /workspace/missing
```

with no `is_error`, if practical. The expected behavior should still be fallback output because the line does not match `<path>:<positive-line-number>:<text>`.

Keep existing successful grep tests:

```text
App.tsx:42:const query = true
```

and add or update one to include extra colons in matched text:

```text
App.tsx:42:const url = "https://example.com"
```

Expected copied output:

```text
@thread_review_dashboard - /src/App.tsx:42:const url = "https://example.com"
```

## Verification

Run:

```bash
bun run test:run -- tests/tool-detail-file-copy.test.tsx tests/file-path-copy.test.ts tests/preview-toolbar-notebook-download.test.tsx tests/chat-mention-sources-refresh.test.tsx
bun run typecheck
```
