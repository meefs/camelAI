# Sent Attachment Rendering Fix Feedback

## Findings

### P1: Sent-message image attachment chips do not get the clickable card hover affordance

`src/components/chat-file-preview/file-preview-chip.tsx:50`

The marker-stripping implementation looks solid, but the remaining image-hover issue is in `FilePreviewChip`, not in the new parser. Sent user messages render upload refs through `MessageBubble` -> `FilePreviewChip`. For image attachments, `FilePreviewChip` takes a custom image branch:

```tsx
className={cn(
  'h-[88px] w-[88px] overflow-hidden rounded-lg transition-opacity hover:opacity-90',
  className
)}
```

That branch has no `cursor-pointer`, no border, and no `hover:border-ring` / shadow transition. Non-image sent attachments do not have this issue because they render through `FileCard`, which already has `cursor-pointer`, `border`, `hover:border-ring`, and `hover:shadow-md`. The composer and group new-chat surfaces also do not have this issue because image attachments there render through `ImageTile`, which already has the correct selectable styling.

Recommended fix:

- Update the image branch in `FilePreviewChip` to use the same interactive shell classes as selectable `ImageTile`:

```tsx
'group/thumb relative h-[88px] w-[88px] cursor-pointer overflow-hidden rounded-lg border border-border bg-muted/30 transition-all duration-200 ease-out hover:border-ring hover:shadow-md'
```

- Keep `onClick={handleOpen}` as-is so the existing chat preview panel behavior remains unchanged.
- Consider adding `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring` while touching this, since the image branch is a button.
- Remove or avoid the current `transition-opacity hover:opacity-90` as the primary hover signal; the requested affordance is the outline/border change plus hand cursor.

Suggested focused test:

- Add or extend a `FilePreviewChip` test that renders `filename="photo.png"` and asserts the image button has `cursor-pointer`, `border`, and `hover:border-ring`.
- The new `tests/message-bubble-uploads.test.tsx` mocks `FilePreviewChip`, so it cannot catch this visual regression from the sent-message path.

## Notes

- The new `parseUploadRefsFromContent()` helper in `src/lib/chat-attachment-refs.ts` follows the intended architecture: it delegates string content to `parseUploadRefs()`, handles `ContentBlock[]`, preserves non-text blocks, and drops empty text blocks after marker stripping.
- `src/components/message-bubble.tsx` now uses the helper in the user-message branch, which addresses the optimistic-string versus reconciled-block mismatch that caused upload markers to leak.
- The added parser and `MessageBubble` tests cover the core regression well.

## Verification Run

```bash
bun run test:run -- tests/chat-attachment-refs.test.ts tests/message-bubble-uploads.test.tsx
bun run typecheck
git diff --check
```

All passed. `bun run typecheck` emitted existing Vite/wrangler warnings only.
