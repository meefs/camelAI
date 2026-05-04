# Notebook Markdown Output Rendering Feedback R2

## Findings

No blocking findings.

The follow-up implementation addresses the prior feedback:

- Raw HTML remains disabled by default in `MarkdownRenderer`.
- Notebook markdown cells, report markdown cells, and `text/markdown` output rendering opt into sanitized HTML support.
- `<mark>`, `<sub>`, `<sup>`, and `<br>` now have explicit component handling.
- Unsafe HTML is covered by tests.
- Empty `text/markdown` values no longer count as visual output.

## Review Notes

### Sanitized Inline HTML

The implementation adds `allowInlineHtml` to `MarkdownRenderer`:

- `src/components/markdown-renderer.tsx:34`
- `src/components/markdown-renderer.tsx:39`
- `src/components/markdown-renderer.tsx:45`
- `src/components/markdown-renderer.tsx:50`
- `src/components/markdown-renderer.tsx:441`
- `src/components/markdown-renderer.tsx:471`

This is the right shape for the shared renderer. It avoids enabling raw HTML in chat and other markdown surfaces by default, while allowing notebook-specific markdown to behave more like Jupyter.

Notebook call sites opt in where expected:

- `src/components/chat-file-preview/notebook-preview/notebook-markdown-cell.tsx:15`
- `src/components/chat-file-preview/notebook-preview/report-markdown-cell.tsx:33`
- `src/components/chat-file-preview/notebook-preview/output-renderers.tsx:182`

The sanitizer uses `rehype-raw` followed by `rehype-sanitize`, which is the important safety property. The tests also verify that `<script>` and `onclick` are removed.

### Non-Blocking Scope Note

`allowInlineHtml` currently uses `rehype-sanitize`'s `defaultSchema` plus `mark`. That schema allows a broader safe HTML subset than only the inline tags named in the product bug, including tags such as `div`, `details`, `table`, and `img` with sanitized attributes/protocols.

I do not think this blocks the change. Jupyter markdown commonly supports simple HTML, and the sanitizer still strips script/event/style hazards. If the product intent is strictly "only mark/sub/sup/br", consider either tightening the schema or renaming/commenting this as "safe notebook HTML" rather than strictly inline HTML.

### Empty Markdown Visual Classification

The previous low-severity issue is fixed:

- `src/components/chat-file-preview/notebook-preview/utils.ts:926`
- `src/components/chat-file-preview/notebook-preview/utils.ts:932`
- `src/components/chat-file-preview/notebook-preview/utils.ts:1052`

`hasVisualOutput()` now reuses the same non-empty markdown check used by `getOutputRender()`, and the test coverage includes an empty markdown regression.

## Verification

Focused tests passed:

```bash
bun run test:run -- tests/markdown-renderer.test.ts tests/notebook-preview-utils.test.ts tests/notebook-report-export-model.test.ts
```

Result: 3 test files passed, 33 tests passed.

Full typecheck was attempted:

```bash
bun run typecheck
```

It failed on existing unrelated repo errors outside this change, including admin route typing, upload route nullability, team poll tests, MCP/worker type incompatibilities, and workspace cron durable object typing. I did not see failures in the touched notebook markdown files, but the repo is not currently typecheck-clean.

## Suggested Manual Check

Open the validation notebook again:

```text
/Users/illiana/Downloads/display_markdown_renderer_test.ipynb
```

Confirm cell 8 renders:

- `<mark>Highlighted text via inline HTML</mark>` as highlighted text.
- `<sub>subscript-ish text</sub>` as subscript.
- `<sup>superscript-ish text</sup>` as superscript.

Also confirm a regular chat message containing raw `<mark>...</mark>` does not suddenly render HTML, since `allowInlineHtml` should stay off by default outside notebooks.
