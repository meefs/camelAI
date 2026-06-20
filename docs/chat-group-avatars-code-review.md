# Chat Group Avatars Implementation Review

Date: 2026-06-19

## Findings

### 1. High: Sidebar can collapse to an empty group list when group loading fails

This matches the reported behavior: the active group can still appear through the route-level `activeChatGroup`, but the full sidebar list disappears when the parent `_app` chat-groups load resolves to `[]`.

Relevant paths:
- `src/routes/_app.tsx:175-183` catches any `listGroupsForWorkspace` error and returns `[]`.
- `src/hooks/use-chat-groups.tsx:751-754` replaces `resolvedChatGroups` with `[]` when the parent promise rejects.
- `src/hooks/use-chat-groups.tsx:1300-1305` then merges that empty list with only the current route `activeChatGroup`.
- `src/lib/chat-groups.server.ts:151-205` added best-effort emoji backfill work to the same group-loading path.

Even if the root cause is a transient DO/AI/backfill error, the UI should not erase the last known group list for the same workspace. That failure mode is too destructive for a decorative avatar feature.

Recommended fix:
- Wrap `maybeBackfillChatGroupEmojis(...)` calls in a defensive `try/catch`, and validate `typeof ai?.run === "function"` before scheduling model work.
- Keep emoji backfill strictly non-blocking and impossible to affect the return value of `listGroupsForWorkspace`.
- In `ChatGroupsProvider`, when the workspace has not changed, do not replace an existing non-empty `resolvedChatGroups` with `[]` on a rejected/degraded parent promise. Keep the previous list and log/surface the error separately.
- Add a regression test where the parent `chatGroups` promise rejects during same-workspace tab navigation and the sidebar retains the previous groups.

### 2. High: Title-flow emoji generation is dropped for non-empty fallback groups

`workers/main/src/identity/user-do.ts:1647` returns before writing the generated emoji whenever the group already has a non-empty name:

```ts
if (!group || group.name.trim().length > 0) return;
```

Because `setGeneratedChatGroupEmoji(...)` is only called later at `workers/main/src/identity/user-do.ts:1660-1661`, generated emojis are skipped for any single-thread group that was created with a fallback name. Those groups rely entirely on lazy backfill. If the parent group list/backfill path is failing or throttled, they stay on the default `💬`.

Recommended fix:
- Split "rename empty group" from "set generated emoji".
- Preserve the existing rename guard, but allow the generated emoji write for any single-thread group whose `avatar_content_source` is still `default`, even if the name is already non-empty.
- Add a worker test for a single-thread group with a non-empty fallback name: `renameEmptySingleThreadGroupForThread(threadId, generatedTitle, { generatedEmoji })` should leave the name alone but update the emoji when the avatar source is `default`.

### 3. Medium: Route-local fallback avatars always use the same default combo

`src/routes/_app.chat.$id.tsx:417` constructs a fallback active group with:

```ts
avatar: generateDefaultChatGroupAvatar(),
```

That always returns the first palette color plus `💬`. When the parent group list is unavailable, the sidebar can render only this route-local fallback group, which explains why the same emoji/color combo appears repeatedly.

Recommended fix:
- Avoid using a hardcoded default avatar for route-local fallback when a real group id exists. Prefer fetching the persisted group summary, or derive a deterministic fallback from the group id/thread id so distinct fallback groups do not all look identical.
- Add a test around `mergeActiveChatGroup` / route fallback behavior to ensure a fallback active group does not overwrite a persisted group's avatar with the default chip.

### 4. Medium: Emoji picker bundles a large JSON dataset into the client

`src/components/ui/emoji-picker.tsx:4-5` imports:

```ts
import emojiData from "emojibase-data/en/data.json"
import messages from "emojibase-data/en/messages.json"
```

The imported JSON is about 782 KB raw (`data.json` is about 775 KB). The picker also renders filtered search results directly rather than virtualizing them. This may be acceptable if the modal is code-split, but right now it should be treated as a performance risk.

Recommended fix:
- Confirm the avatar editor/emoji picker is split out of the main app chunk.
- Consider using `compact.json`, a trimmed local dataset, dynamic import on modal open, or virtualization for search results.
- Add a bundle-size check or at least manually inspect the built chunk before shipping.

## Notes

- The emoji validation blocker was implemented in the right direction: `emoji-regex` now accepts ZWJ families, skin-tone modifiers, and the pride flag, and tests cover those cases.
- The API route now validates `{ name, avatar }` before calling `updateChatGroup`, which is good.
- The UserDO schema version test was updated to V10 and the focused UserDO avatar tests pass.

## Checks Run

```bash
bun run test:run tests/avatar.test.ts tests/chat-groups-routes.test.ts tests/chat-groups-ui.test.tsx tests/chat-group-avatar-generation.test.ts
bun run test:workers -- workers/main/tests/user-do-chat-groups.test.ts
bun run typecheck
```

All three checks passed.

---

## UI Review (design audit) — 2026-06-19

Audited the implemented surfaces (`src/components/avatar/avatar-editor.tsx`, `src/components/ui/color-picker.tsx`, `src/components/ui/emoji-picker.tsx`, `src/components/avatar/rename-chat-group-dialog.tsx`, `src/components/settings/avatar-picker.tsx`) against the prototypes. The four reported issues, plus a few found while auditing. Fixes are spelled out because the implementing agent is strong on logic but weak on UI.

### U1. High: Modal footer (Cancel/Save) is cut off — user must scroll to reach Save

Reported. The Save/Cancel row sits below the fold; it only appears after scrolling the whole modal.

Where:
- `src/components/avatar/rename-chat-group-dialog.tsx:166` — `<DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">`
- `src/components/avatar/rename-chat-group-dialog.tsx:147-149` — mobile `<SheetContent ... className="max-h-[90vh] overflow-y-auto ...">`
- Identical bug in the settings editor: `src/components/settings/avatar-picker.tsx:148` (Dialog) and `:126-129` (Sheet).

Root cause: header, body, and footer are all children of one `overflow-y-auto` container capped at `max-h-[90vh]`. The base `DialogContent` is `display:grid; gap-4` (`src/components/ui/dialog.tsx:61`) with no dedicated scroll region, so when the body exceeds 90vh — preview + name + color presets + the open 160px spectrum (`color-picker.tsx:50`, `h-40`) + hex + emoji search + category tabs + the fixed 256px emoji grid (`emoji-picker.tsx:150`, `h-64`) — the entire dialog scrolls and `DialogFooter` (the last grid row) is pushed off-screen.

Fix: cap height on a flex column and let only the body scroll, so header + footer stay pinned:

```tsx
<DialogContent className="flex max-h-[90vh] flex-col gap-4 sm:max-w-lg">
  <DialogHeader className="shrink-0">…</DialogHeader>
  <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
  <DialogFooter className="shrink-0">{footer}</DialogFooter>
</DialogContent>
```

Apply the same restructure to the mobile `SheetContent` and to `settings/avatar-picker.tsx` (same bug — it will cut off Save the moment the full catalog/spectrum are visible).

Avoid nested scroll: once the body scrolls, the inner `h-64` emoji grid creates a scroll-within-scroll. Pick one scroll region — either let the emoji grid grow and rely on the dialog body to scroll, or keep the emoji grid as the only scroller and size the rest to fit. Don't ship both.

### U2. Medium: Custom-color swatch — squared rainbow edge + the "+" has no backing chip

Reported (desired vs current screenshots). Two problems on the trailing rainbow swatch in the Color row.

Where: `src/components/avatar/avatar-editor.tsx:87-98`.

(a) Squared rainbow halo: the conic gradient is painted on the square button box (`bg-[conic-gradient(...)]`) which also carries `border border-border`. With default `background-clip: border-box`, the gradient fills to the box corners; the border + rounding leave a squared rainbow edge that's obvious when magnified. Fix — clip the gradient to a true circle and drop the competing border:

```tsx
// button: keep rounded-full + selection ring; add overflow-hidden; remove `border border-border`
className="relative grid size-7 place-items-center overflow-hidden rounded-full shadow-sm …"
// gradient on an inner clipped layer (guarantees a clean circle) + soft white center to match the color-wheel target:
<span aria-hidden className="absolute inset-0 rounded-full bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.85),transparent_45%),conic-gradient(from_90deg,#ef4444,#f59e0b,#10b981,#3b82f6,#8b5cf6,#ec4899,#ef4444)]" />
```

(b) "+" needs a dark disc behind it (target screenshot). Replace the bare `<Plus className="size-3.5 drop-shadow" />` with a Plus on a solid chip:

```tsx
<span className="relative grid size-4 place-items-center rounded-full bg-background text-foreground shadow">
  <Plus className="size-3" />
</span>
```

This matches the target and fixes the low-contrast white-+-on-yellow problem.

Keep the existing selection ring (`ring-2 ring-foreground ring-offset-2 ring-offset-background`) — that already matches the target's white ring + gap.

### U3. Medium: Emoji category panel has square corners that overflow the rounded container

Reported (the "smileys & emotion" header pokes past the rounded outline).

Where: `src/components/ui/emoji-picker.tsx:150` (rounded container) and `:157` (sticky header).

Root cause: the sticky category header uses `backdrop-blur` (with `bg-popover/95`). A `backdrop-filter` paints into its own buffer and escapes the ancestor's `rounded-md` clip, so the header's square top corners render past the container's rounded border. `overflow-y-auto` + `border` cannot contain a backdrop-filtered child.

Fix: make the header opaque (drop `backdrop-blur`) and move the radius onto an `overflow-hidden` wrapper with the scroller inside it:

```tsx
<div className="h-64 overflow-hidden rounded-md border bg-popover">
  <div className="h-full overflow-y-auto">
    …
    <div className="sticky top-0 z-10 bg-popover px-2 py-1.5 …">  {/* no backdrop-blur */}
```

### Additional findings from the audit (not in the report)

- **U4 — Medium polish:** The emoji picker exposes a "components" tab (visible in the full-modal screenshot). That's emojibase group 2 — skin-tone and hair *modifiers*, not standalone emoji — so it shouldn't be a browsable avatar category. Exclude that group when building `GROUPS`/`ALL_EMOJI` (`emoji-picker.tsx:37-73`) and confirm "smileys & emotion" is the default tab.
- **U5 — Low:** `avatar-editor.tsx:139,144` hardcodes `id="avatar-content"` for the initials field — use `useId()` to avoid duplicate-id collisions if two editors ever mount. The initials `Input` (`:143`) has no `maxLength`; the "2 letters or one emoji" rule is enforced only on Save (`avatar-picker.tsx:81`). Add `maxLength={2}` on the initials path for immediate feedback.
- **Perf (cross-ref finding #4):** the ~782 KB emojibase JSON loads with this editor; confirm the modal/editor is code-split so it isn't in the main app chunk (also reduces U1's weight).
