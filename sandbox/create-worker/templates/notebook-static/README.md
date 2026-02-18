# Notebook Static Worker Template

Static Cloudflare Worker scaffold that serves:

- A bundled Python notebook file at `/notebook.ipynb`
- A client-side renderer that displays the notebook in report and notebook modes

The renderer implementation is copied into this template, so the generated project is fully self-contained.

## Quick Start

```bash
bun dev
bun run build
bun run deploy
```

## Files to edit

- `public/notebook.ipynb`: replace with your notebook input
- `src/App.tsx`: page shell and view-mode controls
- `src/components/chat-file-preview/notebook-preview/`: notebook rendering code
