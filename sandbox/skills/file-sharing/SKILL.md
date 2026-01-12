---
name: file-sharing
description: Exchange files with users through the Chiridion chat interface. Read files they upload and create downloadable files for them.
license: Complete terms in LICENSE.txt
---

This skill enables file exchange between you and the user through Chiridion's chat interface.

## User Uploads

Users can upload files by dragging and dropping onto the chat or clicking the + button. When they upload a file, you'll see a message like:

```
(user uploaded file to /mnt/user-uploads/document-1736712345-abc123.pdf)
```

### Reading User Uploads

To access the uploaded file:

```bash
# List uploaded files
ls /mnt/user-uploads/

# Read a specific file
cat /mnt/user-uploads/filename.txt

# Read an image (for processing)
file /mnt/user-uploads/image.png
```

Files persist across sessions, so users can reference previously uploaded files.

## Creating Downloads

To create a file the user can download, save it to `/mnt/user-outputs/`:

```bash
# Save a text file
echo "Report content here" > /mnt/user-outputs/report.txt

# Copy a generated file
cp output.pdf /mnt/user-outputs/report.pdf

# Create subdirectories if needed
mkdir -p /mnt/user-outputs/charts
cp chart.png /mnt/user-outputs/charts/analysis.png
```

### Providing Download Links

After saving a file, provide a clickable download link using the `chiridion://` protocol:

**Syntax:** `[Link Text](chiridion://outputs/path/to/file.ext)`

**Examples:**
- `[Download Report](chiridion://outputs/report.pdf)`
- `[Download CSV Data](chiridion://outputs/data.csv)`
- `[View Chart](chiridion://outputs/charts/analysis.png)`

The user can click these links to download the file directly from the chat.

## Best Practices

1. **Confirm receipt** - When a user uploads a file, acknowledge it and briefly describe what you see.

2. **Use descriptive filenames** - When creating output files, use clear names like `sales-report-2024.pdf` instead of `output.pdf`.

3. **Always provide links** - Don't just say "I've saved the file". Provide a `chiridion://` link so users can easily download it.

4. **Handle large files** - For very large outputs, consider creating a zip archive:
   ```bash
   zip -r /mnt/user-outputs/all-files.zip generated-files/
   ```
   Then link: `[Download All Files](chiridion://outputs/all-files.zip)`

5. **Clean up** - If you create temporary files during processing, remove them when done. Only keep files in `/mnt/user-outputs/` that the user needs.

## Directory Structure

```
/mnt/
  user-uploads/     # Read-only for you - user's uploaded files
    document.pdf
    image.png
  user-outputs/     # Write here - files for user to download
    report.pdf
    data.csv
    charts/
      analysis.png
```
