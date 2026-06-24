# Group New Chat Screen Implementation Feedback

**Date:** 2026-06-23
**Scope:** Review of the current working-tree implementation for the active-group new chat screen, plus the requested follow-up UX changes.

## Findings

### P1 - Add mention hover cards to recent project/connection tags

The basic tag insertion flow works, but the new group-screen tags and the standard new-chat connection pills do not reuse the existing `@mention` hover preview.

- Current group tags are plain buttons in `src/components/welcome-screen/recently-used-in-group.tsx:37`.
- Current standard `/chat` connection pills are plain buttons in `src/components/welcome-screen/connected-tools.tsx:12`, rendered from the non-group welcome screen at `src/components/welcome-screen/index.tsx:624`.
- The hover UI already exists inside `src/components/at-mention-menu/composer-mention-overlay.tsx:131` (`ConnectionHoverPreview`, `ProjectHoverPreview`, `ChipHoverPreview`) and is wrapped with Radix `HoverCard` at `src/components/at-mention-menu/composer-mention-overlay.tsx:354`.

Implementation direction:

- Extract the preview body into a reusable component, for example `MentionTargetHoverPreview`, exported from the at-mention package or a new `src/components/at-mention-menu/mention-target-hover-preview.tsx`.
- Add a small wrapper, for example `MentionTargetHoverCard`, that uses the same `HoverCard`, `openDelay={200}`, `closeDelay={100}`, width, padding, and placement as the composer overlay.
- Wrap both `RecentlyUsedTag` and `ConnectedTools` pill buttons with `HoverCardTrigger asChild` so hover previews appear for group tags and for the standard `/chat` connected-tools row.
- Keep click behavior unchanged: hover previews are informational; clicking still inserts/appends the mention.

Tests:

- Add a standard welcome-screen test showing a connected-tool pill reveals connection hover details.
- Add a group-screen test showing a recently-used project and connection reveal the same hover preview.

### P1 - Add recently used attachments to the active-group new chat screen

This implementation does not yet surface prior attachments from sibling chats. That matches the original plan, but it is now a requested addition.

Source the data from the same bounded sibling-thread scan used for recently-used projects/connections:

- The route already scans capped sibling thread messages in `src/routes/_app.chat._index.tsx:537`.
- Upload references are already parseable with `parseUploadRefs` in `src/components/chat-file-preview/parse-uploads.ts:32`.
- User upload references are appended to sent messages through `buildMessageContent` / `appendUserUploadReferences` in `src/components/Chat.tsx:548`.

Implementation direction:

- Extend `GroupNewChatPayload` with an `attachmentCards` array:

```ts
attachmentCards: Array<{
  path: string;              // uploads/...
  filename: string;
  originalName: string;
  sourceThreadId: string;
  sourceTitle: string;
  lastUsedAt: number;
  contentType?: string;
  size?: number;
}>;
```

- During the bounded message scan, run `parseUploadRefs` over user-authored message text after normalizing visible text. Deduplicate by `path`, preserve newest-first thread/message order, and cap the list separately from transcript cards.
- Render attachment cards between tags and transcript cards. They are a third object kind, so keep them visually distinct from tags and transcripts.
- The card must match the existing composer file attachment card exactly. Reuse `FileCard` from `src/components/file-card.tsx:37`; do not create another custom attachment-card visual.
- On click, insert the existing uploaded file into the composer as a completed attachment. Do not re-upload the file. The message send path only needs the `uploads/...` path to re-append the upload reference.
- Avoid fake file sizes. If the original size is not available from history, make the relevant attachment/card size field optional and pass `fileSize={undefined}` to `FileCard`, so it renders the same card shell without showing `0 B`.
- Derive membership the same way transcripts work: once the uploaded file path is present in composer attachments, hide the source attachment card; removing it returns the card.

Tests:

- Unit-test upload-ref extraction from sibling messages, including multiple references in one message and duplicate paths across threads.
- Component-test attachment card rendering with `FileCard` styling and click-to-insert behavior.
- Draft-persistence test that restored inserted attachment cards stay complete and keep their `uploads/...` path.

### P2 - Do not block the whole welcome experience on the recently-used scan

The current loader waits for the bounded mention scan before the deferred `interactive` payload resolves:

- `src/routes/_app.chat._index.tsx:527` says the interactive bundle gates the real composer render.
- `src/routes/_app.chat._index.tsx:537` awaits `loadRecentlyUsedInGroup(...)`, which can perform up to eight sibling `ChatThreadDO` reads.

Cold DO reads are usually acceptable one at a time, but eight parallel reads can still turn the active-group new-chat screen into a skeleton longer than necessary. The card metadata does not need that scan.

Implementation direction:

- Return the group header and `transcriptCards` as soon as `activeChatGroup` is available.
- Load `recentlyUsed` tags and the new `attachmentCards` as an independent deferred value or a small group-recent-items endpoint.
- Render the section with partial data: transcript cards immediately, then fill in tags/attachments when the scan resolves.
- Keep failures local to the recent-items scan; they should not block the composer.

### P2 - Carry `first_user_message` through live group update paths

The server summary now includes `first_user_message`, but the live group hook still only tracks title/model/latest-message-style metadata:

- `LiveThreadMetadata` has latest/running fields but no first-user field at `src/hooks/use-chat-groups.tsx:39`.
- `ThreadSummaryPatch` only supports title/model at `src/hooks/use-chat-groups.tsx:54`.
- The live merge equality in `src/hooks/use-chat-groups.tsx:700` does not compare or update `first_user_message`.

Because `buildGroupNewChatPayload` uses `first_user_message` for card `openingLine` at `src/routes/_app.chat._index.tsx:120`, the opening line can stay stale or fall back to latest/summary data until a full loader refresh catches up.

Implementation direction:

- Add `firstUserMessage?: string | null` to the live metadata/patch path.
- Preserve/compare/update `first_user_message` inside `applyLiveRunningStatuses`.
- Where the first user message is known locally, include it in the `dispatchLocalThreadStatus` payload for the first user turn.
- Add a focused `use-chat-groups` test that a local/live update does not drop or stale `first_user_message`.

## Notes

- I did not find a blocking bug in the core transcript path. The route, extraction helper, markdown serializer, generated upload attachment, and draft metadata are aligned with the plan.
- Verification run locally:
  - `bun run typecheck`
  - `bun run test:run tests/condensed-transcript.test.ts tests/condensed-transcript-route.test.ts tests/attachment-list.test.tsx tests/use-draft-persistence.test.tsx`

---

# UI Review (PM/design pass) — 2026-06-23

**Verdict:** the structure is right — lockup, derived membership, transcript fetch/cache, and the omitted-note placement (now correctly under the **Assistant** label) all landed. The gaps below are visual polish on the shipped screen plus the UI contract for the two requested additions. Codex authored the data/logic in the P1 sections above; the notes here are the **UI spec** the coding agent should implement against. (Transcribing the screenshots is my lane; the backend stays Codex's.)

## New issues on the shipped screen (user-flagged)

### P1 (UI) - Transcript hover preview: padding, full-bleed assistant band, no horizontal scroll

Visible in the current-state screenshot: the popover content floats inside a uniform inset, the assistant band stops short of the left/right edges, and there is a slight horizontal scrollbar. Three root causes, all in `transcript-card.tsx` + `transcript-hover-preview.tsx`:

1. **Uniform popover padding.** `HoverCardContent` uses `className="w-80 p-3"` (`transcript-card.tsx:74`). That 12px inset is the "gap between the container and the content."
2. **Right-edge gap + can't bleed.** The scroll root uses `pr-1` (`transcript-hover-preview.tsx:45`), and the assistant band fakes full-bleed with `-mx-3` (`:64`). The `-mx-3` is computed against the *padded* box and the `pr-1` eats the right side, so the band lands ~4px short on the right and isn't symmetric.
3. **Horizontal scrollbar.** The `-mx-3` band is wider than its scroll container, and `overflow-y-auto` with no `overflow-x` rule promotes `overflow-x` to `auto` (CSS spec) → a stray horizontal scrollbar.

**Fix — make the popover full-bleed and pad internally (vertical padding kept, band reaches L/R edges):**

- `transcript-card.tsx:74` — `className="w-80 p-3"` → **`className="w-80 overflow-hidden p-0"`** (`p-0` removes the inset; `overflow-hidden` clips the full-bleed band to the rounded corners and kills any x-overflow).
- `transcript-hover-preview.tsx:45` — `'max-h-[360px] overflow-y-auto pr-1'` → **`'max-h-[360px] overflow-y-auto overflow-x-hidden'`** (drop `pr-1`, explicitly forbid x-scroll).
- Ready content (`:55`) — wrap the turns list in vertical padding and inset only the *text*, not the band:
  - turns wrapper: `className="space-y-4"` → **`className="space-y-4 py-3"`**
  - user block (`:58`): `className="space-y-1.5"` → **`className="space-y-1.5 px-3"`**
  - assistant band (`:64`): `className="-mx-3 space-y-1.5 bg-muted/50 px-3 py-3"` → **`className="space-y-1.5 bg-muted/50 px-3 py-3"`** (drop `-mx-3`; with `p-0` on the popover the band now spans edge-to-edge, while `px-3` keeps the assistant text aligned with the user text).
- Apply the same to the non-ready states so they aren't flush against the edge: `LoadingPreview` (`:28`) drop its `-mx-3` and wrap the skeletons in `px-3 py-3`; give the error/empty `<p>` (`:49`, `:51`) `px-3 py-3`.

Net result: vertical padding preserved, assistant background runs fully L↔R, no horizontal scroll. (Let markdown code blocks wrap/scroll *inside themselves*; the container must not x-scroll.)

### P1 (UI) - Transcript User turn: keep the upload-reference annotation, just de-emphasize it

In the screenshot the **User** turn renders `(user uploaded file to uploads/pawfectly-…-transcript-….md)` beneath the message. **Keep this — do not strip it.** It's useful on purpose: the agent can trace that exact path to the file the user uploaded, and it reassures the user that prior uploads stay accessible. The only issue is visual weight — it currently renders at full message size/color and competes with the message. **Format it like the `[N messages omitted]` note: small, grey, italic.**

This is a **preview-rendering change only.** The uploaded `.md` transcript must keep the ref inline as plain text (the agent reads it), so do **not** change `CondensedTranscript` or the markdown serializer (`src/lib/condensed-transcript.ts`). The split happens in `transcript-hover-preview.tsx`, where the User turn renders `turn.user` as a single `<p>` (`:60`):

- Use `parseUploadRefs` (`src/components/chat-file-preview/parse-uploads.ts`) on `turn.user` to locate the `(user uploaded file to <path>)` segment(s).
- Render the message text (refs removed, trailing whitespace trimmed) in the existing `text-sm leading-relaxed text-popover-foreground` style.
- Render each upload ref on its **own line below the message**, reusing the **exact** omitted-note treatment — the same class string as `transcript-hover-preview.tsx:67`: **`text-xs italic text-muted-foreground`**. Keep the full `(user uploaded file to <path>)` text (reconstruct via `buildUserUploadReference(path)` from `src/lib/chat-attachment-refs.ts`, or keep the matched substring). One muted line per ref if a turn has several.

Net: the User side now mirrors the Assistant side — a quiet, scannable annotation that stays legible and traceable. Test: a User turn carrying an upload ref renders the message in normal style and the `(user uploaded file to …)` line in the muted italic style, and the path text is still present (not stripped).

### P1 (UI) - Reorder the screen: title → composer → recently used

Per the reorder screenshot, the composer should sit directly under the lockup, with the Recently-used section beneath it (today it's lockup → recently-used → composer in `index.tsx:503-556`).

- **Move** `<RecentlyUsedInGroup … />` (`index.tsx:508-517`) to render **after** the composer block.
- **Drop the big gap:** the composer is wrapped in `<div className="pt-10">` (`index.tsx:519`) — remove the `pt-10`. That spacing existed to keep the section from crowding the input when it sat *above*; it's now below.
- **Match the standard screen's rhythm:** change the group container `space-y-8` (`index.tsx:505`) → **`space-y-10`**, which is exactly what the no-group screen uses for greeting → composer → sections (`index.tsx:560`). Result: lockup → composer ≈ 40px (matches outside-a-group), composer → recently-used ≈ 40px.
- **Side effect to verify:** the group composer sets `mentionMenuSide="top"` (`index.tsx:543`). With the composer moving up near the header, the @-mention menu opening upward may collide with the lockup — re-check and switch to the standard screen's setting if it clips.

Resulting order inside `if (group)`: `GroupNewChatHeader` → composer block (no `pt-10`) → `RecentlyUsedInGroup`.

## UI contract for the two requested additions (amends Codex's P1 sections)

### Amends "Add mention hover cards to recent project/connection tags"

The reusable piece already exists and is already generic — minimal extraction:

- **Reuse `ChipHoverPreview`** (`src/components/at-mention-menu/composer-mention-overlay.tsx:185-189`). It already takes `target: AtMentionEntity` and dispatches to `ConnectionHoverPreview` (`:131`) / `ProjectHoverPreview` (`:163`). Export it (e.g. as `MentionTargetHoverPreview`) rather than rebuilding the body. **Do not restyle the preview** — connection rows show icon + name, type · category, the amber "No credentials configured" dot, and "Updated …"; project rows show description + "Updated …". That's the contract.
- **Replicate the popover chrome exactly** from `:375-379`: `className="w-auto min-w-[200px] max-w-[280px] rounded-md border border-border p-2 shadow-md ring-0"`, `openDelay={200} closeDelay={100}`.
- **Placement:** the composer uses `side="top"` because the chip is inside the input. For the pills, prefer **`side="bottom"` + `collisionPadding`** so it auto-flips and never clips — do not blindly copy `side="top"`.
- **Both call sites, same `AtMentionEntity`:** group tags (`recently-used-in-group.tsx:46`, the `RecentlyUsedTag` button) already build the entity; the standard `/chat` `ConnectedTools` pills (`connected-tools.tsx:18`) pass a raw `Integration` — normalize to `{ ...connection, kind: 'connection' }` before handing it to the preview. Wrap each pill button with `HoverCardTrigger asChild`; **click still inserts** (hover is informational).
- **Scope reminder (user request):** this applies to the **standard `/chat` new-chat screen too**, not just groups — a non-group new chat must surface the hover when hovering a connection pill. That's a change to the shared `ConnectedTools`, so it lands everywhere that renders it.
- Because membership is derived, inserting a tag unmounts it → its `HoverCard` unmounts → preview closes cleanly. Tests: one standard-screen test (connected-tool pill reveals connection details) and one group-screen test (a project tag and a connection tag both reveal the preview).

### Amends "Add recently used attachments to the active-group new chat screen"

The card must match the composer file attachment **exactly**, so reuse `FileCard` (`src/components/file-card.tsx:37`) — do not build a new visual:

- **Interaction = click-to-insert, not remove.** Pass `onClick` (FileCard renders as a `<button>`) and **omit `onRemove`** so the hover `X` (`file-card.tsx:124`) does not appear — in this section the card *adds* the file; it isn't a staged upload. Do **not** reuse the custom 184px `TranscriptAttachmentCard` (`attachment-list.tsx:33`) — that's the in-composer transcript tile, a different object.
- **No fake sizes.** Historical refs have no byte size → pass `fileSize={undefined}`; `FileCard` already renders the shell with no size line (`file-card.tsx:104-106`). Good as Codex noted.
- **Image attachments are a real gap.** In the composer, completed images render a thumbnail, not `FileCard` (`attachment-list.tsx:134`). History gives us a `uploads/…` path but **no `previewUrl`**, so "match exactly" can't reproduce the thumbnail without wiring an R2 preview URL. Pick one and note it: (a) render `FileCard` for images too here (simplest; minor divergence from the input row), or (b) resolve a preview URL from the path for image types. Recommend (a) for v1.
- **Placement & the "third kind" rule.** Keep one section eyebrow. Render attachments as their **own** `flex flex-wrap gap-3` row (don't mix 88px squares into the 200px transcript row). Three distinct shapes now carry meaning: **pill** (mention) / **200px card** (transcript) / **88px square** (file) — that satisfies the spec's "never collapse into the same shape." Codex's order (tags → attachments → transcripts) is fine; tags → transcripts → attachments is equally fine — just keep each kind in its own row.
- **On insert** the file enters the composer as a normal `status:'complete'` attachment by path (no re-upload), so it renders as the standard `FileCard` in the composer row — visually consistent end to end. Derive membership by `path` present in composer attachments (mirror the transcript flow), so inserting hides the source card and removing returns it.
- Minor design call: the sibling recently-used cards lift on hover (`hover:border-ring hover:shadow-md`); `FileCard`'s native hover is subtler (`hover:border-border/80`). Either keep FileCard's hover (true "exact match") or add the sibling lift for a consistent row — recommend keeping FileCard's exact look since the user asked for an exact match.

## Nits

- `recently-used-in-group.tsx:44` falls back to the literal string `'Project'` for an unnamed project tag; the hover preview reuse (above) will surface a richer label, but confirm the pill itself never shows a bare `Project` for a real project with a name.
- After the reorder, re-check the `max-w-3xl` column (`index.tsx:505`) still centers the lockup and that the transcript-card row wraps sensibly under the composer at narrow widths.
