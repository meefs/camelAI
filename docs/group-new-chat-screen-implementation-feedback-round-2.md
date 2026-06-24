# Group New Chat Screen Implementation Feedback - Round 2

**Date:** 2026-06-23
**Scope:** Review of the second implementation pass, focused on the new recent-attachment behavior and the transcript-as-upload duplication bug.

## Finding

### P0 - Persist upload origin so generated transcript uploads do not become recent attachment cards

The current implementation correctly keeps generated transcript attachments special while they are in the composer, but that semantic type is lost when the message is sent.

Current flow:

- `handleGeneratedTranscriptAttachment` creates a composer attachment with `kind: "transcript"` plus `sourceThreadId` / `sourceTitle` in `src/components/Chat.tsx:3206`.
- `buildMessageContent` sends only upload paths through `appendUserUploadReferences(...)` in `src/components/Chat.tsx:550`; it drops `kind`, `sourceThreadId`, and all other attachment metadata.
- The recent-items scan later parses every `(user uploaded file to uploads/...)` marker as a reusable attachment in `src/lib/group-new-chat-recent-items.ts:104`.
- `RecentlyUsedInGroup` filters attachment cards only by attached upload path and transcript cards only by attached transcript source thread id in `src/components/welcome-screen/recently-used-in-group.tsx:205` and `src/components/welcome-screen/recently-used-in-group.tsx:218`; it has no way to know that one upload card is actually a generated transcript artifact.

That means this sequence creates duplicate conceptual items:

1. User inserts a chat transcript into a new group chat.
2. The transcript is uploaded as a `.md` file so the agent can read it.
3. User sends the new chat.
4. On the next group new-chat screen, that generated transcript upload is discovered as a recent attachment, while the source chat is also available as a transcript card.

The fix is not to stop uploading transcripts. The upload is still the right transport mechanism for the agent. The fix is to persist the upload's semantic origin in the sent message and have recent-attachment extraction respect it.

## Required Architecture

### 1. Add typed upload references

Move from path-only upload references to typed upload references.

Add a small shared type near `src/lib/chat-attachment-refs.ts`:

```ts
export type UploadReferenceKind = "user_upload" | "generated_transcript";

export interface UploadReferenceInput {
  path: string;
  kind?: UploadReferenceKind; // default user_upload
  sourceThreadId?: string;
  sourceTitle?: string;
}
```

Then replace the path-only sender API:

```ts
appendUserUploadReferences(text, uploadPaths)
```

with a metadata-aware API:

```ts
appendAttachmentReferences(text, refs: UploadReferenceInput[])
```

The serialized message must still include the existing plain upload marker so every downstream agent/tool path continues to work:

```text
(user uploaded file to uploads/example.md)
```

For generated transcript uploads, append a stable machine annotation immediately after the marker, following the existing mention-annotation pattern:

```text
(user uploaded file to uploads/planning-chat-transcript.md) ⟦upload: generated_transcript source_thread_id=thread_123⟧
```

Do not rely on filename patterns as the primary implementation. A user can upload a real file named `meeting-transcript.md`; it should remain a normal recent attachment.

### 2. Update parsing to return upload kind

Extend `parseUploadRefs` (currently `src/components/chat-file-preview/parse-uploads.ts:32`) or move the parser into `src/lib/chat-attachment-refs.ts` so both UI and server-ish route code consume one parser.

Parser output should become:

```ts
interface ParsedUploadRef {
  originalText: string;
  mountPath: string;
  filename: string;
  originalName: string;
  kind: UploadReferenceKind;
  sourceThreadId?: string;
}
```

Parser rules:

- Existing refs without annotation parse as `kind: "user_upload"`.
- Annotated generated transcript refs parse as `kind: "generated_transcript"`.
- `cleanContent` strips both the upload marker and its optional machine annotation so the chat UI does not display raw metadata.
- Keep supporting legacy `/mnt/user-uploads/...` markers exactly as today.

### 3. Preserve kind when sending composer attachments

Update `buildMessageContent` in `src/components/Chat.tsx:550` so it passes typed refs, not just paths.

Mapping:

```ts
const refs = getCompletedAttachments(attachments).map((attachment) => ({
  path: attachment.path,
  kind: attachment.kind === "transcript" ? "generated_transcript" : "user_upload",
  sourceThreadId: attachment.sourceThreadId,
  sourceTitle: attachment.sourceTitle,
}));
```

This keeps the composer transcript tile and draft behavior as-is, but the durable sent message now carries enough information for future scans.

### 4. Exclude generated transcript refs from recent attachment cards

Update `extractGroupNewChatRecentItems` in `src/lib/group-new-chat-recent-items.ts:104`:

```ts
for (const uploadRef of parseUploadRefs(normalizedText).refs) {
  if (uploadRef.kind === "generated_transcript") continue;
  // existing normal attachment-card path
}
```

This preserves the intended model:

- Real user-uploaded files become recent attachment cards.
- Generated transcript markdown files do not become recent attachment cards.
- The source chat remains available as a transcript card through `group.transcriptCards`.
- The newly sent chat may later become its own transcript card after it has completed assistant output, but its generated transcript upload should not also appear as a file card.

### 5. Keep legacy fallback conservative

If the team needs to clean up staging/local data created by the current branch before this fix, add a temporary fallback only after the typed annotation support lands:

```ts
const legacyLikelyGeneratedTranscript =
  uploadRef.kind === "user_upload" &&
  uploadRef.originalName.endsWith("-transcript.md");
```

Use that only as a short-lived compatibility filter if needed. Do not make filename matching the long-term source of truth.

## Tests To Add

- `parseUploadRefs` parses and strips:
  - plain user upload refs as `kind: "user_upload"`;
  - generated transcript refs as `kind: "generated_transcript"` with `sourceThreadId`;
  - legacy `/mnt/user-uploads/...` refs unchanged.
- `appendAttachmentReferences` preserves normal upload markers and adds generated transcript annotations only for transcript attachments.
- `extractGroupNewChatRecentItems` includes normal upload refs but excludes generated transcript refs.
- Regression test for the user-reported flow:
  - message contains a generated transcript upload ref annotation;
  - recent items include no attachment card for that upload path;
  - transcript cards still come from `group.transcriptCards`.
- Negative test: a user-uploaded markdown file named `meeting-transcript.md` without the generated-transcript annotation still appears as a recent attachment.

## Notes

- The hover-card reuse and recent-attachment UI additions are directionally correct.
- Verification run locally against the current working tree:
  - `bun run typecheck`
  - `bun run test:run tests/group-new-chat-recent-items.test.ts tests/recently-used-in-group.test.tsx tests/condensed-transcript.test.ts tests/condensed-transcript-route.test.ts tests/attachment-list.test.tsx tests/use-draft-persistence.test.tsx`
- Those checks pass today, but they do not cover the generated-transcript-as-attachment duplication path yet.

---

# UI Review (PM/design pass) — Round 2 (2026-06-23)

Codex's P0 above (typed upload refs so a generated transcript doesn't re-appear as an attachment card) is correct and orthogonal to the visual work here. The findings below are the three UI changes requested: (1) make the attachment card match the other cards **at the component level**, (2) add the section-header structure on the group screen, and (3) shorten + uppercase the standard `/chat` section headers to match. Transcribing the mock is my lane; the upload-ref typing stays Codex's.

## P1 (UI) - Unify the attachment (File) card with the connection / project / transcript cards

User-flagged from the mock: the attachment card is the odd one out — `bg-muted/30` instead of the cards' `bg-card`, and a **translucent** category icon (`text-muted-foreground/50`) whose strokes darken where they overlap. Fix it **at the component level** in `FileCard` so it lands in the input field, the new-chat screen, and everywhere else at once.

`src/components/file-card.tsx` — container (`:62-74`) and icon (`:85`):

- **Background + hover** (default, non-error): `'border-border bg-muted/30'` + `'transition-colors duration-150 hover:border-border/80 hover:bg-muted/50'` → **`'border-border bg-card'`** + **`'transition-all duration-200 ease-out hover:border-ring hover:shadow-md'`** (this is exactly `transcript-card.tsx:48-49` / `RecentlyUsedTag`). Keep the error state (`border-destructive/40 bg-destructive/5`) and the progress bar untouched.
- **Icon** (`:85`): `text-muted-foreground/50` → **`text-muted-foreground`** (solid — kills the overlap artifact). Every other card uses a solid muted icon.
- **Badge (consistency, recommended):** FileCard uses a custom `bg-foreground/8` chip (`:79`) while the transcript card uses `Badge variant="outline"`. Switch FileCard's extension chip to the shared `Badge variant="outline" className="uppercase"` (`src/components/ui/badge.tsx`) so the `MD` / `CSV` badges read identically to the `CHAT` badge in the mock.

**Blast radius (intended).** `FileCard` renders in three places — `attachment-list.tsx:158` (composer / input field), `recently-used-in-group.tsx:349` (new-chat group), and `chat-file-preview/file-preview-chip.tsx:84` (in-message file chip). The request covers the first two; the in-message chip updates too, which is the uniform outcome we want — just **eyeball the in-message chip on the chat background** to confirm `bg-card` reads well there.

**Same row, finish the job.** For true uniformity in the composer attachment row, give the two FileCard siblings the same `bg-card` treatment: the image thumbnail (`attachment-list.tsx:137`, currently `bg-muted/30`) and the 184px transcript tile `TranscriptAttachmentCard` (`attachment-list.tsx:48-54`, currently `bg-muted/30`).

> Caveat: the cards lift on hover (`hover:border-ring hover:shadow-md`) because they're clickable. A composer attachment tile isn't clickable (it carries a remove-`X`), so a hover-lift there is slightly unusual — acceptable for the match, or gate the lift behind `onClick` if it feels off. Recommend applying it for uniformity.

## P1 (UI) - Group screen: two-level header system + the three sub-sections

Per the mock: keep **RECENTLY USED IN THIS GROUP** as the top-level header — but make it **white**, drop the `CornerDownRight` icon, and add a **separator line** beneath it — then split the body into three labelled sub-sections, each a grey CAPS label above its row: **PROJECTS & CONNECTIONS**, **ATTACHMENTS**, **TRANSCRIPTS**. A sub-section (and its label) renders only when it has items.

> **Label discrepancy to confirm:** your message said "CONNECTIONS & PROJECTS" but the mock shows **"PROJECTS & CONNECTIONS"**, which also matches the current tag order (projects render first, `recently-used-in-group.tsx:184-194`). Going with the mock — flip the label (and optionally the tag order) if you want connections first.

Restructure `recently-used-in-group.tsx:327-374`:

```tsx
// BEFORE — one grey eyebrow with an icon, then three unlabelled rows
<section className="space-y-4">
  <div className="flex items-center gap-1.5 text-xs ... text-muted-foreground">
    <CornerDownRight className="size-3.5" aria-hidden />
    <span>Recently used in this group</span>
  </div>
  {tags row}{attachments row}{transcripts row}
</section>

// AFTER — white L1 header + separator, then labelled sub-sections
<section className="space-y-6">
  <div className="border-b border-border pb-3">
    <span className="text-xs font-medium uppercase tracking-wider text-foreground">
      Recently used in this group
    </span>
  </div>

  {tags.length > 0 ? (
    <div className="space-y-3">
      <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Projects &amp; connections
      </h4>
      <div className="flex flex-wrap gap-3">{tags…}</div>
    </div>
  ) : null}

  {attachmentCards.length > 0 ? (
    <div className="space-y-3">
      <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Attachments
      </h4>
      <div className="flex flex-wrap gap-3">{fileCards…}</div>
    </div>
  ) : null}

  {transcriptCards.length > 0 ? (
    <div className="space-y-3">
      <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Transcripts
      </h4>
      <div className="flex flex-wrap gap-3">{transcriptCards…}</div>
    </div>
  ) : null}
</section>
```

- **Shared eyebrow typography** — the same class string everywhere so the two screens never drift: `text-xs font-medium uppercase tracking-wider`, with **`text-foreground` for level-1 (white)** and **`text-muted-foreground` for the sub-labels (grey)**.
- **Separator** — the `border-b border-border pb-3` on the header block gives the full-width line beneath the title, as in the mock. `src/components/ui/separator.tsx` (`<Separator />`) is the alternative if you prefer the primitive.
- Remove the now-unused `CornerDownRight` import.
- Spacing: `space-y-6` between the header and sub-sections, `space-y-3` inside each (label → row) reads like the mock; tune to taste.

## P1 (UI) - Standard /chat screen: shorten + uppercase the section headers

Make the no-group screen headers match the group screen's white eyebrow style. `SectionHeader` is used **only** in `welcome-screen/index.tsx`, so restyle the component directly — no external blast radius.

`src/components/welcome-screen/section-header.tsx:17`:

```tsx
// before
<h3 className="text-sm font-semibold text-foreground">{title}</h3>
// after
<h3 className="text-xs font-medium uppercase tracking-wider text-foreground">{title}</h3>
```

Keep `text-foreground` (it was already white — that's what "match the /chat screen" referred to). Then shorten each title. Pass normal-case strings and let the `uppercase` class do the casing (screen readers still read normal case):

| Current title | New (renders uppercase) | Sites in `index.tsx` |
|---|---|---|
| Your recent chats | Recent chats | 247, 283 |
| Continue building an app | **Your apps** | 260, 314 |
| What your team is working on | **Team apps** | 327 |
| Your connected tools / Connect your tools | **Connections** | 628-629 |
| Need inspiration? Try one of these | Try something new | 688 |

The two **bolded** rows are the gaps you flagged me to fill — `Your apps` (the user's own apps) and `Team apps` (the team's). Adjust wording if you'd prefer. For the empty connections state (`Connect your tools`) → "Connections" still reads fine; keep "Connect tools" if you'd rather the empty state nudge action.

- **Balance the action row to the smaller title:** the "View all →" link and "Shuffle" button (`section-header.tsx:24,35`) are `text-sm` — drop them to `text-xs` (icons to `size-3.5`) so they don't tower over the eyebrow. Keep them muted.
- **No separators on the standard screen** — the mock only puts a line under the group's "Recently used." This is the text restyle only.
- If the `text-xs` eyebrow feels too small above the large 260px cards, bumping to `text-[0.8125rem]` while keeping `uppercase tracking-wider` is fine — but `text-xs` is the literal match to the group screen.

## Nits / follow-ups

- The round-1 "reuse `FileCard` exactly" decision still holds — the recently-used attachment card simply inherits the improved component, so the two stay matched for free.
- After the restyle, re-run `tests/recently-used-in-group.test.tsx` and `tests/attachment-list.test.tsx`; add an assertion that the three sub-labels render in order and only when their row is non-empty.
