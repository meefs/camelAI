# Preview Renderers Expansion Feedback

## Findings

### P2 - HTML preview iframe is still framed like a document card

File: `src/components/chat-file-preview/file-preview-content.tsx:140`

`HtmlPreview` wraps the iframe in a padded panel container and gives the iframe a border and rounded corners:

```tsx
layout === 'panel' ? 'h-full p-3' : 'h-[60vh]'
className="h-full w-full rounded-md border bg-white"
```

For rendered HTML, the preview should behave like the app iframe: it should occupy the full available preview pane without an inset container. Please remove the panel padding, border, and rounded corners. The target shape is closer to:

```tsx
function HtmlPreview({ src, title, layout }: Props) {
  return (
    <iframe
      src={src}
      title={title}
      sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"
      referrerPolicy="no-referrer"
      className={cn(
        "w-full bg-white",
        layout === "panel" ? "h-full" : "h-[60vh]"
      )}
    />
  );
}
```

Also consider changing the HTML branch's panel wrapper from `h-full overflow-auto` to `h-full overflow-hidden`, so the iframe itself owns the viewport instead of sitting inside a scroll container.

Suggested test update: in the HTML preview test, assert the rendered iframe does not include `rounded-md`, `border`, or an inset padding wrapper in panel layout.

### P3 - Toolbar toggle eligibility can diverge from renderer classification for content-type-driven files

Files:

- `src/components/preview-panel/preview-utils.ts:107`
- `src/components/chat-file-preview/file-type-utils.ts:163`

`getPreviewType()` now lets content type drive explicit renderers such as JSON and spreadsheets. `getToolbarFileType()` still returns generic extension matches like `.txt` before checking JSON or spreadsheet content types:

```ts
if (ext === 'txt') return 'text';
...
if (contentType === 'application/json' || contentType === 'application/x-ndjson') {
  return 'json';
}
```

That means a file named `data.txt` with `contentType="text/csv"` can render through the spreadsheet preview but not show the Preview/Source toggle. Similarly, `config.txt` with `contentType="application/json"` can render as pretty JSON but the toolbar classifies it as text.

The safer fix is to keep toolbar classification aligned with `getPreviewType()` for source-toggleable content types. Either move the JSON/spreadsheet content-type checks before the generic `.txt` branch, or derive toolbar source-toggle support from `getPreviewType(filename, contentType)` instead of maintaining a separate partially-overlapping classifier.

Suggested tests:

- `getToolbarFileType({ path: "/tmp/config.txt", contentType: "application/json" }) === "json"`
- `supportsPreviewSourceToggle({ path: "/tmp/config.txt", contentType: "application/json" }) === true`
- `getToolbarFileType({ path: "/tmp/data.txt", contentType: "text/csv" }) === "spreadsheet"`
- `supportsPreviewSourceToggle({ path: "/tmp/data.txt", contentType: "text/csv" }) === true`

## Verification

These passed during review:

```bash
bun run test:run tests/code-preview.test.tsx tests/file-type-utils.test.ts tests/preview-utils.test.ts tests/preview-toolbar-notebook-download.test.tsx
bun run typecheck
```

