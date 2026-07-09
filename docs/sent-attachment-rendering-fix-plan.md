# Sent Attachment Rendering Fix Plan

## Problem

When a user sends a message with completed file attachments, the chat initially renders correctly:

- the attachment cards/chips appear above the user message;
- the internal upload reference text is hidden from the user-facing message body.

After the optimistic message is reconciled with persisted chat history, the same message can re-render incorrectly:

```text
can you see these attachments alright?
(user uploaded file to uploads/10-plants-postgres-ref-queries-1783553899075-py94et.txt)
(user uploaded file to uploads/1463_-ilker_s_as_CSV-_works_well-1783553900758-5f7v2t.csv)
(user uploaded file to uploads/bigquery_test_login-1783553902011-7wv4ch.json)
```

Those `(user uploaded file to uploads/...)` markers are agent-facing prompt context. They must remain in the model-side content, but they must not be visible in the active chat screen.

## Root Cause

The optimistic and persisted render paths use different message shapes.

1. `src/components/Chat.tsx` builds outgoing content with `buildMessageContent()`, which appends upload references through `appendAttachmentReferences()`.
2. The optimistic user bubble is appended as a legacy `Message` with `content: finalContent`, a plain string.
3. `src/components/message-bubble.tsx` handles string user content correctly: it calls `parseUploadRefs()`, renders `FilePreviewChip`s, and passes only `cleanContent` into `ContentBlockRenderer`.
4. Once the message echoes back through ai-chat render history, `src/lib/ui-message-adapter.ts` converts UIMessage text parts into `ContentBlock[]`, usually `[{ type: "text", text: finalContent }]`.
5. The user-message branch in `message-bubble.tsx` does **not** run `parseUploadRefs()` for `ContentBlock[]`. It sets `refs: []` and renders the blocks as-is, so the upload markers become visible text and the attachment chips disappear.

This explains the flash: the optimistic string path is correct; the reconciled/backfilled block path is not.

## Implementation Strategy

Fix the render normalization at the user-message boundary. Do not change attachment styling, upload storage, prompt augmentation, or the model-facing content format.

### 1. Add a ContentBlock-aware upload parser

Extend `src/lib/chat-attachment-refs.ts` with a helper that applies the existing marker parser to both strings and text blocks:

```ts
export function parseUploadRefsFromContent(
  content: string | ContentBlock[],
): {
  refs: ParsedUploadRef[];
  cleanContent: string | ContentBlock[];
}
```

Expected behavior:

- For string content, delegate directly to the existing `parseUploadRefs(content)`.
- For `ContentBlock[]`, iterate blocks.
- For each `block.type === "text"`, call `parseUploadRefs(block.text)`.
- Accumulate all parsed refs in original order.
- Replace each text block with `{ ...block, text: parsed.cleanContent }` when the cleaned text is non-empty.
- Drop text blocks whose cleaned text is empty.
- Preserve all non-text blocks unchanged. User messages should rarely contain non-text blocks, but this keeps the helper safe.
- Preserve text-block metadata such as `itemKind` by spreading the original block.

Keep `parseUploadRefs()` unchanged for existing callers and tests.

### 2. Use the helper in `MessageBubble`

In `src/components/message-bubble.tsx`, update the user-message branch after author stripping:

Current behavior:

```ts
const uploadInfo = typeof userDisplayContent === 'string'
  ? parseUploadRefs(userDisplayContent)
  : { refs: [], cleanContent: userDisplayContent };
```

Target behavior:

```ts
const uploadInfo = parseUploadRefsFromContent(userDisplayContent);
```

Import the new helper from `@/lib/chat-attachment-refs` or re-export it from `src/components/chat-file-preview/index.ts` if the local import pattern is preferred. Since `message-bubble.tsx` already imports `FilePreviewChip` from `@/components/chat-file-preview`, the cleanest split is:

- keep `FilePreviewChip` from `@/components/chat-file-preview`;
- import `parseUploadRefsFromContent` from `@/lib/chat-attachment-refs`.

No JSX or styling changes should be necessary. The existing `previewRefs.map(...)` and `ContentBlockRenderer` calls should work once `uploadInfo` is populated for block content.

### 3. Preserve agent-facing content

Do not remove upload markers before sending the message to the worker or Pi:

- leave `buildMessageContent()` in `src/components/Chat.tsx` intact;
- leave `appendAttachmentReferences()` / `buildAttachmentReference()` intact;
- leave `workers/main/src/chat-thread-do.ts` turn preparation intact.

The model still needs the upload paths. The fix is only that render-time user-facing content strips those markers and presents attachment chips.

### 4. Optional cleanup, only if encountered

If the implementer finds duplicated ad hoc parsing in nearby user-message display helpers, it is acceptable to route them through `parseUploadRefsFromContent()`. Keep this narrow. Do not start a broader UIMessage schema migration.

Avoid these larger changes for this bug:

- adding structured attachment metadata to UIMessage parts;
- changing ai-chat persistence format;
- changing the upload reference marker syntax;
- redesigning `FilePreviewChip`, `FileCard`, or attachment card styling.

## Tests

Add focused coverage for the exact regression.

### Unit tests for the parser

Extend `tests/parse-uploads.test.ts` or create `tests/chat-attachment-refs.test.ts` coverage for `parseUploadRefsFromContent()`:

1. String content behaves exactly like `parseUploadRefs()`.
2. A single text block containing:

```text
please analyze

(user uploaded file to uploads/report-1710000000-abcd.csv)
```

returns:

- one ref for `uploads/report-1710000000-abcd.csv`;
- `cleanContent` as `[{ type: "text", text: "please analyze" }]`.

3. A file-only text block returns refs and an empty `ContentBlock[]`.
4. Multiple text blocks accumulate refs and preserve non-upload text.
5. A generated transcript annotation still strips `⟦upload: generated_transcript ...⟧` and preserves `kind: "generated_transcript"`.

### Component regression test

Add a `MessageBubble` test, likely `tests/message-bubble-uploads.test.tsx`.

Mock the same dependencies as the existing `message-bubble-*` tests:

- `useAuthData()` returns `{ currentWorkspace: { id: "ws-1" } }`;
- `MarkdownRenderer` renders plain text for assertions;
- tool-call and tooltip components can use the lightweight mocks from existing tests.

Test cases:

1. **String user content still works.**
   - Render a user `Message` with string content including an upload marker.
   - Assert the raw marker text is not present.
   - Assert the cleaned user text is present.
   - Assert an attachment card/button for the derived original filename is present.

2. **ContentBlock user content works after ai-chat reconciliation.**
   - Render a user `Message` with:

```ts
content: [
  {
    type: "text",
    text: "can you see this?\n\n(user uploaded file to uploads/report-1710000000-abcd.csv)",
  },
]
```

   - Assert `screen.queryByText(/user uploaded file/)` is null.
   - Assert `screen.getByText("can you see this?")` is present.
   - Assert the attachment card/button for `report.csv` is present.

3. **File-only block content does not render an empty user bubble.**
   - Render a user `Message` whose only block is the upload marker.
   - Assert the attachment card/button is present.
   - Assert the raw marker is absent.
   - Avoid brittle class assertions for the missing bubble; it is enough to verify no visible marker text and one attachment card.

4. **Copy uses cleaned content.**
   - Click the copy action on a block-content message with text plus upload marker.
   - Assert the `onCopy` callback receives the cleaned user text and not the upload marker.

## Verification

Run:

```bash
bun run test:run -- tests/parse-uploads.test.ts tests/message-bubble-uploads.test.tsx
bun run typecheck
```

If the new parser tests land in a different existing test file, adjust the first command accordingly.

Manual smoke path:

1. Start the app with `bun run dev`.
2. Open an existing workspace chat.
3. Attach two files and send a message.
4. Confirm the attachment cards/chips remain visible after the optimistic bubble reconciles.
5. Confirm the `(user uploaded file to uploads/...)` text never appears in the user-facing message body.
6. Reload the thread and confirm the persisted history still renders the attachment cards/chips and hidden markers correctly.

## Risks And Edge Cases

- `parseUploadRefs()` currently expects upload paths without whitespace before `)`. This plan does not change the marker grammar. Uploaded filenames are already stored in sanitized `uploads/...` paths.
- If `workspaceId` is missing, existing chip rendering is skipped because `FilePreviewChip` needs upload URLs. This plan preserves that behavior.
- If a marker is split across multiple text blocks, the helper will not reconstruct it. The current ai-chat conversion creates a single text part for user messages, so this is not expected for the regression.
- The helper drops text blocks that become empty after marker stripping. This is intentional so file-only messages render attachment chips without an empty bubble.

## Definition Of Done

- User-sent attachments render as the existing stylized attachment cards/chips before and after ai-chat reconciliation.
- Internal upload marker text is hidden in active chat for both string and `ContentBlock[]` user messages.
- Agent/model-facing message content still includes upload references.
- Focused tests cover the block-array regression.
- No attachment styling or upload pipeline redesign is included.
