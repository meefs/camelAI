# Composer Attachment Hover Consistency — Implementation Feedback

Review of the working-tree diff against
`docs/composer-attachment-hover-consistency-plan.md`.

**Verdict: the implementation is faithful to the plan and structurally done.** All seven
steps landed as specced — shared `AttachmentHoverCard`/`AttachmentHoverPreview` in
`chat-file-preview/`, shared `ImageTile` with add/remove modes, the icon-slot X in
`FileCard` and the transcript card, the composer rewrite with the `previewUrl ??
serverImageUrl` fallback, `workspaceId` threading at all three call sites, and the group
card rewired as a thin composition with identical behavior (`filename={displayName}`,
`side="bottom"`, footer with `formatRelative`). Verified: `bun run typecheck` passes and
all 39 tests pass in `tests/attachment-list.test.tsx`,
`tests/attachment-hover-preview.test.tsx`, `tests/recently-used-in-group.test.tsx`. No
stale imports of the deleted `welcome-screen/attachment-hover-preview` remain.

One fix is required before this ships, from user testing: **cursors are wrong on the
composer tiles.**

## Fix: cursor semantics on composer attachment tiles

### Observed defect

Hovering a file attachment in the text input field shows the **text-insert (I-beam)
cursor** over the card body (which is not clickable) and the **default arrow** over the
top-right X (which IS clickable). It must be the opposite: hand pointer over anything
clickable, plain arrow over everything else.

### Why it happens

- The composer cards are now `<div>`s (no `onClick`), so their text nodes (filename,
  size, snippet, badge) get the browser's default `cursor: text`. The group screen never
  shows this because its cards are `<button>`s.
- Tailwind CSS v4's preflight styles buttons with `cursor: default` (the v3
  `cursor: pointer` rule was removed in v4, and `src/styles/globals.css` does not re-add
  it). Every clickable element in this codebase therefore opts in with an explicit
  `cursor-pointer` class — see `FileCard`'s `onClick && 'cursor-pointer'` and the
  add-mode `ImageTile`. The three new X buttons never opted in, so they show the arrow.

### The rule to apply

> Elements that do something on click get `cursor-pointer`. Inert card bodies get
> `cursor-default` (and `select-none` where they contain text) so no part of a chip
> ever shows the I-beam.

### Exact changes (6 edits, 3 files)

1. **`src/components/file-card.tsx:78`** — the card root currently has
   `onClick && 'cursor-pointer'`. Replace with:

   ```tsx
   // Cursor: hand when the card itself is clickable, arrow otherwise
   onClick ? 'cursor-pointer' : 'cursor-default select-none',
   ```

2. **`src/components/file-card.tsx:~110-125`** — the icon-slot X button: add
   `cursor-pointer` to its `className` (anywhere in the class list).

3. **`src/components/attachment-list.tsx:58`** — `TranscriptAttachmentCard` root `<div>`:
   add `cursor-default select-none` to the first `cn()` string (the one starting
   `'group/card relative flex h-[88px] w-[184px] ...'`).

4. **`src/components/attachment-list.tsx:~85-98`** — the transcript X button: add
   `cursor-pointer` to its `className`.

5. **`src/components/image-tile.tsx:70`** — the remove-mode root `<div>`: add
   `cursor-default` to the `cn()` string (no `select-none` needed; it contains only the
   image).

6. **`src/components/image-tile.tsx:~76-86`** — the X badge button: add `cursor-pointer`
   to its `className`.

Do **not** touch the add-mode paths — `image-tile.tsx:52` (add-mode button) and the
`FileCard` `onClick` branch already carry `cursor-pointer`, and the whole card is the
click target there, which is correct.

### Resulting cursor map

| Region | Cursor |
| --- | --- |
| Composer card body (file, image, transcript) | arrow (`cursor-default`) |
| Composer X button / X badge (hover-revealed) | hand (`cursor-pointer`) |
| Group-screen card or image tile (whole thing clickable) | hand — unchanged |
| Text inside composer chips | arrow, not selectable (`select-none`) |

No test changes needed for this (cursor classes aren't asserted anywhere); re-run
`bun run typecheck` and the three test files above after the edits.

## Noted, no action required

- `AttachmentHoverCard` accepts `children: ReactNode` rather than the plan's
  `ReactElement` — fine, since it wraps children in the `w-fit` div trigger.
- The transcript card's identity icon changed from `text-muted-foreground/50` to
  `text-muted-foreground` as a side effect of adopting the shared slot markup. This is
  the intended unification (it now matches file cards); keep it.
- New test coverage matches the plan (icon-slot remove, blob thumbnail, uploads-endpoint
  fallback, uploading state, null workspace) — good.
