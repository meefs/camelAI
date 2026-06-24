# New Chat Screen for an Active Chat Group — Plan

**Date:** 2026-06-22
**Branch:** `illianaa/group-new-chat-tab`
**Surface:** The new-chat page **when opened inside a chat group** — route `src/routes/_app.chat._index.tsx` reached via `/chat?group=<id>` (the tab bar's "New tab" / sidebar "New chat in group"). Renders through `Chat` (`src/components/Chat.tsx`) → `WelcomeScreen` (`src/components/welcome-screen/index.tsx`).
**Roles:** PM/design (me) owns the UI — layout, component choices, copy, interaction. **Codex** (technical architect) owns data sourcing and the transcript-generation endpoint — every backend decision is collected under the **▶ For Codex** callouts and §8. The coding agent implements the UI against our component library (shadcn).

> **Scope reminder for the implementer:** this is a **UI feature on the new-chat screen**. The standard new-chat screen (no group) is untouched. The composer footer is **unchanged** — reuse it as-is (see §6); the only composer work is the behavioral mention/transcript additions.

> **Adjacent feature, read first.** A separate, already-shipped feature — the **chat group _sidebar_ hover popover** (`docs/chat-group-hover-state-*.md`, component `src/components/sidebar/chat-group-hover-card.tsx`) — lists a group's chats by status when you hover the group in the sidebar. That is **not** this feature, but it matters here for two reasons: (1) it already enriched `ChatGroupThreadSummary` with enough per-thread fields to render **transcript card metadata** (id/title/status/snippets), but **not** the condensed transcript itself; the actual transcript preview/upload must be generated on demand from `ChatThreadDO` messages (§8.2); and (2) it owns the name `ChatGroupHoverCard` and hit a Radix `ScrollArea` clipping bug — our transcript preview must use a **different name** and **avoid that pitfall** (§5).

---

## Objective

When a user starts a new chat **from inside a chat group**, give them a screen built for carrying context across the group's other chats. Three stacked blocks, top to bottom:

1. A **group lockup header** — the group's avatar next to "NEW CHAT IN" + the group name in display serif italic.
2. A **"Recently used in this group"** section — projects & connections as **tags**, sibling chats as **transcript cards**, sourced from the group's other chats.
3. The **composer**, with generous space above it.

Clicking a tag drops an `@mention` into the composer and removes the tag from the section. Clicking a transcript card builds a condensed markdown transcript, uploads it like a user file, and attaches it — removing the card from the section. Hovering a transcript card opens a scannable preview of the condensed conversation.

```text
  ┌──────────────────────────────────────────────────────────────────────┐
  │                                                                        │
  │                      ┌────┐   NEW CHAT IN                              │   ① Group lockup (centered)
  │                      │ 🧠 │   LLM Model Refresh   ← serif italic       │
  │                      └────┘                                            │
  │                                                                        │
  │  ↳ RECENTLY USED IN THIS GROUP                                         │   ② Recently used
  │                                                                        │
  │  ┌────────────────┐ ┌───────────────────┐                             │   tags (pills): projects + connections
  │  │ ⌁ Admin API MCP│ │  GitHub · camelai  │                             │   (icon + name, no add glyph)
  │  └────────────────┘ └───────────────────┘                             │
  │                                                                        │
  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐                  │   transcript cards
  │  │ CHAT   ▢ │ │ CHAT   ▢ │ │ CHAT   ▢ │ │ CHAT   ▢ │                  │   (badge · name · opening line · corner icon)
  │  │ Plan LLM │ │ Implement│ │ Review   │ │ Create PR│                  │
  │  │ Plan the…│ │ Implement│ │ Review t…│ │ Open a d…│                  │
  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘                  │
  │                                                                        │
  │                            (generous gap)                             │
  │  ┌──────────────────────────────────────────────────────────────┐    │   ③ Composer
  │  │  @Admin API MCP  @HN ClickHouse                                │    │   (mention chips render in-input)
  │  │  Draft the PR▏                                                 │    │
  │  │  +   Opus 4.8 ⌄                                      🎙   (↑)  │    │
  │  └──────────────────────────────────────────────────────────────┘    │
  └──────────────────────────────────────────────────────────────────────┘
```

---

## Design principles (from the spec)

- **Neutral palette, no accent.** Emphasis comes from contrast (high-contrast primary text, muted secondary, fainter tertiary), not hue. Two existing exceptions keep their color: the **group avatar** (its own generated background) and the **status dots** (out of scope here). Use only theme tokens (`foreground` / `muted-foreground` / `border` / `card` / `accent` / `muted`) — never a hard-coded color.
- **Two object kinds, two shapes, never merged.** A project or connection is a **tag (pill)**. A transcript is a **card**. They must never collapse into the same shape, even when the section is sparse.
- **Derived membership.** An item lives in "Recently used" until it's been added to the composer, then it leaves; remove it from the composer and it returns. When nothing is left to add, the section is empty (and hidden).
- **Only transcript card metadata is cheap.** Group summaries already carry enough to render the card shell (thread id, title, status, last activity, completion summary), but they do **not** contain the conversation transcript. Add `first_user_message` to group summary hydration for the card's `openingLine` (§8.1). Generate the full condensed transcript only from `ChatThreadDO` messages on hover / click (§5, §8.2).
- **Light + dark.** Everything must read in both themes (the screenshots show dark).

---

## 1. Where it slots in (architecture & wiring)

The active group is **already resolved** in the route component but is **not yet passed into the welcome screen** as an object. Today the route passes only `chatGroupId` + a `welcomeData` blob to `Chat`; `Chat` resolves `welcomeData` and destructures it into `WelcomeScreen`.

Verified against current `main`:

- `src/routes/_app.chat._index.tsx:936-939` — `liveActiveChatGroup` is resolved. It is a `ChatGroupView` carrying `id`, `name`, `avatar`, `member_count`, and **`open_threads[]` / `closed_threads[]`** (each a `ChatGroupThreadSummary` — see §8.1).
- `src/routes/_app.chat._index.tsx:1051-1076` — `<Chat … chatGroupId={liveActiveChatGroup?.id} welcomeData={{ userId, userName, allApps, connections, projects, recentThreads, renderedAt }} />`. **Only `chatGroupId` is passed today; the group object is not.**
- `src/components/Chat.tsx:1623-1631` — `resolvedWelcomeData` (welcomeData with a fallback), destructured into `WelcomeScreen` around `Chat.tsx:4160-4182`.
- `src/components/welcome-screen/index.tsx:196-218` — `WelcomeScreenProps`. **No `group` prop exists today** (safe to add).

**Plan:** thread a `group` payload from the `_app.chat._index.tsx` route component through `welcomeData` into `WelcomeScreen`. This payload can be built from `liveActiveChatGroup` so it tracks `useChatGroups()` updates after the initial deferred loader value resolves. When present, `WelcomeScreen` renders the **group variant** (lockup + Recently used + composer) and skips the standard sections (greeting, recent chats, apps, connected-tools, starter prompts, integration buttons). When absent, nothing changes.

```text
  _app.chat._index.tsx  (liveActiveChatGroup already resolved @ 936-939)
        │  add to welcomeData:  group = { id, name, avatar, threads, recentlyUsed }
        ▼
  Chat.tsx  ── resolvedWelcomeData ──►  WelcomeScreen
                                           │
                                           ├─ group present  → GroupNewChat layout (this plan)
                                           └─ group absent   → existing standard layout (unchanged)
```

**Component shape:** add an optional `group` prop to `WelcomeScreen`; when set, render two new subcomponents above the existing `PromptInput` block and omit the standard sections:

- `src/components/welcome-screen/group-new-chat-header.tsx` — the lockup (§3).
- `src/components/welcome-screen/recently-used-in-group.tsx` — the section: tags + transcript cards (§4).
- Reuse the existing `PromptInput` block (`index.tsx:483-506`) **verbatim** for the composer — no footer/chrome changes. The `mentionables` it receives (`mentionEntities`, built at `index.tsx:408-411`) must remain the full workspace mentionable set, not only the group subset; group tags are shortcuts into that existing mention system.
- Add one `Chat`-owned transcript attachment handler and pass it down to `WelcomeScreen` / `RecentlyUsedInGroup`. `Chat.tsx` owns `workspaceId`, `attachments`, `attachmentsRef`, draft persistence, and the existing upload progress/error state. Do **not** duplicate attachment state inside `WelcomeScreen`.

Keeping the composer as the same `PromptInput` call means mentions, attachments, model picker, voice, and send keep working with minimal wiring. The new composer-side logic is **append-a-mention on tag click** (§4a), the **Chat-owned generated transcript attach flow** (§5), and preserving transcript metadata in draft serialization (§5a).

---

## 2. Layout & spacing

A single centered column, consistent with the standard welcome screen's container.

- Outer: reuse `WelcomeScreen`'s container; for the group variant constrain content to `max-w-3xl mx-auto` so the lockup and cards feel centered (matches the screenshot's narrower stack).
- Vertical rhythm: lockup → recently-used uses normal section spacing (`space-y-8`); **recently-used → composer gets a deliberately larger gap** (`mt-10` / `pt-10` on the composer block) so the section does not crowd the input (spec §"Layout").
- Order is **header, then recently-used, then composer** — different from the standard screen, where the composer sits directly under the greeting. Here the composer is last.

---

## 3. Group lockup header

A horizontal lockup, centered as a unit: the group avatar to the **left** of a two-line text block.

```text
        ┌──────┐   NEW CHAT IN                ← eyebrow: xs, uppercase, tracked, muted
        │  🧠  │   LLM Model Refresh          ← group name: display serif, italic
        └──────┘
        avatar (lg / 40px)   left-aligned text block; whole lockup centered
```

**Build it from what exists:**

- **Avatar** — reuse `ChatGroupAvatar` (`src/components/avatar/chat-group-avatar.tsx`). Props confirmed: `avatar`, `fallbackName`, `size` (`"sm" | "md" | "lg" | "xl"`), `className`. Use `size="lg"` (= `size-10` / 40px, `src/components/ui/avatar.tsx`), matching the prototype's ~40px chip. Pass `avatar={group.avatar}` and `fallbackName={group.name}`. The component already handles emoji, the generated background color, the contrast text, the letter fallback, and the rounded-square shape, and passes `aria-hidden` through (leave it hidden — the name is announced by the heading below).
- **Eyebrow "NEW CHAT IN"** — `<p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">`.
- **Group name** — match the existing display heading on this screen (`WelcomeGreeting`, `welcome-greeting.tsx:49` uses `font-serif italic` at `text-3xl md:text-4xl`). Use a slightly smaller size for the compact lockup:
  `<h1 className="text-2xl md:text-3xl font-serif italic text-foreground leading-tight">{group.name}</h1>`.

```tsx
// group-new-chat-header.tsx (essence)
<div className="flex items-center justify-center gap-3">
  <ChatGroupAvatar avatar={group.avatar} fallbackName={group.name} size="lg" />
  <div className="text-left">
    <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
      New chat in
    </p>
    <h1 className="text-2xl md:text-3xl font-serif italic text-foreground leading-tight">
      {group.name}
    </h1>
  </div>
</div>
```

_(Design note: use `font-serif` because it is the established treatment for this screen's display heading and matches the existing welcome greeting.)_

---

## 4. Recently used in this group

One section under a short eyebrow with a leading arrow glyph. Below the eyebrow: **tags first** (projects + connections), **then transcript cards**.

```text
  ↳ RECENTLY USED IN THIS GROUP          ← CornerDownRight icon + xs uppercase tracked muted
```

**Eyebrow** — not the existing `SectionHeader` (that's a `text-sm font-semibold` title + link row). This is a micro-eyebrow:

```tsx
<div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
  <CornerDownRight className="size-3.5" aria-hidden />
  <span>Recently used in this group</span>
</div>
```

The whole section hides when there's nothing left to add (no tags and no transcripts remaining after derivation, §4c).

### 4a. Tags — projects & connections

Roomy pills with the item's icon + name, **no add glyph** — visually identical to the standard new-chat connection tags.

- Reuse the pill styling from `ConnectedTools` (`src/components/welcome-screen/connected-tools.tsx:22-27`), verified verbatim:
  `inline-flex items-center gap-2 px-4 py-2.5 rounded-lg cursor-pointer border border-border bg-card hover:bg-accent/50 transition-all duration-200 ease-out text-sm hover:border-ring hover:shadow-md`.
- **Icon per kind:**
  - Connection → `IntegrationIcon` with `resolveLogoType(type, [name])`, `size={16}` (exactly as `ConnectedTools`; both exist in `src/lib/integration-icons.tsx`).
  - Project → `FolderGit2` from lucide, `className="size-4 shrink-0 text-muted-foreground"` (matches the project icon used in the @-mention overlay).
- Render them interleaved in one wrapping flex row (`flex flex-wrap gap-3`), connections and projects together — they share the pill shape and are differentiated by icon (consistent with the at-mention menu's one-list-by-icon convention).

> Implementation: create a small `RecentlyUsedTag` component that takes `{ kind: 'connection' | 'project', … }`, picks the correct icon, and uses the single pill style above for both item kinds.

**On click → insert an `@mention` (append, don't replace).** The standard screen's `handleConnectionSelect` (`index.tsx:462-470`) **replaces** the whole input with `@${slug} ` (`onPromptChange(\`@${slug} \`)` at line 468). In the group variant we **append**, because the user may add several tags plus typed text:

```tsx
const handleTagSelect = (item: AtMentionEntity) => {
  const slug = slugForMentionable(item, connectionSlugMap); // existing helper, src/lib/mentions.ts
  if (!slug) return;
  const prev = inputValue;
  const sep = prev && !prev.endsWith(' ') ? ' ' : '';
  onPromptChange(`${prev}${sep}@${slug} `);
  focusInput();
};
```

The mention chip renders automatically: `WelcomeScreen` already builds `mentionEntities` from all connections + projects (`index.tsx:408-411`) and passes it as `mentionables` to `PromptInput` (`index.tsx:503`), so the overlay recognizes `@slug` and draws the chip. **No new chip code.**

**The tag then leaves the section** — see §4c (derived membership).

### 4b. Transcript cards

A transcript is a **card** (never a pill): a small card with a type badge, the source chat's name, the opening line, and a quiet conversation icon in the corner that becomes an add affordance on hover.

```text
  ┌─────────────────────────┐        ┌─────────────────────────┐
  │ ╭──────╮             ▢   │        │ ╭──────╮             ＋  │  ← hover: corner icon → Plus
  │ │ CHAT │                 │        │ │ CHAT │                 │
  │ ╰──────╯                 │        │ ╰──────╯                 │
  │ Plan LLM Updates         │  ───►  │ Plan LLM Updates         │
  │ Plan the model ID refr…  │ hover  │ Plan the model ID refr…  │
  └─────────────────────────┘        └─────────────────────────┘
   idle: MessageSquare icon            hover: lifts (border-ring + shadow), icon = Plus
```

Base it on `RecentChatCard` (`src/components/welcome-screen/recent-chat-card.tsx:25-55`) — same card chrome, plus a badge and a corner icon:

```tsx
// transcript-card.tsx (essence)
<button
  type="button"
  onClick={() => onInsertTranscript(t)}
  className={cn(
    'group relative flex flex-col gap-2 p-4 rounded-xl cursor-pointer text-left',
    'border border-border bg-card transition-all duration-200 ease-out',
    'hover:border-ring hover:shadow-md',
    'w-[200px] shrink-0',
  )}
>
  <div className="flex items-start justify-between">
    <Badge variant="outline" className="uppercase">Chat</Badge>
    {/* quiet conversation glyph that becomes an add affordance on hover */}
    <span className="text-muted-foreground">
      <MessageSquare className="size-4 group-hover:hidden" aria-hidden />
      <Plus className="size-4 hidden group-hover:block" aria-hidden />
    </span>
  </div>
  <p className="text-sm font-medium text-foreground truncate min-w-0">{t.title}</p>
  <p className="text-xs text-muted-foreground line-clamp-1 leading-relaxed">{t.openingLine}</p>
</button>
```

- **Badge** — shadcn `Badge` (`src/components/ui/badge.tsx`), `variant="outline"`, `className="uppercase"`. Reads "Chat". (The badge base is already the small uppercase type-label look.)
- **Corner icon** — `MessageSquare` (lucide) muted by default; swap to `Plus` on `group-hover`. Keep `aria-hidden`; the card's accessible name carries meaning (§7).
- **Title** — `text-sm font-medium text-foreground truncate` (matches `RecentChatCard:40`).
- **Opening line** — `text-xs text-muted-foreground line-clamp-1` (the prototype shows a single truncated line on the card; the full conversation lives in the hover preview). Use `w-[200px] shrink-0` so several cards fit in the row while retaining `RecentChatCard`'s chrome.
- Lay the cards out in a wrapping row: `flex flex-wrap gap-3`.

**Card metadata is cheap; transcript content is not.** Each card needs `{ threadId, title, openingLine, status, lastActiveAt, lastAssistantCompletedAt }`. These come from the group's loaded `ChatGroupThreadSummary[]` (`liveActiveChatGroup.open_threads`, `src/types.ts:62-81`) after adding `first_user_message` for the exact opening line (§8.1). The card metadata must **never** be treated as the source for the hover preview or uploaded markdown: the condensed transcript requires every user message, every final assistant reply, and the count of omitted tool/intermediate work, so it must be generated from the underlying thread messages (§8.2).

**On click → insert the transcript as an attachment** (§5). **On hover → open the preview** (§5). The card then leaves the section (§4c).

### 4c. Derived membership (items leave / return)

Don't mutate a list. Derive what the section shows from current composer state, so add/remove is automatic and reversible (spec §"Recently used"):

- **Tags shown** = group's used projects/connections **minus** those whose slug currently appears in the input. Detect with `parseMentions(inputValue, connectionSlugMap)` (`src/lib/mentions.ts:345`), which returns `MentionMatch[]` (`{ slug, target, index, length }`); hide any tag whose resolved `target` matches a parsed mention (filter `target !== null`). Delete the mention text → the tag reappears.
- **Transcript cards shown** = group's sibling transcripts **minus** those whose `threadId` is currently an attachment. Tag transcript attachments with their `sourceThreadId` (§5) and exclude matches. Remove the tile → the card reappears.
- Preserve that transcript metadata through draft persistence. Today `serializeAttachments` stores only generic file fields (`id`, `name`, `path`, `size`, `contentType`, `originalName`, `status`); if `kind/sourceThreadId/sourceTitle/snippet` are not added to the serialized attachment shape, a saved draft or failed-send restore will make the transcript look like a plain `.md` file and the source card can incorrectly reappear after reload.
- When both derived lists are empty, render nothing (hide the eyebrow too).

---

## 5. Inserted transcript (attachment tile) + hover preview

### 5a. The attachment tile

Settled, and intentionally close to today's attachment behavior. An inserted transcript appears in the composer **above the input**, alongside any other attachments, as a **compact tile** carrying a type badge, the chat name, and a short snippet — and it's removable.

**The tile is a real uploaded file.** Clicking a card runs the existing upload pipeline so the transcript sends with the message exactly like any user upload (this is the user's stated approach: "generate a markdown file and upload that to R2 … like a user uploaded a file but we generate it ourselves"). Implement this as a `Chat.tsx` helper that accepts a generated `File` plus transcript metadata; do not call the current `onFilesSelected([file])` path directly unless it is extended to carry metadata, because the existing handler creates only generic file attachments.

```text
  click card
     │
     ├─ ensure condensed turns for threadId   (reuse hover cache; fetch if cold — §8.2)
     ├─ serialize turns → markdown string      (client-side)
     ├─ file = new File([md], "<chat-name>-transcript.md", { type: "text/markdown" })
     ├─ Chat.addGeneratedAttachment(file, metadata) adds optimistic attachment
     │    (status:'uploading', kind:'transcript', sourceThreadId, sourceTitle, snippet)
     ├─ Chat helper calls uploadWorkspaceFile(workspaceId, file, { onProgress })   ← src/lib/workspace-upload.client.ts:119
     └─ on done → status:'complete', path = result.path          (path lands under `uploads/…`)
  on send → appendUserUploadReferences(text, [path]) emits "(user uploaded file to <path>)"   ← src/lib/chat-attachment-refs.ts:20
```

- `uploadWorkspaceFile(workspaceId, file, opts)` accepts a client-generated `File` directly and returns `{ path, filename, originalName, size, contentType }`. **`.md` is allow-listed by extension** (`SAFE_FILE_EXTENSIONS`, `workers/main/src/file-safety.ts:34`) — no upload or safety changes needed. (Uploads must resolve under the `uploads/` mount; the helper enforces this.)
- The upload route itself requires write access (`routes/api/workspaces.$id.upload.ts` uses `requireWorkspaceAccess(..., { requireWrite: true })`). Hover transcript reads should remain read-access; inserting a transcript naturally fails/should be disabled where the composer cannot write.
- `uploadWorkspaceFile` rejects empty files. If the condensed transcript endpoint returns zero completed turns, do not create/upload an empty markdown file; disable the card or show an inline error state.
- The attachment row already renders above the input, separated by a divider that lives in **`prompt-input.tsx`** (`InputGroupAddon align="block-start" className="border-b border-border"`) — not in `attachment-list.tsx`. No divider work needed.

**Tile rendering.** Today `AttachmentList` (`src/components/attachment-list.tsx`) renders completed **images** as inline thumbnails (lines 37-56) and everything else via `FileCard` (lines 61-71, an 88×88 square: extension badge + icon + filename + progress/error + hover-`X`). Neither shows a chat name + snippet. Add a **transcript variant**:

- Extend the `Attachment` type (`src/components/attachment-list.tsx:8-20`; current fields: `id, name, path, size, contentType?, originalName?, progress?, status, error?, previewUrl?`) with optional **UI-only** fields — no backend type changes:
  `kind?: 'transcript'`, `sourceThreadId?: string`, `sourceTitle?: string`, `snippet?: string`.
- In `AttachmentList`, when `attachment.kind === 'transcript'`, render a transcript tile instead of `FileCard`: a "CHAT" `Badge`, the chat name (`sourceTitle`, `truncate`), and a 1–2 line snippet (`line-clamp-2`), with the same hover-`X` remove control `FileCard` uses (`-right-1 -top-1`). Keep the upload progress/error states `FileCard` provides (reuse its progress-bar pattern).
- Update `src/hooks/use-draft-persistence.ts` so `SerializedAttachment` preserves transcript metadata and parses it back. Include those fields in `areDraftAttachmentsEqual` and draft comparison paths. This keeps membership derivation and the special tile stable after reload, failed-send restore, and delivery-draft recovery.
- **Remove** → existing `onAttachmentRemove(id)` (`prompt-input.tsx`). Because membership is derived (§4c), removing the tile returns the card to the section automatically.

> Per the spec: the file-type tag in the tile's top-left reads **"chat"** (not "md"/"txt"). Keep the tile compact and consistent with other attachment tiles in the same wrapping row; a transcript tile may be a touch wider than the 88px square to fit the chat name + snippet — acceptable, and matches the spec's "compact … tile."

### 5b. Transcript hover preview

Goal: let the user scan the transcript before inserting — nothing more. No title, no explanation, no footer, no actions.

Use Radix **`HoverCard`** (`src/components/ui/hover-card.tsx` — exports `HoverCard` / `HoverCardTrigger` / `HoverCardContent`, portals via `HoverCardPrimitive.Portal`, defaults `align="center" sideOffset={4}`). Wrap the transcript card button with `HoverCardTrigger asChild` so there is no nested interactive element. It portals (so it is **not clipped** by the section/panel) and auto-handles collision/flip. The wrapper sets no open/close delay, so pass `openDelay={200} closeDelay={100}` (matching our other composer hover previews). HoverCard keeps the preview open while the cursor is over **the card or the preview** and closes shortly after leaving both — exactly the spec's behavior, for free.

> **Name it `TranscriptHoverPreview`.** Do **not** call it `ChatGroupHoverCard` — that name belongs to the sidebar popover (`src/components/sidebar/chat-group-hover-card.tsx`), a different feature.

> **Avoid the known ScrollArea clipping bug.** The sidebar hover-card feature hit a Radix `ScrollArea` issue where the internal Viewport renders `display: table`, growing to its widest child so `truncate`/`line-clamp` never trim and text clips without ellipsis (`docs/chat-group-hover-state-feedback-r2.md`). For this preview, scroll the content with a **plain `max-h-[360px] overflow-y-auto` container** (not Radix `ScrollArea`). If `ScrollArea` is used anyway, apply the documented override forcing the inner wrapper back to `display: block`.

```text
  ┌─ TranscriptHoverPreview (portal; side="bottom" align="start"; flips up when no room) ─┐
  │  USER                                                            ← role label        │
  │  Plan the model ID refresh across the app.                                           │
  │ ───────────────────────────────────────────────  (assistant band starts here)       │
  │  ASSISTANT                                                                           │
  │  [312 messages omitted]                                          ← bracketed italic, │
  │                                                                    under the header   │
  │  Rollout plan                                                                        │
  │  Update the model IDs in three passes.                          ← markdown           │
  │    • Swap the chat model strings in `config/models.ts`.           (rendered)         │
  │    • Update provider defaults for `anthropic` and `openai`.                          │
  │  …                                                               ← scrolls            │
  └───────────────────────────────────────────────────────────────────────────────────┘
```

Spec-driven rules:

- **Positioning** — `side="bottom"`, `align="start"`, with `collisionPadding`. Radix flips to top automatically "when there is not enough room below the card." Fixed width ~`w-80` (≈320px), `max-h-[360px] overflow-y-auto`. The content is hoverable (Radix), so the user can move into it to scroll.
- **Roles by background, not text color** — the spec is explicit: the assistant reply renders markdown (which brings its own colors), so we must not lean on font color to separate roles.
  - User turn sits on the normal popover background.
  - Assistant turn sits on a **slightly lighter, full-width band** (e.g. `-mx-3 px-3 bg-muted/50`) so the assistant text keeps the same width as the user text.
  - Role labels: `text-[0.625rem] font-medium uppercase tracking-wider text-muted-foreground`, reading **"User"** and **"Assistant"** (use "User," never "you" — a transcript can come from a teammate in the same workspace).
- **Assistant markdown** — render with the existing `MarkdownRenderer` (`src/components/markdown-renderer.tsx`, `variant="default"`). It already styles headings, lists, inline code, and bold.
- **Omitted-work note** — placed **inside the assistant band, directly under the "Assistant" label and above the final reply** (not between the two roles). It marks the omitted intermediate work — the tool calls and intermediary turns between the user's request and the agent's final answer — as **quiet bracketed italic text** (`text-xs italic text-muted-foreground`), e.g. `[312 messages omitted]`. The placement is deliberate: the omission belongs to the assistant's process, so it should read as "the assistant did hidden work, then replied," not as a gap between user and assistant. Not a divider. The count comes from the condensed-turns payload (§8.2). _(This refines the original spec's "between each user prompt and the assistant's reply" wording.)_
- **Content only** — no header/footer/buttons. Full message length, scrollable.
- **Loading state** — first hover fetches the condensed turns (§8.2); show a small inline skeleton/spinner until they arrive, then render. Cache per `threadId` and reuse on click (§5a).

---

## 6. Composer changes (behavioral only — footer is unchanged)

**There are no composer footer or chrome changes in this feature.** The placeholder, attach button, model picker, send button, voice button, divider, attachment row, and mention menu all stay exactly as they are today. Reuse the existing `PromptInput` block (§1) **verbatim** and do not refactor it — continue with the existing composer logic and behavior.

The only composer-side work is **behavioral**:

1. **Append-mention on tag click** (§4a) — new `handleTagSelect` (append `@slug `, don't replace).
2. **Transcript attach flow** (§5a) — build → upload → attach with transcript metadata.
3. **Transcript tile variant** in `AttachmentList` (§5a).

---

## 7. Accessibility

- **Lockup** — the group name is a real heading (`<h1>`); the avatar stays `aria-hidden` (its default in `ChatGroupAvatar`) so the group isn't announced twice.
- **Tags** — real `<button>`s with an accessible name (`Add <name> to chat`, or the visible label). Icons `aria-hidden`.
- **Transcript card** — a `<button>` whose accessible name describes the action, e.g. `aria-label="Add transcript: Plan LLM Updates"`. The corner `MessageSquare`/`Plus` icons are `aria-hidden` (decorative; the button name carries meaning).
- **Hover preview** — HoverCard is pointer-oriented; the same insert is reachable by activating the card button, so no keyboard-only user is blocked from inserting. Role labels are real text ("User"/"Assistant"), so roles are conveyed without relying on the band color. The omitted-work note is literal text, not color-encoded.
- **Reduced motion** — card hover and preview open use existing token-driven transitions; respect `motion-reduce` as the avatar already does.

---

## 8. ▶ For Codex — data sourcing & transcript generation (backend)

The UI above needs (a) a small `group` payload threaded onto the new-chat-in-group route, and (b) one on-demand transcript fetch. The important boundary: the group payload renders **card metadata and tags**, while the transcript endpoint renders **conversation content**. Do not try to build the preview/upload transcript from `ChatGroupThreadSummary`.

### 8.1 The "recently used" payload (route component + loader data)

Add a `group` payload to the `welcomeData` passed into `<Chat>` (`src/routes/_app.chat._index.tsx:1051-1076`). Build its card metadata from `liveActiveChatGroup` (already resolved at line 936), and build its recently-used tag ids from the active group returned by the loader's deferred `interactive` bundle. Shape the UI expects:

```ts
type GroupNewChatPayload = {
  id: string;
  name: string;
  avatar: AvatarShape | null;
  // Card metadata only. Full transcript turns are fetched on demand (§8.2).
  transcriptCards: Array<{
    threadId: string;
    title: string;
    openingLine: string;
    status: ThreadStatus;
    lastActiveAt: number;
    lastAssistantCompletedAt: number;
  }>;
  // Resolve ids against existing welcomeData connections/projects.
  recentlyUsed: {
    projectIds: string[];
    connectionIds: string[];
  };
};
```

Keep ids in the payload rather than duplicating full `MentionableProject[]` / `Integration[]` records. `WelcomeScreen` already resolves the full workspace `connections` / `projects` promises for the mention menu; tags map ids back to those live objects and silently drop ids that no longer exist.

**`transcriptCards` is metadata only.** The adjacent sidebar-hover feature enriched `ChatGroupThreadSummary` (`src/types.ts:62-81`), and `liveActiveChatGroup.open_threads` / `closed_threads` are already hydrated `ChatGroupThreadSummary[]` (`src/lib/chat-groups.server.ts`, `toThreadSummary` ~lines 168-226). Those summaries are enough to render cards after one required hydration addition, but they are **not** enough to render the transcript preview or uploaded markdown.

Implementation contract:

- Use **`open_threads` only** for v1. Do not include `closed_threads`.
- Add `first_user_message: string | null` to `ChatGroupThreadSummary` and use it for `openingLine`. Populate it with `truncateThreadPreviewText(thread.first_user_message, 500)` in both summary builders. Defensively fall back to `latest_user_message ?? last_assistant_summary ?? title` only when old live data arrives without the field.
- Update every summary constructor/merger, not just the type: `src/types.ts`, `src/lib/chat-groups.server.ts` (`threadToGroupThreadSummary` and `hydrateChatGroups`), the optimistic helpers in `_app.chat.$id.tsx`, `src/hooks/use-chat-groups.tsx` merge/equality logic, and the chat-group UI/server tests.
- Filter out empty/never-sent threads and threads with no completed assistant turn (`last_assistant_completed_at === null`). A currently running sibling stays eligible only when it has a previous completed assistant turn; §8.2 skips any dangling in-progress tail.
- Do **not** exclude channel-originated threads solely because of `channel_kind` / `channel_kinds`; the preview labels the source side as "User" because the source may be a teammate or channel user.
- Order newest-first by `last_active_at`, cap at **8** cards, and keep the cap as a named local constant.

**`projects` / `connections` is not available from the summaries.** There is no per-thread index of which projects/connections a chat used — mentions are parsed from message text (`parseMentions`, `src/lib/mentions.ts:345`) and stable ids may exist only inside stored `⟦ref: ... id=...⟧` annotations. Implement a bounded server-side scan for v1:

- In the loader's deferred `interactive` bundle, after `activeChatGroup` resolves, take the same capped `open_threads` candidate ids used for `transcriptCards`.
- Load each candidate's messages with `getPiCoreMessages(context, threadId)` in parallel and catch failures per thread so one cold/failing DO does not blank the screen.
- Inspect user-authored messages only. First call `stripMentionAnnotationsWithMetadata` (`src/lib/mentions.ts`) and use annotation ids that match current workspace connections/projects. Then fall back to `parseMentions` with the current `buildSlugMap([...connections, ...projects])` so unannotated current slugs still count.
- De-dupe ids across threads, preserve recency order by the candidate thread order, and return `{ projectIds, connectionIds }`.
- Do not precompute/store mentioned ids for v1, and do not use cheap summary-only mining as the primary implementation. This feature needs mid-chat mentions and renamed targets to work correctly enough for handoff.

### 8.2 Condensed transcript (on-demand, powers preview + insert)

Both the hover preview and the click-to-attach need the **same** condensed turns for one sibling thread. Implement a single route returning structured turns; the client renders the preview from them and serializes those same turns to markdown for the upload.

```ts
// GET /api/threads/:id/condensed-transcript?groupId=<groupId>  →
type CondensedTranscript = {
  threadId: string;
  title: string;
  turns: Array<{
    user: string;            // the user's message text for the turn
    assistantFinal: string;  // assistant's FINAL reply only, as markdown
    omittedCount: number;    // suppressed tool calls/results + intermediate assistant work
  }>;
};
```

Building blocks that already exist (verified — please reuse):

- **Read a sibling thread's messages** — `ChatThreadDO.getPiCoreParsedMessages(threadId)` (`workers/main/src/chat-thread-do.ts:5127`), or the server wrapper `getPiCoreMessages(context, threadId)` (`src/lib/chat-do.server.ts:695`). Messages live only in each thread's DO (`pi_core_messages` table); there is no bulk store. The helper returns canonical persisted history, not the live streaming overlay.
- **Normalize visible text before serializing** — user messages may include attribution (`[web message from ...]:`), file-safety system blocks, and mention annotations. Use `normalizeThreadUserMessageText`-equivalent logic for the user side, and a pure/shared equivalent of `userFacingContentToString` for assistant final output. Do not dump raw `content` fields into the transcript.
- **Extract the final assistant reply per turn** — mirror the turn grouping semantics used by `ChatMessagesView`: a direct user message, followed by the consecutive assistant messages until the next user message. For that assistant run, call `buildFinalOutputMessageView(assistantMessages, actionMessage.id)` (`src/lib/turn-utils.ts:210`) to get only the final text/error blocks after the last tool/thinking boundary. `omittedCount` should be based on suppressed assistant work, e.g. `countTurnSteps(assistantMessages)`, not simply raw row count. **No existing helper pairs user↔final-assistant per turn — this flattening is new** (small), and it is worth putting behind a tested helper instead of burying it in the route.
- **Handle incomplete/compacted history deliberately** — skip dangling user turns with no final assistant output. If persisted history starts with a compaction summary, treat it as internal/meta context, not a user turn. If there are zero completed turns, return an empty `turns` array and let the client avoid upload.
- **Prior art** — the admin JSONL export (`src/routes/api/admin.threads.$id.jsonl.ts`) shows the read-and-emit pattern (it calls `getPiCoreMessages`), but it is full/uncondensed and **superuser-gated** — use it for shape reference only, not its auth model (see below).
- **No condensed-transcript endpoint exists yet** — this is new. Add `src/routes/api/threads.$id.condensed-transcript.ts` and a matching `src/routes.ts` entry.

Implementation contract:

- Generate in the React Router worker route, not in a new DO RPC. The route performs one DO read through `getPiCoreMessages`, then flattens the returned persisted messages into turns.
- Return structured `turns` only. Do not return pre-rendered markdown as the primary API shape; the preview needs structured role bands, and the upload markdown is produced from the same client-side serializer used by the click flow.
- Fetch lazily on first hover, cache per `threadId` on the client, and reuse the cached payload on click. Do not prefetch all sibling transcripts on screen load.
- Require `groupId` in the query string. Validate normal workspace access with `requireSessionWorkspaceAccess(request, context, workspaceId)`, confirm thread ownership with `getThread(context, threadId, workspaceId, { orgId })`, and confirm the thread is currently a member of that group via `getGroupForWorkspace`. Use 403/404 behavior consistent with nearby thread APIs; never use the admin `requireSuperuser` path.
- Mirror `ChatMessagesView` turn semantics: start a turn on each user message, collect consecutive assistant messages until the next user message, and call `buildFinalOutputMessageView(assistantMessages, actionMessage.id)` to extract only the final assistant reply.
- Compute `omittedCount` from suppressed intermediate assistant work via `countTurnSteps(assistantMessages)`. This count represents omitted tool calls/results, visible thinking/trace text, task/teammate notifications, and other assistant work items between the user's request and the final reply; it is not a raw persisted-row count.
- Normalize before emitting: use a server-safe `normalizeThreadUserMessageText` equivalent for user text and a pure/shared equivalent of `userFacingContentToString` for assistant final output. Strip attribution tags, file-safety/system blocks, and mention annotations from visible transcript text.
- Skip dangling user turns with no final assistant output. Treat compaction summaries/internal meta messages as context, not user turns. Return `turns: []` for zero completed turns and let the client disable upload / show an inline error state.
- Keep observability diagnostic only: ids, counts, durations, status, and error metadata; never transcript contents, request bodies, auth headers, or uploaded markdown.
- If on-demand generation later proves too slow, the follow-up design is to precompute/store the condensed form on turn completion. That is explicitly out of scope for v1.

### 8.3 Touch points (frontend wiring you'll coordinate with the coding agent)

`src/routes/_app.chat._index.tsx` (add `activeGroupRecentlyUsed` to the deferred `interactive` bundle, then add `group` to `welcomeData` using §8.1), `src/components/Chat.tsx` (carry `welcomeData.group` through `resolvedWelcomeData` into `WelcomeScreen`, and add the generated transcript upload helper), `src/components/welcome-screen/index.tsx` (add optional `group` prop; branch on it), new `src/routes/api/threads.$id.condensed-transcript.ts` **and a matching `src/routes.ts` route entry**, plus reuse of `src/lib/workspace-upload.client.ts` and `src/lib/chat-attachment-refs.ts` for the upload/send.

Because `first_user_message` is required on group summaries, include `src/types.ts`, `src/lib/chat-groups.server.ts`, `src/hooks/use-chat-groups.tsx`, and the route-specific active-group summary builders/tests. Because transcript metadata is required to keep derived card membership stable, include `src/hooks/use-draft-persistence.ts` and the draft equality path in `Chat.tsx`.

---

## 9. Component & helper inventory (reuse map)

| Need | Reuse | File (verified) |
|---|---|---|
| Group avatar chip (lg / 40px) | `ChatGroupAvatar` (`size="lg"`) | `src/components/avatar/chat-group-avatar.tsx` |
| Display serif italic heading | `font-serif italic` (greeting treatment) | `src/components/welcome-screen/welcome-greeting.tsx:49` |
| Tag/pill style | `ConnectedTools` classes | `src/components/welcome-screen/connected-tools.tsx:22-27` |
| Connection icon | `IntegrationIcon` + `resolveLogoType` | `src/lib/integration-icons.tsx` |
| Project icon | `FolderGit2` (lucide) | — |
| Card chrome (base) | `RecentChatCard` (`w-[260px]`; tighten for transcripts) | `src/components/welcome-screen/recent-chat-card.tsx:25-55` |
| Type badge ("CHAT") | `Badge variant="outline" className="uppercase"` | `src/components/ui/badge.tsx` |
| Corner / hover icons | `MessageSquare` → `Plus` (lucide, `group-hover`) | — |
| Hover preview | `HoverCard` (portal, flip), `openDelay={200} closeDelay={100}` | `src/components/ui/hover-card.tsx` |
| Assistant markdown | `MarkdownRenderer` `variant="default"` | `src/components/markdown-renderer.tsx` |
| Insert mention (append) | `slugForMentionable`, append to `inputValue` | `src/lib/mentions.ts`; pattern at `welcome-screen/index.tsx:462-470` |
| Detect mentions in input (derive tags) | `parseMentions` (returns `MentionMatch[]`) | `src/lib/mentions.ts:345` |
| Upload generated file | `Chat` helper wrapping `uploadWorkspaceFile` so transcript metadata stays attached | `src/components/Chat.tsx:3098-3175`, `src/lib/workspace-upload.client.ts:119` |
| Send file reference | `appendUserUploadReferences` | `src/lib/chat-attachment-refs.ts:20` |
| Attachment row + remove (`X`) | `AttachmentList` / `FileCard` (88×88) | `src/components/attachment-list.tsx:8-71`, `src/components/file-card.tsx` |
| Persist transcript attachment metadata | Extend serialized attachment shape | `src/hooks/use-draft-persistence.ts:51-63` |
| Composer | `PromptInput` (unchanged invocation) | `src/components/prompt-input.tsx` |
| Transcript card metadata | `ChatGroupThreadSummary[]` on `liveActiveChatGroup.open_threads`; add required `first_user_message` field | `src/types.ts:62-81`, `src/lib/chat-groups.server.ts:43-79,168-225` |
| Recently used tag sourcing | Bounded scan of capped sibling thread messages; `stripMentionAnnotationsWithMetadata` first, `parseMentions` fallback | `src/lib/chat-do.server.ts:695`, `src/lib/mentions.ts:310-370` |
| Condensed transcript source | New route reads `getPiCoreMessages`, flattens with `buildFinalOutputMessageView` + `countTurnSteps` | `src/lib/chat-do.server.ts:695`, `src/lib/turn-utils.ts:210` |

**New files:** `src/components/welcome-screen/group-new-chat-header.tsx`, `src/components/welcome-screen/recently-used-in-group.tsx`, `src/components/welcome-screen/transcript-card.tsx`, `src/components/welcome-screen/transcript-hover-preview.tsx`, `src/routes/api/threads.$id.condensed-transcript.ts`, and the matching `src/routes.ts` route entry. Add the transcript attachment branch inside `src/components/attachment-list.tsx`.

---

## 10. Tests (agent-actionable)

- **Lockup** — renders avatar (lg) + "New chat in" eyebrow + group name in `font-serif italic`; falls back gracefully when `avatar` is missing (letter fallback via `ChatGroupAvatar`).
- **Tag click** — appends `@slug ` to existing input (doesn't replace); the tag then disappears from the section (derived via `parseMentions`); deleting the mention text returns the tag.
- **Transcript card** — renders badge + title + opening line; corner icon swaps `MessageSquare`→`Plus` on hover; click triggers the build→upload flow and adds a transcript attachment carrying `sourceThreadId`; card then leaves the section; removing the tile returns it.
- **Transcript tile** — `AttachmentList` renders the transcript variant (badge "chat" + chat name + snippet) for `kind:'transcript'`, shows uploading/complete/error states, and removal calls `onAttachmentRemove`.
- **Draft persistence** — saved/restored drafts and delivery drafts preserve transcript attachment fields (`kind`, `sourceThreadId`, `sourceTitle`, `snippet`) so the tile does not downgrade to a generic `.md` file and the source card remains hidden until removal.
- **Hover preview** — opens in a portal (not clipped), flips when no room below; renders User on normal bg and Assistant on the lighter full-width band; renders assistant markdown; shows `[N messages omitted]` as bracketed italic **inside the assistant band, under the "Assistant" label and above the final reply** (not between the two roles); scrolls without text clipping (no `ScrollArea` `display:table` regression); stays open over card or preview.
- **Standard screen unchanged** — with no `group` prop, `WelcomeScreen` renders the existing layout byte-for-byte.
- **Group summary hydration** — server hydration, optimistic single-thread group builders, live `useChatGroups` merge/equality, and tests all carry required `first_user_message` without dropping the field on status/title updates.
- **Backend (Codex):** condensed-transcript route returns user + final-assistant turns with correct `omittedCount`, excludes tool calls/intermediate work, skips dangling/in-progress user turns, enforces workspace/org access via `requireSessionWorkspaceAccess` + `getThread`, verifies group membership via `getGroupForWorkspace`, and tolerates a cold/empty thread; `group` sourcing de-dupes projects/connections and fails independently per source.
- **Recently used tag scan** — bounded scan extracts stable annotation ids with `stripMentionAnnotationsWithMetadata`, falls back to current-slug `parseMentions`, ignores assistant/tool messages, de-dupes by id, preserves recency order, and returns empty ids instead of failing the screen when one sibling DO read fails.
- **Transcript extraction helper** — unit-test multiple assistant messages in one turn, tool/thinking blocks before final text, attributed user messages, mention annotations/system blocks, compact-summary/meta messages, assistant errors, and zero-turn/empty output.
- **Run:** `bun run typecheck`, `bun run lint`, the relevant Vitest UI tests, and `bun run test:workers` for the transcript route + any summary-hydration changes.

---

## 11. Implementation decisions locked for v1

- **Opening line source** — add `first_user_message` to `ChatGroupThreadSummary` and use it for card `openingLine`.
- **Transcript cards** — use capped `open_threads` only, newest-first, with completed assistant output required.
- **Transcript content** — fetch on demand from `ChatThreadDO` persisted messages through `GET /api/threads/:id/condensed-transcript?groupId=<groupId>`; never source transcript turns from group summaries.
- **Projects/connections sourcing** — use the bounded server-side sibling-thread scan in §8.1; no precomputed mention index for v1.
- **Transcript endpoint return** — structured `turns` only; client serializes markdown for upload from that payload.
- **Omitted count semantics** — count suppressed assistant work items with `countTurnSteps`, not raw message rows.
- **Transcript metadata persistence** — persist `kind/sourceThreadId/sourceTitle/snippet` in local drafts and delivery drafts.
- **Serif token** — use `font-serif` for the group lockup heading to match the existing welcome greeting.

---

## 12. Out of scope (continues as today)

- The tab bar, the new-chat tab, and the status-dot cascade.
- The **standard** new-chat screen (no group) — unchanged.
- Group creation, rename, move, avatar editing (covered by the chat-group-avatars work).
- The **sidebar** chat-group hover popover (`ChatGroupHoverCard`) — a different, already-shipped feature.
- Everything in the composer footer except the behavioral additions in §6 (append-mention, transcript attach, transcript tile). No footer or chrome changes — the composer is reused exactly as it is today.
- The precise mechanics of how a thread's messages are stored (we only read them).
