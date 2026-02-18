# Notebook Static Worker Template

This template creates a static Cloudflare Worker that serves a notebook and renders it in the browser.

## Key files

- `public/notebook.ipynb`: notebook input served as a static asset
- `src/App.tsx`: fetches notebook JSON and renders the preview
- `src/components/chat-file-preview/notebook-preview/`: copied notebook renderer implementation
- `worker/index.ts`: static asset worker entry with SPA fallback
- `wrangler.jsonc`: Worker configuration

## Commands

```bash
bun dev          # Vite dev server
bun run build    # Build static assets into dist/
bun run deploy   # Deploy worker + static assets
```
