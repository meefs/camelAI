# Chat Group Avatars Follow-up Code Review

Date: 2026-06-19

Scope: follow-up review of the chat group avatar implementation diff against `origin/main`, after the sidebar disappearance and repeated default avatar issues were addressed.

## Findings

One new high-severity finding after product testing: the avatar work is now coupled too tightly to the existing thread/group title flow. The two originally reported sidebar/avatar regressions still appear addressed, but this title regression should be fixed before merging.

### 1. High: Avatar generation can keep new groups stuck as placeholder "New Chat"

`workers/main/src/chat-thread-do.ts:8792-8814`  
`src/lib/chat-groups.server.ts:151-204`  
`src/lib/chat-groups.server.ts:320-338`

Product testing saw only 1 of 3 new chat groups generate a real title + emoji; the other 2 stayed on `New Chat` + default `💬`. I did not call this out strongly enough in the first follow-up review.

There are two related risks in the current implementation:

- In the ChatThreadDO path, the group rename is delayed until after the new emoji-generation AI call. The thread title is written first, but `renameEmptySingleThreadGroupForThread(...)` is not called until `generateChatGroupEmojiWithOpenAI(...)` finishes or fails. That means group naming now depends on extra avatar work that did not exist on main.
- Lazy emoji backfill is driven from hydrated `ChatGroupView.name`. Hydration fills an empty persisted group name from the current thread title, so brand-new groups can appear as `New Chat` even though the stored group name is still blank. Backfill currently treats any non-empty visible name as eligible, so it can spend AI on placeholder `New Chat`, mark the default-source group as attempted, and possibly set `💬` as `source = generated` before the real title exists.

Recommendation:

- Restore the main-branch invariant that thread/group naming is independent from avatar generation. After `generateThreadTitleWithOpenAI(...)` returns a title, immediately update the OrgDO thread title and immediately call `renameEmptySingleThreadGroupForThread(threadId, title)` before any emoji work.
- Move generated-emoji work to a best-effort path after the naming write. Either schedule it with `ctx.waitUntil(...)` or make a separate UserDO claim/check before spending AI. Failure, timeout, or throttling in emoji generation must not delay or prevent title/group naming.
- Skip lazy emoji backfill for placeholder titles: use `isPlaceholderThreadTitle(...)` and also avoid treating hydrated display fallbacks as authoritative persisted names. Ideally the UserDO claim method should select only persisted non-placeholder group names.
- Do not set `avatar_content_source = 'generated'` from a placeholder/default title. If the input is `New Chat`, skip instead of generating/storing `💬`.
- Add regression tests:
  - ChatThreadDO title generation updates the thread title and group name even when emoji generation rejects or never resolves.
  - `titleGenerationInFlight` is released after title/group naming, not held by emoji generation.
  - Lazy backfill does not claim or mark groups whose visible name is a placeholder fallback like `New Chat`.
  - A generated title can still later produce a non-default emoji for a group that started with no persisted name.

### 2. Medium: Rename dialog can reset unsaved edits on unrelated rerenders

`src/components/avatar/rename-chat-group-dialog.tsx:59-72`

`normalizedInitialAvatar` is memoized from the `initialAvatar` object reference, then used as a dependency for the open-state reset effect. If `ChatTabBar` rerenders while the dialog is open and passes a fresh but value-equivalent avatar object, the effect can reset `name`, `color`, and `content`, discarding unsaved user edits. That is plausible while thread status/title data updates in the active chat surface.

Recommendation: derive primitive `initialAvatarColor` and `initialAvatarContent` values, then depend on those primitives instead of the normalized object. Add a regression test that edits the dialog draft, rerenders with `{ ...sameAvatar }`, and asserts the draft is preserved.

### 3. Medium: Generated emoji path spends AI before proving the group can use it

`workers/main/src/chat-thread-do.ts:8792-8814`

Every generated thread title with `context.userId` now performs a second auxiliary-AI request for an emoji before calling `renameEmptySingleThreadGroupForThread(...)`. That UserDO call can still no-op after the model spend when the thread is not in a single-thread group or the group avatar is no longer `source = default`. It also delays the persistent group-name write until after the emoji request completes or fails.

Recommendation: update the group name immediately, then either claim/check generated-emoji eligibility in UserDO before spending the emoji call, or fold the emoji into the existing title-generation response. If the eligibility-check shape is chosen, add a mock-based test that ineligible groups do not invoke emoji generation.

This is partly covered by the high-severity finding above, but it is worth preserving as a separate efficiency concern for all non-placeholder cases.

### 4. Low: Lazy backfill claim is not atomic

`src/lib/chat-groups.server.ts:176-183`

The lazy backfill path lists candidates and then marks each attempt in separate UserDO calls. Two concurrent route loads can both list the same default-source group before either one marks it, causing duplicate auxiliary-AI calls for the same group.

Recommendation: replace `listChatGroupsNeedingEmojiBackfill(...)` plus `markChatGroupEmojiBackfillAttempt(...)` with a single `claimChatGroupsNeedingEmojiBackfill(...)` UserDO method that selects and timestamps candidates in one DO turn.

### 5. Low: Existing-group LLM backfill is visible-route only

`src/lib/chat-groups.server.ts:346-393`

Backfill scheduling currently happens from `listGroupsForWorkspace(...)` and `getGroupForWorkspace(...)`. Groups outside those visible/sidebar paths can keep the default `💬` emoji until they are opened or included in that visible set. `listGroupsForMove(...)` returns all groups for menus but does not schedule backfill.

Recommendation: if the product requirement is "all existing groups eventually get a helpful LLM emoji", add a bounded migration/admin job or a broader claim loop. If visible-first lazy backfill is the intended tradeoff, document that behavior in the implementation notes.

### 6. Low: Emoji picker lazy chunk should be checked in a production build

`src/components/ui/emoji-picker.tsx:4-5`

The picker lazy-loads `emojibase-data/en/compact.json` and `messages.json`; those two raw files are about 578 KB locally. Lazy loading keeps the data out of initial render, but it is still worth checking the production chunk size and first-open latency, especially on mobile.

Recommendation: run a production build and inspect the emoji picker chunk. If it is too large, consider a smaller curated set with search, or dynamic category loading.

## UI Review (follow-up, design audit) — 2026-06-19

Two UI items from this iteration. (Prior-round U1–U5 verified fixed in code: the modal footer pins, the custom swatch is a clean circle with a chip behind the `+`, the emoji-panel corners are clipped, the "component" group is filtered out, and the initials field has `useId()` + `maxLength`.) Fixes are spelled out because the implementing agent is strong on logic, weak on UI.

### UI-1. High: The emoji picker shows far too much — reduce to a curated grid + search

The avatar modal currently stacks several emoji surfaces at once:
- a 12-item quick-picks row that prepends the current selection (`src/components/avatar/avatar-editor.tsx:25-38,64-69,140-159`),
- category tabs (`src/components/ui/emoji-picker.tsx:138-155`),
- a sticky-header grid of the **entire** active category — hundreds of emoji (`emoji-picker.tsx:160-185`),
- every emoji in **all skin tones** (`emoji-picker.tsx:72-78` flatMaps `entry.skins`).

There is no literal "recently chosen" section in the code; the thing that reads as one is the quick-picks row surfacing the current pick (`avatar-editor.tsx:64-69`). The redesign removes it. The live preview chip at the top of the modal already shows the current selection, so it does not need to be echoed in the grid.

Target (per product):
- **Default (empty search):** one curated grid of ~24–32 **popular base** emoji, 8 per row (3–4 rows). No category tabs, no category headers, no separate quick-picks row, no skin-tone variants.
- **Search:** filter the full catalog and show matches in the **same** 8-column grid (keep the existing `MAX_SEARCH_RESULTS` cap).
- **No skin-tone explosion:** drop the `skins` flatMap so neither default nor search shows 6× duplicates. Skin-tone emoji stay valid (validation unchanged) — they're just not browsable.

Concrete changes:

`src/components/ui/emoji-picker.tsx`
- Remove the category tab row (138-155), `activeGroupId`, and the sticky category header (163-165); `GROUPS`/`GROUP_LABELS` are no longer needed for rendering.
- Build the searchable set from base entries only — delete the `entry.skins` flatMap (72-78).
- Add a curated `POPULAR_EMOJI` and render one grid for both states:

```tsx
const POPULAR_EMOJI = [
  "💬","😀","😎","🤔","🥳","🔥","✨","⭐",
  "⚡","🎯","🚀","💡","🧠","📊","📈","✅",
  "📝","🐛","🔧","📅","🎉","❤️","💜","🌊",
  "🌿","🐼","🦊","🎨","🎵","☕","🍕","🌙",
].filter(isEmoji) // exact set is tunable — designer's call

const items = search.trim()
  ? ALL_EMOJI.filter((e) => matchesQuery(e, search)).slice(0, MAX_SEARCH_RESULTS)
  : POPULAR_EMOJI.map((emoji) => ({ emoji, label: emoji, key: emoji }))
// one <div className="grid grid-cols-8 gap-1 …">…</div> + the existing "No emoji found." empty state on search
```

`src/components/avatar/avatar-editor.tsx`
- Delete `QUICK_EMOJI_OPTIONS` (25-38), `quickEmoji` (64-69), and the `quickPicks` block (140-159). Render just `<LazyEmojiPicker value={selectedEmoji} search={emojiSearch} onSearchChange={setEmojiSearch} onSelect={onContentChange} />`.
- Drop the now-unused `quickPicks` prop from `EmojiPickerProps`.

Bonus: this also shortens the modal (helps the earlier footer-height fix hold) and shrinks what the lazy emoji chunk renders (relates to finding #6). The `compact.json` import can stay for search; only the default view changes.

### UI-2. Medium: Collapsed rail drops the group color (and emoji) for running/unread

Reported (screenshot). In the collapsed sidebar a group with a status loses its identity: `ChatGroupIcon` renders only a bare `CamelLoader` for `running` (`src/components/sidebar/chat-groups-list.tsx:107-121`) and only a bare amber dot for `unread` (`:122-137`) — no colored chip. Only the idle branch (`:138-153`) shows the `md` color chip, so a completed group reads as just an amber dot on the empty rail.

(Note: `ChatGroupCollapsedIcon` at `:156-165` is exported but unused — the live path is `ChatGroupIcon`, used at `:250`. Fix there; the dead component can be removed or folded in.)

Target: the collapsed chip's **color always renders**; the status overlays it.
- **Unread:** keep the color+emoji chip and render the amber dot as a small corner badge with a ring in the rail's surface color. "Matching the background" in the way that matters = matching the surface *behind* the chip (`ring-sidebar`), creating the standard badge cutout so the dot stays legible on any chip color. (A ring in the chip's own color would blend, so avoid that reading.) This keeps full identity **and** status.
- **Running:** render the color chip as the background and center the spinner over it, with a subtle scrim so the loader reads on any color. No ring on the spinner — fine per product.

```tsx
export function ChatGroupIcon({ group }: { group: ChatGroupView }) {
  const isRunning = group.status === "running"
  const isUnread = group.status === "unread"
  return (
    <>
      {/* EXPANDED: emoji chip; status stays in the right slot (unchanged) */}
      <ChatGroupAvatar
        avatar={group.avatar} fallbackName={group.name} size="sm"
        className="group-data-[collapsible=icon]:hidden"
      />
      {/* COLLAPSED: color chip always renders; status overlays it */}
      <span className="relative hidden size-6 group-data-[collapsible=icon]:block">
        <ChatGroupAvatar avatar={group.avatar} fallbackName={group.name} size="md" />
        {isRunning ? (
          <span className="absolute inset-0 grid place-items-center rounded-[28%] bg-black/35 text-white">
            <CamelLoader size={16} ariaLabel="Agent is working" />
          </span>
        ) : isUnread ? (
          <span
            aria-label="Awaiting your review"
            className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-amber-500 ring-2 ring-sidebar"
          />
        ) : null}
      </span>
    </>
  )
}
```

Match the scrim radius to the chip (`ChatGroupAvatar` renders `rounded-[28%]`). If the collapsed rail sits on a surface other than `--sidebar`, point the dot ring at that surface token instead.

## Confirmed Fixed

- Sidebar disappearance: `_app` now lets the chat-groups promise reject instead of degrading to `[]`, and `ChatGroupsProvider` preserves existing same-workspace groups on refresh failure.
- Repeated default avatar: persisted avatars survive active-group merging, fallback active groups now vary color deterministically, and generated emoji is written for single-thread groups even when they already have a non-empty fallback name.
- Emoji validation: `isEmoji` now accepts ZWJ sequences, skin-tone modifiers, and pride flag style sequences, with tests covering the previously flagged examples.

## Checks Run

- `bun run test:run tests/avatar.test.ts tests/chat-groups-routes.test.ts tests/chat-groups-ui.test.tsx tests/chat-group-avatar-generation.test.ts` - passed, 90 tests.
- `bun run test:workers -- workers/main/tests/user-do-chat-groups.test.ts` - passed, 13 tests. The MCP SDK sourcemap warnings are pre-existing dependency noise.
- `bun run typecheck` - passed.
