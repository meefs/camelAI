# Workspace File Previews in Chat

Replace broken file-tag deep links for temporary files and add rich previews for uploaded/output files in the chat experience.

---

## Problem Statement

Two related issues with files in `/mnt/user-uploads/` and `/mnt/user-outputs/`:

1. **Broken file links in tool calls.** Every file path in a tool call (Read, Write, Edit, etc.) renders as a clickable `FileLink` that deep links to the Computer page (`/computer/{workspaceId}?file={path}`). This works for files on the workspace filesystem (`/home/claude/...`), but files under `/mnt/user-uploads/` and `/mnt/user-outputs/` are R2-backed temporary mounts that don't appear in the Computer file tree. Clicking them shows a 404.

2. **No preview for user-uploaded files.** When a user attaches a file to a message, the upload text is appended as raw plaintext: `(user uploaded file to /mnt/user-uploads/camel-123-abc.svg)`. There's no visual preview — no thumbnail, no icon, nothing indicating what the file is.

**Goal:** Turn both of these dead-end experiences into rich, inline file previews.

---

## Current Architecture

```
User uploads file
  → POST /api/workspaces/{id}/upload
  → R2: {orgId}/{workspaceId}/user-uploads/{filename}
  → Returns: { path: "/mnt/user-uploads/{filename}", ... }
  → Appended to message as plaintext: "(user uploaded file to /mnt/user-uploads/...)"

Agent outputs file
  → Writes to /mnt/user-outputs/{filename} (JuiceFS → R2)
  → GET /api/workspaces/{id}/outputs/{filename}  ← already exists

Tool call references file in /mnt/user-uploads/ or /mnt/user-outputs/
  → FileLink renders clickable link → /computer/{workspaceId}?file={path}
  → Computer page can't find file → 404
```

---

## Design

### New Serving Route: `/api/workspaces/:id/uploads/*`

We need a read-only HTTP endpoint to serve user-uploaded files, mirroring the existing outputs route. This is required for both preview thumbnails and download links.

**Implementation:** Clone `workspaces.$id.outputs.$.ts` but change the R2 prefix from `user-outputs/` to `user-uploads/`. Same auth, same Content-Type detection, same inline/attachment logic.

**Route registration in `routes.ts`:**
```typescript
route('api/workspaces/:id/uploads/*', 'routes/api/workspaces.$id.uploads.$.ts'),
```

### URL Patterns

After this work, both temporary file types have HTTP URLs:

| Mount path | HTTP URL |
|---|---|
| `/mnt/user-uploads/{file}` | `/api/workspaces/{id}/uploads/{file}` |
| `/mnt/user-outputs/{file}` | `/api/workspaces/{id}/outputs/{file}` |

---

## Part 1: Fix Broken File Links in Tool Calls

### Detection

A file path is a "temporary file" if it starts with `/mnt/user-uploads/` or `/mnt/user-outputs/`. These paths should never deep link to the Computer page.

### Approach: Extend `FileLink` Component

Modify `src/components/tool-call/file-link.tsx` to detect temporary file paths and render them differently.

```
Before (all files):
┌──────────────────────────────────────────┐
│ • Read /mnt/user-uploads/data.csv        │  ← click opens Computer (404)
└──────────────────────────────────────────┘

After (temporary files):
┌──────────────────────────────────────────┐
│ • Read data.csv  [↗]                     │  ← click opens preview popover
└──────────────────────────────────────────┘

After (workspace files, unchanged):
┌──────────────────────────────────────────┐
│ • Read src/index.ts  [↗]                 │  ← click opens Computer (works)
└──────────────────────────────────────────┘
```

#### Changes to `FileLink` (`src/components/tool-call/file-link.tsx`)

Add a helper to detect and classify temporary file paths:

```typescript
const TEMP_FILE_PREFIXES = [
  { prefix: '/mnt/user-uploads/', type: 'upload' as const, urlSegment: 'uploads' },
  { prefix: '/mnt/user-outputs/', type: 'output' as const, urlSegment: 'outputs' },
];

function getTempFileInfo(path: string) {
  for (const { prefix, type, urlSegment } of TEMP_FILE_PREFIXES) {
    if (path.startsWith(prefix)) {
      const relativePath = path.slice(prefix.length);
      return { type, relativePath, urlSegment };
    }
  }
  return null;
}
```

When `getTempFileInfo` returns non-null, `FileLink` should:
- **Not** link to `/computer/{workspaceId}?file=...`
- Instead, render as a button/link that opens the `FilePreviewPopover` (see Part 3 below)
- The `href` for direct download becomes `/api/workspaces/{workspaceId}/{urlSegment}/{relativePath}`
- Display just the filename (not the full `/mnt/...` path)

The `FileLink` component needs `workspaceId` — it already gets this from `useAuth().currentWorkspace.id`.

---

## Part 2: User Upload Previews in Chat Messages

### Current Behavior

When a user sends a message with attachments, the message content looks like:

```
Hey can you analyze this data?

(user uploaded file to /mnt/user-uploads/sales_data-1769817988699-ttgmud.csv)
```

This raw text is rendered by `MarkdownRenderer` as plain paragraph text.

### New Behavior

Show a visual file preview chip above the message text, then strip the `(user uploaded file to ...)` text from the rendered content.

```
┌─────────────────────────────────────┐
│                                     │
│  ┌───────────┐                      │
│  │  📊       │                      │  ← Image preview or file icon
│  │ sales.csv │                      │
│  │  12.4 KB  │                      │
│  └───────────┘                      │
│                                     │
│  Hey can you analyze this data?     │  ← Clean message without upload text
│                                     │
└─────────────────────────────────────┘
```

For image files (PNG, JPG, GIF, WebP, SVG), the preview chip should show an actual thumbnail loaded from the uploads URL. For non-image files, show a file-type icon with the filename and size.

### Implementation

#### Step 1: Parse upload references from message text

Create a utility function in a new file `src/components/chat-file-preview/parse-uploads.ts`:

```typescript
interface ParsedUploadRef {
  originalText: string;   // Full match: "(user uploaded file to /mnt/user-uploads/foo.csv)"
  mountPath: string;      // "/mnt/user-uploads/foo.csv"
  filename: string;       // "foo.csv" (the unique filename)
  originalName: string;   // Best-effort original name extraction
}

// Regex: /\(user uploaded file to (\/mnt\/user-uploads\/([^\s)]+))\)/g
function parseUploadRefs(content: string): {
  refs: ParsedUploadRef[];
  cleanContent: string;  // Content with upload refs stripped
}
```

The `originalName` can be derived by stripping the timestamp-random suffix: `sales_data-1769817988699-ttgmud.csv` → `sales_data.csv`. The pattern is `{base}-{timestamp}-{random}.{ext}`, so split on `-`, drop the last two segments before the extension.

#### Step 2: New component `FilePreviewChip`

Create `src/components/chat-file-preview/file-preview-chip.tsx`.

This is a small card-style component that previews a single file:

```
Image files:                    Other files:
┌─────────────┐                ┌─────────────┐
│  ┌─────────┐│                │             │
│  │ (thumb) ││                │   📄 / 📊   │  ← File type icon
│  │         ││                │             │
│  └─────────┘│                │ report.pdf  │  ← Filename
│ photo.png   │                │             │
└─────────────┘                └─────────────┘
```

**Props:**
```typescript
interface FilePreviewChipProps {
  filename: string;         // Display name
  previewUrl: string;       // /api/workspaces/{id}/uploads/{file}
  contentType?: string;     // MIME type hint (optional, inferred from extension)
  onClick?: () => void;     // Open preview popover
}
```

**Rendering logic by file type:**

| Category | Extensions | Preview |
|---|---|---|
| Images | png, jpg, jpeg, gif, webp, svg, bmp | `<img>` thumbnail with `object-fit: cover`, max 120x80px |
| PDF | pdf | File icon (from lucide: `FileText`) + filename |
| Spreadsheet | csv, xlsx, xls | File icon (`FileSpreadsheet`) + filename |
| Code/Text | txt, json, xml, html, css, js, ts, md, py | File icon (`FileCode`) + filename |
| Audio | mp3, wav, ogg | File icon (`FileAudio`) + filename |
| Video | mp4, webm | File icon (`FileVideo`) + filename |
| Other | * | Generic file icon (`File`) + filename |

Use lucide-react icons — they're already in the project. The chip styling should match the existing `AttachmentList` component aesthetic: `rounded-md border border-border bg-muted/50 text-sm`.

For image thumbnails, add `loading="lazy"` and handle load errors by falling back to the file icon.

#### Step 3: Integrate into `MessageBubble`

In `src/components/message-bubble.tsx`, for **user messages only**:

1. Before rendering content, call `parseUploadRefs(content)`
2. If refs are found, render `FilePreviewChip` components above the message text
3. Pass `cleanContent` (with upload text stripped) to `MarkdownRenderer`

```tsx
// In the user message rendering path of MessageBubble:
const { refs, cleanContent } = parseUploadRefs(textContent);

return (
  <>
    {refs.length > 0 && (
      <div className="flex flex-wrap gap-2 mb-2">
        {refs.map(ref => (
          <FilePreviewChip
            key={ref.mountPath}
            filename={ref.originalName}
            previewUrl={`/api/workspaces/${workspaceId}/uploads/${ref.filename}`}
          />
        ))}
      </div>
    )}
    <MarkdownRenderer content={cleanContent} variant="user" />
  </>
);
```

**Important:** The `workspaceId` is needed here. It's available from `useAuth().currentWorkspace.id` which is already accessible in the component tree (the chat page provides `AuthContext`).

---

## Part 3: File Preview Popover for Tool Call Files

When a user clicks a temporary file link in a tool call, show a preview popover instead of navigating to the Computer page.

### Preview Popover Design

```
┌──────────────────────────────────────┐
│  photo.png                     ✕  ↓  │  ← Filename, close button, download button
├──────────────────────────────────────┤
│                                      │
│         ┌──────────────────┐         │
│         │                  │         │
│         │   (image/pdf/    │         │
│         │    preview)      │         │
│         │                  │         │
│         └──────────────────┘         │
│                                      │
└──────────────────────────────────────┘
```

For non-previewable files:

```
┌──────────────────────────────────────┐
│  archive.zip                   ✕  ↓  │
├──────────────────────────────────────┤
│                                      │
│              📦                      │
│                                      │
│        No preview available          │
│                                      │
│         [ Download File ]            │
│                                      │
└──────────────────────────────────────┘
```

### Component: `FilePreviewPopover`

Create `src/components/chat-file-preview/file-preview-popover.tsx`.

Use shadcn's `Dialog` component (not `Popover` — Dialog is better for rich content that may be large). The Dialog should be relatively small/centered.

**Props:**
```typescript
interface FilePreviewPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filename: string;
  previewUrl: string;
}
```

**Preview content by type:**

| Category | Rendering |
|---|---|
| Images | `<img>` with `max-w-full max-h-[60vh] object-contain`, centered |
| PDF | `<iframe>` with PDF URL (browser native PDF viewer) |
| Text/Code/JSON/CSV | Fetch content as text, render in a `<pre>` block with max-height scroll. Limit to first ~500 lines. |
| Audio | `<audio controls>` element with `src={previewUrl}` |
| Video | `<video controls>` element with `src={previewUrl}`, max-height constrained |
| Other | "No preview available" message with download button |

**Header actions:**
- Download button: `<a href={previewUrl} download={filename}>` with `Download` lucide icon
- Close button: `X` icon to close dialog

### Wiring the Popover

The `FileLink` component, when it detects a temporary file, should:

1. Render as a `<button>` instead of `<a>`
2. On click, open the `FilePreviewPopover` with the correct URL
3. Manage open/close state internally with `useState`

```tsx
// Inside FileLink, when path is a temp file:
const [previewOpen, setPreviewOpen] = useState(false);
const tempInfo = getTempFileInfo(path);

if (tempInfo) {
  const previewUrl = `/api/workspaces/${currentWorkspace.id}/${tempInfo.urlSegment}/${tempInfo.relativePath}`;
  const displayName = tempInfo.relativePath.split('/').pop() || tempInfo.relativePath;

  return (
    <>
      <button
        className={cn("inline-flex min-w-0 max-w-full items-center gap-1 hover:underline",
          "text-foreground/80 hover:text-foreground", mono && "font-mono", className)}
        onClick={(e) => { e.stopPropagation(); setPreviewOpen(true); }}
      >
        {children ?? displayName}
        {showIcon ? <ExternalLink className="h-3 w-3 opacity-50" /> : null}
      </button>
      <FilePreviewPopover
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        filename={displayName}
        previewUrl={previewUrl}
      />
    </>
  );
}
```

---

## Summary of Changes

### New Files

| File | Purpose |
|---|---|
| `src/routes/api/workspaces.$id.uploads.$.ts` | Serve user-uploaded files from R2 (mirrors outputs route) |
| `src/components/chat-file-preview/parse-uploads.ts` | Parse `(user uploaded file to ...)` from message text |
| `src/components/chat-file-preview/file-preview-chip.tsx` | Thumbnail/icon chip for uploaded files in user messages |
| `src/components/chat-file-preview/file-preview-popover.tsx` | Dialog-based file preview for temporary files |
| `src/components/chat-file-preview/file-type-utils.ts` | Shared helpers: MIME type detection, file category classification, icon mapping |
| `src/components/chat-file-preview/index.ts` | Barrel export |

### Modified Files

| File | Change |
|---|---|
| `src/routes.ts` | Add route for `/api/workspaces/:id/uploads/*` |
| `src/components/tool-call/file-link.tsx` | Detect temp files, render preview button instead of Computer deep link |
| `src/components/message-bubble.tsx` | Parse upload refs from user messages, render `FilePreviewChip` above text |
| `src/components/attachment-list.tsx` | Extend `Attachment` interface with `contentType` and `originalName` (for future use) |
| `src/components/Chat.tsx` | Store `contentType` and `originalName` from upload response in attachment state |

### Route Registration

```typescript
// In src/routes.ts, after the existing outputs route:
route('api/workspaces/:id/uploads/*', 'routes/api/workspaces.$id.uploads.$.ts'),
```

---

## Implementation Order

1. **Create the uploads serving route** — enables all preview URLs to work
2. **Create `file-type-utils.ts`** — shared file categorization logic used by both chip and popover
3. **Create `FilePreviewPopover`** — the dialog component for viewing files
4. **Update `FileLink`** — detect temp files, open popover instead of deep linking
5. **Create `parse-uploads.ts`** — extract upload references from message text
6. **Create `FilePreviewChip`** — the small preview card for user messages
7. **Update `MessageBubble`** — integrate upload parsing and chip rendering for user messages
8. **Update `Chat.tsx` and `Attachment` interface** — pass through `contentType` and `originalName` from upload response

---

## Edge Cases & Notes

- **Multiple uploads in one message:** Render multiple chips in a flex-wrap row. The upload text parser must handle multiple `(user uploaded file to ...)` lines.
- **Failed image loads:** `FilePreviewChip` should handle `<img onError>` by falling back to a generic file icon.
- **Long filenames:** Truncate with `truncate` CSS class. The full name is visible in the preview popover header.
- **Upload text at end of message:** The parser should strip the upload references regardless of where they appear (typically at the end, separated by `\n\n`). If stripping leaves only whitespace, render nothing for the text portion.
- **Existing messages:** This is purely a rendering change. Old messages with `(user uploaded file to ...)` text will retroactively get the preview treatment when re-rendered. The upload URLs should still work since the files persist in R2.
- **Security:** The uploads serving route must have the same auth checks as the outputs route (session + workspace access validation + path traversal prevention).
