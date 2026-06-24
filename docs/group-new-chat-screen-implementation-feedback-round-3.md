# Group New Chat Screen Implementation Feedback - Round 3

**Date:** 2026-06-23
**Scope:** Review of the latest group-new-chat implementation pass, focused on the transcript upload dedupe fix, shared project/connection hover cards, recent attachments, and condensed transcript generation. I did not re-audit the unrelated broad worker/chat-thread branch history that also appears in this workspace's diff against `origin/main`.

## Summary

No blocking feedback. The implementation now matches the intended architecture:

- Generated chat transcripts remain real uploaded markdown files for the agent to read, but the sent message preserves their semantic origin with a typed upload annotation in `src/lib/chat-attachment-refs.ts`.
- `src/components/Chat.tsx` carries transcript attachment metadata through composer state, draft persistence, upload completion, and final send serialization.
- `src/lib/group-new-chat-recent-items.ts` excludes `generated_transcript` upload refs from attachment cards while still keeping normal markdown uploads such as `meeting-transcript.md`.
- The condensed transcript route generates previews/uploads from the underlying thread messages, not from summary card metadata.
- Transcript previews use the existing turn-rendering helpers for final assistant output and omitted trace/intermediate work, which keeps them aligned with chat UI semantics.
- Project/connection hover preview UI is factored into a shared component and reused by both composer @mention chips and the new-chat screen tags.
- Recent attachments use the shared `FileCard`, and inserted attachment/transcript membership is derived from current composer state, so remove-and-return behavior works cleanly.

## Optional Follow-Up

### P2 - Add one builder-to-extractor regression test

Current tests cover the important pieces: typed upload reference serialization, upload-ref parsing, recent-item extraction, draft persistence, hover-card reuse, and the negative case where a normal markdown file named like a transcript remains a normal attachment.

The only extra hardening I would add is one boundary test that uses the actual sender helper output as extractor input. This protects the exact bug path if the machine annotation format changes later.

Add to `tests/group-new-chat-recent-items.test.ts`:

```ts
const content = appendAttachmentReferences("use this", [
  {
    path: "uploads/planning-chat-transcript.md",
    kind: "generated_transcript",
    sourceThreadId: "thread_source",
  },
]);

const items = extractGroupNewChatRecentItems({
  connections: [],
  projects: [],
  threads: [
    {
      threadId: "thread_new",
      title: "Follow-up chat",
      messages: [{ role: "user", created_at: 1, content }],
    },
  ],
});

expect(items.attachmentCards).toEqual([]);
```

Keep the existing control that a plain user-uploaded `.md` file is included. This is not required to ship the feature; it is just a cheap guard against future drift between `appendAttachmentReferences` and `parseUploadRefs`.

## Verification

Passed locally:

- `bun run typecheck`
- `bun run test:run tests/chat-attachment-refs.test.ts tests/parse-uploads.test.ts tests/group-new-chat-recent-items.test.ts tests/recently-used-in-group.test.tsx tests/transcript-hover-preview.test.tsx tests/condensed-transcript.test.ts tests/condensed-transcript-route.test.ts tests/attachment-list.test.tsx tests/use-draft-persistence.test.tsx tests/chat-groups-ui.test.tsx tests/chat-group-hover-card.test.tsx`

