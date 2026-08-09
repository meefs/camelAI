---
name: file-sharing
description: Exchange files with users through the camelAI chat interface. Read files they upload and create downloadable/previewable files for them.
license: Complete terms in LICENSE.txt
---

This skill enables file exchange between you and the user through camelAI's chat interface.

## User Uploads

Users can upload files by dragging and dropping onto the chat or clicking the + button. When they upload a file, you'll see a message like:

```text
(user uploaded file to uploads/document-1736712345-abc123.pdf)
```

Uploads live in workspace-scoped R2. Use the normal file tools with `location: "r2"` and paths under `uploads/`.

### Reading User Uploads

```js
// List uploaded files
await tools.ls({ location: "r2", path: "uploads" });

// Read a specific text file
await tools.read({ location: "r2", path: "uploads/filename.txt" });

// Read an image; supported images are returned as image tool content
await tools.read({ location: "r2", path: "uploads/image.png" });
```

If you need a durable copy inside a project, copy it explicitly. For analysis,
prefer reading the mounted upload directly at `/uploads/<name>` so large inputs
are not duplicated:

```js
await tools.move({
  source: { location: "r2", path: "uploads/input.csv" },
  destination: { location: "project", project: "analysis-app", path: "input.csv" },
});
```

Files persist across sessions, so users can reference previously uploaded files.

### ZIP Archives

Do not pass an uploaded ZIP to the text `read` tool or extract it with an
unchecked shell command. Inspect its manifest first, then read any scripts,
Dockerfiles, dependency manifests, or other executable configuration directly
from the archive:

```js
await tools.inspect_archive({ path: "uploads/source.zip" });
await tools.inspect_archive({
  path: "uploads/source.zip",
  entry: "scripts/setup.sh",
});
```

After the archive and its executable/configuration entries are understood, use
the purpose-built extractor. It rejects traversal paths, links, encrypted or
special entries, ZIP bombs, and archives too large to persist safely:

```js
await tools.extract_archive({
  path: "uploads/source.zip",
  project: "website",
  destination: ".",
});
```

Extraction writes into an existing project so the resulting files are durable
and available to the normal project file and deployment tools.

## Creating Output Files

Files the user should download or preview must be written to workspace-scoped R2 under `outputs/`. Do not create a project-local `outputs/` directory and link to it; those links will not use the workspace outputs API.

```js
// Save a text file directly to R2 outputs
await tools.write({
  location: "r2",
  path: "outputs/report.txt",
  content: "Report content here",
  content_type: "text/plain",
});

// Copy a generated project file to R2 outputs
await tools.move({
  source: { location: "project", project: "analysis-app", path: "output.pdf" },
  destination: { location: "r2", path: "outputs/report.pdf" },
});

// Copy a generated project directory to R2 outputs
await tools.move({
  source: { location: "project", project: "analysis-app", path: "charts" },
  destination: { location: "r2", path: "outputs/charts" },
});
```

Use `tmp/<path>` for temporary R2 objects that are not meant for user download, and `outputs/<path>` for user-visible files.

### Providing Links

After writing an output, provide a URL so the user can access it. The URL format uses the workspace outputs API. Check your system prompt for the exact URL pattern with your workspace ID.

**For images** - Use markdown image syntax for inline preview:

```markdown
![Chart Description](/api/workspaces/{workspace-id}/outputs/chart.png)
```

**For downloads** - Use markdown link syntax:

```markdown
[Download Report](/api/workspaces/{workspace-id}/outputs/report.pdf)
```

Images will display inline in the chat; other files will download when clicked.

**For HTML pages** - Write the HTML to `outputs/<path>` for download, or use `set_preview()` for a durable file or an already-deployed app as described in the system prompt. New app deployments open preview automatically through `deploy_project`.

## Best Practices

1. **Confirm receipt** - When a user uploads a file, acknowledge it and briefly describe what you see.

2. **Use descriptive filenames** - When creating output files, use clear names like `sales-report-2024.pdf` instead of `output.pdf`.

3. **Verify before claiming delivery** - Read back or list the exact `outputs/` path after writing or moving it. For ZIP, workbook, PDF, and other structured formats, validate that the file opens and has the expected entries/sheets/pages before calling it complete. A successful generation command does not prove the user-facing output exists.

4. **Always provide links** - Don't just say "I've saved the file". Provide a URL so users can easily access it.

5. **Use inline images** - For charts, diagrams, and visual outputs, use the image markdown syntax so users see them directly in the chat.

6. **Handle large files** - For large generated outputs, create an archive in the
   analysis sandbox for a DO-backed project, let the changed archive persist to
   project storage, and then copy it to R2 outputs:

   ```js
   await tools.analysis_exec({ project: "analysis-app", command: "zip -r all-files.zip generated-files/" });
   await tools.move({
     source: { location: "project", project: "analysis-app", path: "all-files.zip" },
     destination: { location: "r2", path: "outputs/all-files.zip" },
   });
   ```

7. **Clean up** - If you create temporary project files during processing, remove them when done. Only keep files under `outputs/` that the user needs.

## R2 Path Structure

```text
uploads/     # Read-only user uploads
  document.pdf
  image.png
outputs/     # User-visible files you create
  report.pdf
  data.csv
  charts/
    analysis.png
tmp/         # Temporary conversation-scoped objects
```
