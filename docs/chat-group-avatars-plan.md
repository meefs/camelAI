# Chat Group Avatars — Emoji + Color Chips — Plan

**Date:** 2026-06-19
**Branch:** `illianaa/chat-group-avatars`
**Surfaces:** Sidebar (expanded + collapsed) · Rename chat group modal · shared Edit-avatar modals (`/settings/profile`, `/settings/workspace/general`)
**Roles:** PM/design authored the UI requirements. Codex technical audit added the persistence, validation, generation, migration/backfill, and test plan in the backend sections below.

---

## Objective

Give every chat group a small, scannable visual identity: an **emoji on a solid colored, rounded-square chip**. The same chip identifies the group in the expanded sidebar, in the collapsed rail, and as the live preview in the rename modal. Identity is **auto-assigned on creation** (so the list always looks complete), **per-user** (like the grouping itself), and **editable any time** through an upgraded "Rename chat group" modal.

This also upgrades the two existing Edit-avatar modals (user + workspace) so all three avatar editors share the same components and feel: full searchable emoji catalog + custom color picker. The only intentional difference is shape — **groups are a rounded chip; users and workspaces stay circles.**

Decoration, not status. Color/emoji live on the **left**; the existing status signals (working spinner / unread dot) and chat count stay on the **right**. They never compete.

```text
  BEFORE (expanded)                         AFTER (expanded)
  ┌──────────────────────────────┐         ┌──────────────────────────────┐
  │ Create a Python Noteb…  ● 5  │         │ 🐸  Create a Python Noteb… ● 5│
  │ Work on basic-ai-age…   ◌ 2  │   ───►  │ 🟣  Work on basic-ai-age…  ◌ 2│
  │ Asking if the assist…     1  │         │ 🔍  Asking if the assist…    1│
  └──────────────────────────────┘         └──────────────────────────────┘
   name leads; neutral.                      colored emoji chip leads; status stays right.

  BEFORE (collapsed)     AFTER (collapsed)
      ┌──┐                   ┌──┐
      │C │  neutral letter   │🐸│  colored emoji tile
      │W │  tiles, all       │🟣│  distinct + scannable,
      │A │  look the same    │🔍│  bigger tap target
      └──┘                   └──┘
```

---

## Design principles (from the spec)

- **Same chip everywhere.** Recognition transfers between expanded ↔ collapsed ↔ modal preview.
- **Every group has one.** Auto-assigned at creation, including a brand-new group of one. Never half-decorated.
- **Quiet by default.** Small chip at the start of the row; a confident little tile, not a band of color.
- **Decoration, not new meaning.** Color/emoji do not encode status, priority, or system state.
- **Personal.** Color + emoji are per-user; changing them affects only the current person's view. (This falls out for free — chat groups already live in the per-user `UserDO`.)
- **Stable.** Auto-assigned values don't change on their own once set.

---

## The chip, defined once

A chat-group avatar is the **existing `Avatar` shape** (`{ color, content }`) where `content` holds a **single emoji** (with a defensive letter fallback). The only new visual concept is the **rounded-square shape** ("rounded chip / squircle") vs. the circle used by user/workspace avatars.

```text
   Rounded chip (groups)            Circle (users / workspaces — unchanged)
        ╭───────╮                            ╭───────╮
        │       │                           (         )
        │  🐸   │  solid saturated bg       (   DE    )  initials or emoji
        │       │  emoji centered           (         )
        ╰───────╯                            ╰───────╯
   radius ≈ 28% of side (scales              radius = 50% (circle)
   proportionally at every size)
```

We implement this by adding a `shape` prop to the shared `Avatar` (default `"circle"`, so every existing call site is untouched), and rendering all three group surfaces through one tiny `ChatGroupAvatar` wrapper.

### Sizing reference (one squircle, three sizes)

| Surface | Avatar `size` | px | Corner radius (28%) | Emoji font |
|---|---|---|---|---|
| Sidebar **expanded** row chip | `sm` | 20 | ~6px | 11px |
| Sidebar **collapsed** rail chip | `md` | 24 | ~7px | 13px |
| Modal **preview** chip | `xl` | 64 | ~18px | 32px |
| _(workspace switcher avatar, for contrast — unchanged)_ | `default` | 32 | circle | — |

`28%` keeps the same squircle proportion at every size (percentage border-radius is relative to the element's own side; chips are square). It is tunable — target the app-icon look in the prototypes (≈25–30%).

---

## Component architecture

Maximize reuse so the three editors are siblings, not forks.

```text
                         src/components/ui/avatar.tsx
                         └─ Avatar / AvatarFallback  (+ NEW `shape` prop)
                                       │
        ┌──────────────────────────────┼───────────────────────────────┐
        │                              │                                │
  ChatGroupAvatar                 AvatarEditor  ◄── shared controls ──► (color + emoji [+ initials])
  (the chip wrapper)              src/components/avatar/avatar-editor.tsx
        │                              │
        │             ┌────────────────┴───────────────────┐
        │             │                                    │
  used by:      RenameChatGroupDialog              AvatarPicker (refactor)
  - sidebar     src/components/avatar/             src/components/settings/avatar-picker.tsx
  - modal         rename-chat-group-dialog.tsx     - shape="circle", allowInitials
    preview       - shape="rounded"                - used by profile + workspace
                  - name field + AvatarEditor        settings forms

  New shadcn-style primitives composed inside AvatarEditor:
    src/components/ui/emoji-picker.tsx   (frimousse — full searchable catalog)
    src/components/ui/color-picker.tsx   (react-colorful — custom hue/sat + hex)
```

**Proposed new files**
- `src/components/ui/emoji-picker.tsx` — styled emoji catalog primitive.
- `src/components/ui/color-picker.tsx` — styled custom color primitive.
- `src/components/avatar/avatar-editor.tsx` — shared color + emoji (+ optional initials) body.
- `src/components/avatar/chat-group-avatar.tsx` — the chip wrapper.
- `src/components/avatar/rename-chat-group-dialog.tsx` — new rename+avatar modal.

**Edited files**
- `src/components/ui/avatar.tsx` — add `shape`.
- `src/components/settings/avatar-picker.tsx` — refactor onto `AvatarEditor`.
- `src/components/sidebar/chat-groups-list.tsx` — chip + status logic.
- `src/components/chat-tab-bar.tsx` — swap the inline `RenameGroupDialog` for `RenameChatGroupDialog`.
- `src/routes/_app.chat.$id.tsx` and `src/routes/_app.chat._index.tsx` — `onRenameGroup` sends `{ name, avatar }`.
- `src/lib/avatar.ts` — add chat-group-specific avatar defaults + validation helpers; do not reuse `generateDefaultAvatar` because it produces initials, not emoji.
- `src/types.ts` — `avatar: Avatar` on the chat-group types (shared shape; backend persistence details in §12).

> File locations are a suggestion; the implementer may keep `emoji-picker`/`color-picker` under `src/components/ui/` (shadcn convention) and co-locate the rest however is cleanest. The constraint that matters: **one `AvatarEditor`, one `ChatGroupAvatar`, one `shape`-aware `Avatar`.**

---

## 1. `Avatar` — add a `shape` prop

`src/components/ui/avatar.tsx` currently hardcodes `rounded-full` on the root, image, and fallback. Make shape configurable via context (mirrors how `size` already flows through `AvatarSizeContext`). Default `"circle"` → every existing usage is byte-identical.

```tsx
type AvatarShape = "circle" | "rounded"
const AvatarShapeContext = React.createContext<AvatarShape>("circle")

const shapeClass = {
  circle: { box: "rounded-full", after: "after:rounded-full" },
  rounded: { box: "rounded-[28%]", after: "after:rounded-[28%]" }, // squircle
} as const

function Avatar({ className, size = "default", shape = "circle", ...props }) {
  return (
    <AvatarSizeContext.Provider value={size}>
      <AvatarShapeContext.Provider value={shape}>
        <AvatarPrimitive.Root
          data-slot="avatar"
          data-size={size}
          data-shape={shape}
          className={cn(
            "after:border-border group/avatar relative flex shrink-0 select-none after:absolute after:inset-0 after:border after:mix-blend-darken dark:after:mix-blend-lighten",
            shapeClass[shape].box,
            shapeClass[shape].after,
            avatarSizes[size]?.container ?? avatarSizes.default.container,
            className,
          )}
          {...props}
        />
      </AvatarShapeContext.Provider>
    </AvatarSizeContext.Provider>
  )
}
```

In `AvatarFallback`, read the shape and swap the radius (drop the hardcoded `rounded-full`):

```tsx
const shape = React.useContext(AvatarShapeContext)
// ...
className={cn(
  "bg-muted text-muted-foreground flex size-full items-center justify-center",
  shape === "rounded" ? "rounded-[28%]" : "rounded-full",
  fontClass,
  className,
)}
```

(Do the same swap in `AvatarImage` for completeness; groups only ever use the fallback.) `AvatarFallback` already auto-sizes the font for 1-char (emoji/letter) vs 2-char content via `getCharacterCount`, so a single emoji renders correctly at every size with no extra work.

---

## 2. `ChatGroupAvatar` — the chip wrapper

One component renders the chip everywhere, with the defensive letter fallback baked in (resolves the spec's open question — see below).

```tsx
// src/components/avatar/chat-group-avatar.tsx
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { getContrastTextColor } from "@/lib/avatar"
import { cn } from "@/lib/utils"
import type { Avatar as AvatarShape } from "@/types"

export function ChatGroupAvatar({
  avatar,
  fallbackName,
  size = "sm",
  className,
}: {
  avatar: AvatarShape | null | undefined
  fallbackName?: string
  size?: "sm" | "md" | "lg" | "xl"
  className?: string
}) {
  const color = avatar?.color ?? "#3B82F6" // defensive; backend always assigns one
  const content =
    avatar?.content?.trim() ||
    (fallbackName?.trim()?.[0] ?? "?").toUpperCase() // letter fallback on the same tile
  return (
    <Avatar size={size} shape="rounded" aria-hidden className={cn("shrink-0", className)}>
      <AvatarFallback
        content={content}
        style={{ backgroundColor: color, color: getContrastTextColor(color) }}
      >
        {content}
      </AvatarFallback>
    </Avatar>
  )
}
```

The chip is `aria-hidden` because every place it appears already has a text label for the group (the row's `aria-label`, the modal's name field). No double announcement.

---

## 3. Sidebar — expanded state

**File:** `src/components/sidebar/chat-groups-list.tsx`

Today each row renders `<ChatGroupCollapsedIcon>` (which is invisible when expanded), then the name, then `<ChatGroupRightSlot>` (status + count). The redesign **adds a leading chip in the expanded row** and keeps the right slot exactly as-is.

```text
  ┌─────────────────────────────────────────────────────────────┐
  │ [🐸]  Create a Python Notebook…              ●   5           │   ← selected: raised bg, full-strength name
  │  ▲    ▲                                       ▲   ▲           │
  │ chip  name (truncates, flex-1, muted unless   │   count      │
  │ 20px  selected)                          status (right)       │
  └─────────────────────────────────────────────────────────────┘
   gap-2 between chip and name. Chip + right slot are shrink-0 and
   never give way; only the name truncates with an ellipsis.
```

Row contract (unchanged behaviors): the whole row lifts to the brighter rounded background on hover; the active row keeps its emphasized (raised bg + `font-medium`) treatment. **The chip sits inside the button and inherits none of it** — it always shows its own color/emoji on top of selection styling.

Replace `ChatGroupCollapsedIcon` with a status-aware `ChatGroupIcon` that handles both states in one element (so the call site stays `<ChatGroupIcon group={group} />`):

```tsx
import { ChatGroupAvatar } from "@/components/avatar/chat-group-avatar"

export function ChatGroupIcon({ group }: { group: ChatGroupView }) {
  const running = group.status === "running"
  const unread = group.status === "unread"
  return (
    <>
      {/* EXPANDED: always the emoji chip — status lives on the right slot */}
      <ChatGroupAvatar
        avatar={group.avatar}
        fallbackName={group.name}
        size="sm"
        className="group-data-[collapsible=icon]:hidden"
      />

      {/* COLLAPSED: status replaces the chip (matches today's behavior) */}
      {running ? (
        <span className="hidden text-muted-foreground group-data-[collapsible=icon]:block">
          <CamelLoader size={16} ariaLabel="Agent is working" />
        </span>
      ) : unread ? (
        <span
          aria-label="Awaiting your review"
          className="hidden size-2.5 rounded-full bg-amber-500 group-data-[collapsible=icon]:block"
        />
      ) : (
        <ChatGroupAvatar
          avatar={group.avatar}
          fallbackName={group.name}
          size="md"
          className="hidden group-data-[collapsible=icon]:flex"
        />
      )}
    </>
  )
}
```

`ChatGroupRightSlot` is **unchanged** — it keeps showing the working spinner / unread dot + count on the right in the expanded row, and stays hidden when collapsed. So in the expanded row there is exactly one status indicator (right) and the emoji is purely identity (left).

---

## 4. Sidebar — collapsed state

When collapsed, **the chip is the group.** The same tile becomes the rail icon at the larger `md` (24px) size for a comfortable tap target, centered in the existing 32px collapsible button, in the same order as the expanded list.

```text
   workspace nav (unchanged)
        ┌──┐  💬 New chat
        │..│  🗨 Chat History
        │..│  🔗 Connections
        │..│  ▦ Apps
        │..│  ⏱ Automations
        ├──┤
   chat │🐸│   ← idle:    emoji tile (md / 24px)
  groups│◌ │   ← running: spinner replaces the emoji  (status dot replaces emoji)
        │● │   ← unread:  amber dot replaces the emoji
        │🔍│
        └──┘
```

This is already encoded by the `group-data-[collapsible=icon]:*` toggles in `ChatGroupIcon` above: idle → `md` chip; running → spinner; unread → dot. Clicking a tile selects the group exactly as today (the click handler on `SidebarMenuButton` is untouched). Hover is unchanged. The drag-over ring styling for thread drops stays as-is.

---

## 5. Status coexistence — the full matrix

| State | Expanded: **left** | Expanded: **right** | Collapsed: **tile** |
|---|---|---|---|
| Idle | emoji chip | count | emoji chip |
| Working (`running`) | emoji chip | spinner + count | spinner |
| Unread (`unread`) | emoji chip | amber dot + count | amber dot |

Status cascades to the group and the workspace switcher exactly as it does today — **this plan does not touch status logic**, only adds the left-side identity chip and swaps the collapsed neutral letter for the emoji tile.

---

## 6. Rename chat group modal → name + avatar

**File:** new `src/components/avatar/rename-chat-group-dialog.tsx`, replacing the inline `RenameGroupDialog` in `src/components/chat-tab-bar.tsx`.

This is the headline UI. Transcribed from the prototype (`.context/attachments/3aTkDw/image.png`):

```text
  ┌───────────────────────────────────────────────────────────────┐
  │  Rename chat group                                         [✕] │
  │  Pick a name, color, and emoji for this group.                 │
  │                                                                │
  │   ╭──────╮                                                     │
  │   │  🌊  │   Automate Chat Review And Feedback                 │  ← live preview: chip (xl/64px) + name
  │   ╰──────╯                                                     │
  │                                                                │
  │  Name                                                          │
  │  ┌──────────────────────────────────────────────────────────┐ │
  │  │ Automate Chat Review And Feedback                        ▌ │ │  ← autofocus, prefilled, required
  │  └──────────────────────────────────────────────────────────┘ │
  │                                                                │
  │  Color                                                         │
  │  ●  ●  ●  ●  ●  ●            ⊕   ← preset swatches + custom    │
  │  ┌──────────────────────────────────────────────────────────┐ │
  │  │ ▓▓▓▒▒▒░░░  hue/spectrum                          [handle] │ │  ← shown when custom is active
  │  └──────────────────────────────────────────────────────────┘ │
  │  ┌──────────────────────────────┐                             │
  │  │ ▣  #E0476B                    │                             │  ← hex field
  │  └──────────────────────────────┘                             │
  │                                                                │
  │  Emoji                                                         │
  │  ┌──────────────────────────────────────────────────────────┐ │
  │  │ 🔍  Search all emoji                                       │ │  ← filters the catalog as you type
  │  └──────────────────────────────────────────────────────────┘ │
  │  [🌊][😀][😍][😎][🔥][✨][⭐][⚡]     ← quick picks (one tap)   │
  │  ┌──────────────────────────────────────────────────────────┐ │
  │  │ 😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 🫠 😉 …  full catalog,       │ │  ← scrollable, category-browsable
  │  │ 🌿 🍄 🌞 🌙 🐼 🦊 🦄 …                  (frimousse)         │ │
  │  └──────────────────────────────────────────────────────────┘ │
  │                                                                │
  │                                          [ Cancel ]  [ Save ]  │  ← right-aligned, Save = primary
  └───────────────────────────────────────────────────────────────┘
```

Note: the color **swatches are circles** (they represent color) even though the **preview is a chip** (it represents the group). This matches the prototype.

**Layout, top to bottom**
1. **Live preview + name.** `ChatGroupAvatar size="xl"` (the chip) on the left, the current name in large semibold text on the right. Both update in real time as the user edits. If the name is empty, show a muted placeholder ("Untitled group") in the preview.
2. **Name** — shadcn `Input`, `autoFocus`, prefilled with the current name. Empty is invalid (Save disabled).
3. **Color** — preset circles (from `AVATAR_COLORS`) + a trailing **custom swatch** (rainbow gradient with a `+`/picker glyph). Selecting any preset updates the preview immediately and shows a selected ring. Selecting custom reveals the spectrum + hex (§8).
4. **Emoji** — search field, then a one-tap **quick-pick** row, then the full **searchable, category-browsable catalog** (§7). The current emoji is highlighted wherever it appears.
5. **Footer** — `Cancel` (outline) + `Save` (primary), right-aligned, matching the avatar modal.

**Component skeleton** (Dialog on desktop, Sheet on mobile — reuse the `useIsMobile` split already in `AvatarPicker`):

```tsx
export function RenameChatGroupDialog({
  open, onOpenChange, initialName, initialAvatar, onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialName: string
  initialAvatar: AvatarShape
  onSubmit: (next: { name: string; avatar: AvatarShape }) => void
}) {
  const [name, setName] = useState(initialName)
  const [color, setColor] = useState(initialAvatar.color)
  const [content, setContent] = useState(initialAvatar.content) // emoji

  // reset to props each time it opens (discard prior pending edits)
  useEffect(() => {
    if (open) { setName(initialName); setColor(initialAvatar.color); setContent(initialAvatar.content) }
  }, [open, initialName, initialAvatar.color, initialAvatar.content])

  const trimmed = name.trim()
  const changed =
    trimmed !== initialName.trim() ||
    color !== initialAvatar.color ||
    content !== initialAvatar.content
  const canSave = trimmed.length > 0 && changed

  const submit = () => {
    if (!canSave) return
    onSubmit({ name: trimmed, avatar: { color, content } })
    onOpenChange(false)
  }

  // Header: "Rename chat group" / "Pick a name, color, and emoji for this group."
  // Preview: <ChatGroupAvatar size="xl" avatar={{ color, content }} fallbackName={name} /> + name text
  // Name: <Input autoFocus value={name} onChange=… />
  // Body:  <AvatarEditor shape="rounded" allowInitials={false}
  //           color={color} content={content}
  //           onColorChange={setColor} onContentChange={setContent} />
  // Footer: Cancel / <Button disabled={!canSave} onClick={submit}>Save</Button>
}
```

**Interactions & behavior**
- **Live preview** — every change (name, color, emoji) reflects in the preview chip + name immediately.
- **Save** — applies name + color + emoji together, closes the modal; the sidebar (both states) reflects the new identity right away (via revalidation). Disabled when the name is empty or nothing changed.
- **Dismiss** — `Cancel`, the `✕`, `Esc`, and backdrop click all discard pending edits (local state resets on next open). The group is untouched.
- **Pre-population** — opens with the group's current name, color, and emoji already selected. Editing, never blank.
- **No "clear emoji" affordance** for groups — emoji is always present (auto-assigned). See open-question resolution.

**Entry points** — the existing `⋯ → Rename group` item in `chat-tab-bar.tsx` (line ~555) opens this dialog instead of the old one. Title stays "Rename chat group"; the supporting line broadens from "Pick a name that describes this group of chats." to "Pick a name, color, and emoji for this group." Wire any other existing rename affordance to the same component (see §10).

---

## 7. Emoji picker (full catalog + search)

There is **no emoji picker in the repo today** — only a hardcoded 28-emoji `EMOJI_OPTIONS` array in `avatar-picker.tsx`. The spec wants the entire catalog, searchable and category-browsable.

**Recommendation: add [`frimousse`](https://frimousse.liveblocks.io/)** — a lightweight, headless, composable emoji picker built for React + Tailwind (this is the picker shadcn's own registry uses). Wrap it as `src/components/ui/emoji-picker.tsx` and style it to our tokens:

```tsx
import { EmojiPicker as Frimousse } from "frimousse"

export function EmojiPicker({ onSelect }: { onSelect: (emoji: string) => void }) {
  return (
    <Frimousse.Root
      className="flex h-64 flex-col rounded-md border bg-popover"
      onEmojiSelect={({ emoji }) => onSelect(emoji)}
    >
      <Frimousse.Search
        className="m-2 h-9 rounded-md border bg-transparent px-3 text-sm outline-none"
        placeholder="Search all emoji"
      />
      <Frimousse.Viewport className="relative flex-1 overflow-y-auto">
        <Frimousse.Loading className="p-3 text-sm text-muted-foreground">Loading…</Frimousse.Loading>
        <Frimousse.Empty className="p-3 text-sm text-muted-foreground">No emoji found</Frimousse.Empty>
        <Frimousse.List /> {/* virtualized rows + sticky category headers */}
      </Frimousse.Viewport>
    </Frimousse.Root>
  )
}
```

**Quick-picks coexist with the catalog.** Above the catalog, render a single one-tap row from a curated set (reuse/trim today's `EMOJI_OPTIONS` to a tidy ~8–16). The currently-selected emoji gets a selected ring wherever it shows. When the search box is non-empty, hide the quick-pick row so search owns the view.

**Technical recommendation:** do not depend on a runtime CDN fetch for emoji data. Frimousse can still be the UI layer, but configure it with bundled/self-hosted data (or add `emojibase-data` and render our own virtualized grid) so local dev, CSP, and offline-ish states do not break the picker. If the implementer keeps frimousse's default dataset loading, they must verify app CSP and dev-mode behavior before shipping.

**Implementation blocker: upgrade emoji validation first.** `isEmoji` / `validateAvatarContent` in `src/lib/avatar.ts` currently accept simple single-grapheme emoji and flags, but reject common full-catalog outputs such as ZWJ families (`👨‍👩‍👧`), skin tones (`👍🏽`), and ZWJ flags (`🏳️‍🌈`). This is not only a chat-group risk: the existing profile/workspace avatar save paths already enforce `validateAvatarContent` server-side in `workers/main/src/identity/user-do.ts`, `workers/main/src/workspace.ts`, and `workers/main/src/identity/org-do.ts`. Therefore §9 must not swap user/workspace avatar modals to the full picker until the shared validator accepts every emoji the picker can emit.

Required first step:
- make the picker output and `validateAvatarContent` share the same emoji boundary, either by backing validation with the same bundled emoji dataset as the picker or by restricting picker output to items that pass the validator;
- preserve the existing two-letter initials behavior for user/workspace avatars;
- add tests proving at least `👨‍👩‍👧`, `👍🏽`, `🏳️‍🌈`, a simple emoji, a flag, two-letter initials, and invalid multi-character strings behave correctly;
- verify all three existing server-side validation call sites keep accepting saved profile/workspace avatars.

---

## 8. Custom color picker (presets + any color)

No color picker exists today. The spec wants curated presets **plus** a custom spectrum + hex, available to everyone.

**Recommendation: add [`react-colorful`](https://github.com/omgovich/react-colorful)** (~2.8kb, zero-dep) for the custom picker. Wrap as `src/components/ui/color-picker.tsx`:

```tsx
import { HexColorPicker, HexColorInput } from "react-colorful"

export function ColorPicker({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  return (
    <div className="space-y-2">
      <HexColorPicker color={value} onChange={onChange} className="!w-full" />
      <div className="flex items-center gap-2 rounded-md border px-3 py-2">
        <span className="size-4 rounded-sm border" style={{ backgroundColor: value }} />
        <span className="text-sm text-muted-foreground">#</span>
        <HexColorInput color={value} onChange={onChange} className="flex-1 bg-transparent text-sm outline-none" />
      </div>
    </div>
  )
}
```

**Behavior**
- Presets: a row of `AVATAR_COLORS` circles + one trailing **custom swatch** (rainbow gradient + `+`). Clicking a preset selects it (ring) and updates the preview.
- Custom: clicking the custom swatch reveals the `ColorPicker`. The chosen custom color reads as selected just like a preset. If the group's current color isn't one of the presets, the custom swatch starts selected with the picker shown (matches the prototype, which opens on `#E0476B`).
- Normalize custom colors to uppercase `#RRGGBB` before saving. `HexColorInput` can emit unprefixed values depending on configuration; either use its prefixed mode or prepend `#` in the wrapper. Storage, contrast helpers, and inline CSS should all receive the same normalized format.
- **Drop the `100%` opacity control** from the prototype — chips are solid/saturated per the spec, and alpha complicates contrast + storage. _(Confirmed by product: no opacity/alpha control. Trivial to add later if ever desired.)_

---

## 9. Shared Edit-avatar modal upgrade (user + workspace)

**File:** `src/components/settings/avatar-picker.tsx` (used by `profile-form.tsx` and `workspace-general-form.tsx`).

Refactor its body onto the same `AvatarEditor`, gaining the full emoji search (§7) and custom color (§8) for free, while **keeping the initials input** these avatars rely on. Only the picker body changes — the Dialog/Sheet wrapper, the `value`/`onChange` contract, the hidden `avatarColor`/`avatarContent` form fields, and both route actions stay exactly as they are.

Do this only after the validator blocker in §7 is fixed. The existing profile/workspace save paths already reject invalid avatar content server-side, so full-catalog emoji support must be proven before these existing modals expose new emoji choices.

```text
  Edit avatar (user / workspace)                 differences vs. group modal
  ┌───────────────────────────────────────┐     • preview is a CIRCLE (shape="circle")
  │  Edit avatar                      [✕]  │     • no Name field (name lives on the form)
  │  Choose a color and emoji or initials. │     • keeps the "custom initials" input
  │   (●)  large circle preview            │       (allowInitials = true)
  │  Color    ● ● ● ● ● ●   ⊕  + custom    │     • everything else identical → same feel
  │  Emoji    🔍 search · quick · catalog  │
  │  Initials [ JS ]                       │
  │                        [Cancel][Save]  │
  └───────────────────────────────────────┘
```

`AvatarEditor` props: `{ shape, allowInitials, color, content, onColorChange, onContentChange, error? }`. The user/workspace `AvatarPicker` calls it with `shape="circle"` + `allowInitials`; the group dialog calls it with `shape="rounded"` + `allowInitials={false}`. `validateAvatarContent` (already in `@/lib/avatar`) keeps gating the initials/emoji case for the user/workspace path; the group path only ever stores an emoji.

This satisfies "these three modals should look and feel very similar… ideally the same components."

---

## 10. Wiring & data flow (frontend)

- **Type:** add `avatar: Avatar` to `ChatGroup` / `ChatGroupSummary` / `ChatGroupView` in `src/types.ts`. Reuse the existing `Avatar` interface (`{ color, content }`); for chat groups, `content` = emoji (or defensive letter). Do not globally narrow `Avatar.content` to emoji because profile/workspace avatars still support initials.
- **Sidebar:** `useChatGroups()` → `ChatGroupsList` → `ChatGroupIcon` reads `group.avatar`. No prop-drilling changes beyond the type gaining a field.
- **Fallback views:** update `buildFallbackActiveChatGroup` in `src/routes/_app.chat.$id.tsx` so the temporary local fallback object includes a valid avatar from the same chat-group default helper; otherwise `ChatGroupView` becomes required-but-missing in the optimistic/new-thread path.
- **Tab bar props:** `ChatTabBar` currently receives only `groupName`; add `groupAvatar`, pass `liveActiveChatGroup.avatar` from both `src/routes/_app.chat.$id.tsx` and `src/routes/_app.chat._index.tsx`, then pass `initialAvatar={groupAvatar}` into `RenameChatGroupDialog`.
- **Rename submit:** `chat-tab-bar.tsx` forwards `onSubmit({ name, avatar })`. In both chat routes, `renameGroup` changes from `body: { name }` to `body: { name, avatar }` on the existing `PATCH /api/chat-groups/:id`, then revalidates as today.
- **Entry points:** keep `⋯ → Rename group` (chat-tab-bar). The sidebar rows currently expose only a close (`✕`) action and no rename — adding a rename entry there (context menu or hover `⋯`) that opens the same `RenameChatGroupDialog` is an **optional consistency win**; if added, lift the dialog so both the tab bar and the sidebar row can mount it. Not required for the core feature.

```text
  ⋯ Rename ──► RenameChatGroupDialog ──► onSubmit({name, avatar})
                                              │
                                  PATCH /api/chat-groups/:id  {name, avatar}
                                              │
                                  persist on chat_groups, return in
                                  ChatGroupSummary/View
                                              │
                                  revalidate ──► sidebar chips + tab bar update live
```

---

## 11. Auto-assignment (UX intent)

Every group must look complete from the moment it exists, including a brand-new group of one.

- **Color — spread, not random.** Assign so adjacent groups tend to differ (workspace-local round-robin through `AVATAR_COLORS`; details in §12.2). Stable once set.
- **Emoji — LLM-chosen, relevant.** The group is already auto-named by an auxiliary LLM when its first thread gets a title (`generateThreadTitleFromMessage` → `renameEmptySingleThreadGroupForThread` in `chat-thread-do.ts`). Generate a relevant emoji for the **group title at that same moment** using the separate best-effort helper in §12.7. **The emoji must not be added to the thread title** — only the group carries it.
- **Never half-decorated.** On creation, assign the color immediately and a provisional emoji (a sensible default such as 💬, or a deterministic pick) so a just-created group already shows a complete chip. Upgrade to the LLM emoji when the title is generated. After that, values are stable and only change via the modal.

---

## 12. Backend, persistence & migration — Codex technical plan

This is the implementation plan for the backend/logic pass. The current source of truth is `workers/main/src/identity/user-do.ts`: chat groups are SQLite rows inside each per-user `UserDO`, and the current schema version is `9`. That means this is a **UserDO schema bump + lazy per-user backfill**, not a global database migration.

### 12.1 Storage: bump `UserDO` schema to V10

Add chat-group avatar columns in `workers/main/src/identity/user-do.ts` and bump `CURRENT_SCHEMA_VERSION` from `9` to `10`.

Recommended columns:

```sql
ALTER TABLE chat_groups ADD COLUMN avatar_color TEXT NOT NULL DEFAULT '#3B82F6';
ALTER TABLE chat_groups ADD COLUMN avatar_content TEXT NOT NULL DEFAULT '💬';
ALTER TABLE chat_groups ADD COLUMN avatar_content_source TEXT NOT NULL DEFAULT 'default';
ALTER TABLE chat_groups ADD COLUMN avatar_emoji_last_attempt_at INTEGER;
```

`avatar_content_source` is important. It prevents background generation from overwriting a user edit. Use:

| Source | Meaning | May automatic generation overwrite it? |
|---|---|---|
| `default` | provisional/default emoji, safe to improve | yes |
| `generated` | LLM chose this emoji | no |
| `user` | user saved this avatar in the modal | no |

In the V10 migration:
- add the columns;
- immediately backfill `avatar_color` deterministically for existing rows by workspace;
- leave `avatar_content = '💬'`, `avatar_content_source = 'default'`, and `avatar_emoji_last_attempt_at = NULL` so later LLM enrichment can improve them.

Do **not** call an LLM from `migrate()`. UserDO migrations run during normal requests and must stay fast, deterministic, and local.

### 12.2 Color spread algorithm

Use the existing `AVATAR_COLORS` palette from `src/lib/avatar.ts`, but add a chat-group-specific helper rather than reusing `generateDefaultAvatar` (that helper returns initials).

For existing groups in V10:

```text
SELECT id, org_id, workspace_id, created_at
FROM chat_groups
ORDER BY org_id, workspace_id, created_at ASC, id ASC
```

Walk those rows in JS inside the migration. Maintain a counter per `{org_id, workspace_id}` and assign:

```ts
color = AVATAR_COLORS[counterForWorkspace % AVATAR_COLORS.length]
```

For newly-created groups, use the same workspace-local count pattern before insert:

```sql
SELECT COUNT(*) AS count
FROM chat_groups
WHERE org_id = ? AND workspace_id = ?
```

`color = AVATAR_COLORS[count % AVATAR_COLORS.length]`.

This produces varied adjacent groups, is deterministic enough for tests, and avoids true randomness. The value is stored once and is stable after creation unless the user edits it.

This is a distribution heuristic, not a uniqueness guarantee. Because creation uses current `COUNT(*)`, deleting groups can cause later groups to reuse nearby colors. That is acceptable: colors are only decorative, and adjacent uniqueness is a best effort rather than a contract.

### 12.3 Normalize and validate avatars

This is a prerequisite for both the new group avatar flow and the §9 profile/workspace avatar modal upgrade. The current shipped validator is already enforced in `UserDO`, `WorkspaceDO`, and `OrgDO`, so changing the picker without changing validation would regress existing avatar editors.

Add shared helpers in `src/lib/avatar.ts`:
- `normalizeAvatarColor(value): string | null` — accept only `#RRGGBB`, normalize to uppercase, reject alpha/short hex/named colors.
- `normalizeChatGroupAvatar(input): Avatar | null` — require `{ color, content }`, normalized color, and one valid emoji.
- `generateDefaultChatGroupAvatar(args): Avatar` — returns `{ color, content: '💬' }` with the spread color.
- `isChatGroupEmoji(value)` or an upgraded `isEmoji` that supports the picker output, including ZWJ sequences and emoji modifiers.

Do not narrow the global `Avatar` type, because profile/workspace avatars still allow two-letter initials.

Chat-group backend validation must be strict even if the UI is correct:
- invalid color → `400`;
- invalid or empty emoji → `400`;
- extra avatar fields ignored or rejected consistently; prefer reject if the route already treats malformed bodies as `400`.

### 12.4 `UserDO` methods and reads

Update `toChatGroup(row)` so every `ChatGroup`, `ChatGroupSummary`, and `ChatGroupView` has:

```ts
avatar: {
  color: row.avatar_color || fallbackColor,
  content: row.avatar_content || "💬",
}
```

If the row is somehow missing values, return defensive defaults rather than throwing; this protects mixed deploy states and local test fixtures.

Keep `avatar_content_source` and `avatar_emoji_last_attempt_at` internal to `UserDO` unless a future UI needs them. The client-facing `ChatGroup` type only needs `avatar`.

Creation paths:
- `createChatGroup()` assigns default avatar columns on insert.
- `moveThreadToNewGroup()` and `ensureGroupForThread()` already call `createChatGroup()`, so they inherit the defaults.

Update paths:
- keep `renameChatGroup(groupId, name)` as a small wrapper for existing call sites/tests if useful;
- add `updateChatGroup(groupId, updates: { name?: string; avatar?: Avatar })` or `updateChatGroupAvatar(groupId, avatar)`;
- when a user-supplied avatar is saved, set `avatar_content_source = 'user'`;
- preserve the existing behavior where cosmetic edits **do not update `updated_at`**. Group ordering currently tracks chat activity, not rename/selection activity.

Generated emoji path:
- add `setGeneratedChatGroupEmojiForThread(threadId, emoji)` or extend `renameEmptySingleThreadGroupForThread(threadId, title, { generatedEmoji? })`;
- only write the generated emoji when `avatar_content_source = 'default'`;
- never overwrite `user` or `generated`;
- if extending `renameEmptySingleThreadGroupForThread`, keep the current guard: only empty, single-thread groups are auto-renamed.

### 12.5 API route contract

Update `src/routes/api/chat-groups.$id.ts`.

`PATCH /api/chat-groups/:id` should accept:

```ts
{
  name?: string;
  avatar?: { color: string; content: string };
}
```

Validation:
- require at least one of `name` or `avatar`;
- if `name` is present, trim it and require non-empty;
- if `avatar` is present, normalize/validate it with the shared helper;
- keep the existing `requireSessionWorkspaceAccess(..., { requireWrite: true })`;
- keep the existing org/workspace ownership check before updating.

Returning `{ success: true }` is enough because the routes already revalidate. Returning the updated group is fine, but not required for the UI plan.

### 12.6 Frontend hydration touch points

`src/lib/chat-groups.server.ts` can mostly keep spreading group objects, but verify each path:
- `hydrateChatGroups()` carries `group.avatar` through;
- `buildSingleThreadGroupView()` and `createGroupForNewThreadLightweight()` live in `src/lib/chat-groups.server.ts`; make sure those server helpers include the avatar from the summary/created group;
- `listGroupsForMove()` returns `ChatGroup[]` with avatar, which is okay even if the move menu does not render it yet.

Also update the local fallback object in `buildFallbackActiveChatGroup()` in `src/routes/_app.chat.$id.tsx` with a default chat-group avatar; otherwise TypeScript will fail once `avatar` is required.

### 12.7 LLM emoji generation for new groups

Use the LLM, but do it in a low-risk way.

Recommendation: keep `generateThreadTitleWithOpenAI()` unchanged for v1 and add a separate small helper, e.g. `src/lib/chat-group-avatar-generation.server.ts`:

```ts
generateChatGroupEmojiWithOpenAI(ai, titleOrName, metadata, context): Promise<string | null>
```

Prompt shape:

```text
Choose one emoji that best represents this chat group title.
Respond with exactly one emoji and no words, punctuation, markdown, or quotes.
If the title is generic, choose 💬.
```

Use the generated group title/name as the user message. Do not include transcript contents in this prompt; the title is enough and avoids sending more conversational data than needed.

In `workers/main/src/chat-thread-do.ts`, after title generation succeeds:
1. update the org thread title as today;
2. generate the emoji in a nested best-effort block;
3. call `userStub.renameEmptySingleThreadGroupForThread(threadId, title, { generatedEmoji })`.

Failures must not block or undo the thread title. If emoji generation or validation fails, keep the default emoji.

Do not add the emoji to the thread title. The emoji is group-only storage.

Important coverage invariant: this title-flow path only upgrades groups that are still empty-named, single-thread groups when `renameEmptySingleThreadGroupForThread` runs. Groups created with a non-empty fallback name (for example `ensureGroupForThread` or move flows that already know a title) may skip this path by design. Those groups are covered by the lazy backfill path in §12.8 as long as their `avatar_content_source` is still `default`.

### 12.8 Backfilling existing groups with LLM emojis

Every existing group is complete immediately after V10 because it has a deterministic color and default `💬`. To get high-quality existing emojis without making migration risky, add **lazy idempotent LLM enrichment**.

The two automatic emoji-upgrade paths are complementary:

```text
Path A: title flow
  brand-new empty single-thread group
  -> thread title generated
  -> renameEmptySingleThreadGroupForThread(..., { generatedEmoji })
  -> update only if avatar_content_source = "default"

Path B: lazy backfill
  any visible group with a non-empty name and avatar_content_source = "default"
  -> route-loader waitUntil backfill task
  -> update only if the source is still "default" after re-fetch
```

This invariant prevents overlap from being harmful and prevents gaps for non-empty fallback names.

Recommended mechanism:
- add internal `UserDO` methods such as `listChatGroupsNeedingEmojiBackfill(orgId, workspaceId, groupIds, limit)` and `setGeneratedChatGroupEmoji(groupId, emoji)`; these can read `avatar_content_source` without exposing it to the client;
- add a server helper such as `maybeBackfillChatGroupEmojis(context, userId, workspaceId, visibleGroups)` in `src/lib/chat-groups.server.ts` or a nearby server-only module;
- call it after `listGroupsForWorkspace()` / `getGroupForWorkspace()` loads groups, passing the visible group ids;
- before relying on this path, verify the React Router loader context exposes the Workers AI binding (`getEnv(context).AI`) as an `AuxiliaryAiBinding`. The `CloudflareEnv` type includes `AI`, but the implementer should confirm the runtime/test bindings are actually present and make the helper a no-op with a diagnostic log when AI is missing;
- inside `UserDO`, filter to rows where `avatar_content_source === 'default'`, the name is non-empty, and `avatar_emoji_last_attempt_at` is null or older than a retry window;
- cap work per request, e.g. 3-5 groups;
- schedule it with `waitUntil(task().catch((error) => console.error(...)))`;
- inside the task, re-fetch each group before writing and only update if `avatar_content_source` is still `default`;
- set `avatar_emoji_last_attempt_at` before or after an attempt so a broken AI binding does not cause repeated calls on every page load.

This gives active users LLM-quality backfill over time, keeps first paint fast, and avoids a dangerous all-users synchronous model sweep.

If Product requires all existing groups to be enriched before launch, build a separate maintenance script/admin job that iterates known users in batches and calls the same idempotent helper. Do not make that job part of normal schema migration.

### 12.9 Rollout and backward compatibility

- Mixed deploy safety: UI should tolerate `group.avatar` being absent briefly with the `ChatGroupAvatar` fallback, but backend should return avatars after V10.
- No random colors in production or tests; use deterministic spread so snapshots and workers tests are stable.
- Avoid model calls in tests by isolating the emoji-generation helper and mocking it where needed.
- Keep observability/logging diagnostic only: group ids, counts, status, error names/messages; no chat transcript/request body content.

**Known touch points**: `workers/main/src/identity/user-do.ts`, `src/routes/api/chat-groups.$id.ts`, `src/lib/chat-groups.server.ts`, `workers/main/src/chat-thread-do.ts`, `src/lib/thread-title-generation.server.ts`, `src/lib/auxiliary-ai.server.ts`, `src/lib/avatar.ts`, `src/types.ts`, `src/routes/_app.chat.$id.tsx`, `src/routes/_app.chat._index.tsx`, and `src/components/chat-tab-bar.tsx`.

---

## 13. Accessibility

- Chips are `aria-hidden` (the row/modal already labels the group by name) — no redundant announcements.
- Letter fallback and any letter-on-custom-color use `getContrastTextColor` for legibility; emoji are self-colored.
- Color presets / custom swatch are real `<button>`s with `aria-label` (e.g. `Select color #4F46E5`, `Custom color`) and a visible selected ring (not color-only state).
- Emoji catalog: frimousse ships keyboard nav + a search field; ensure the search input has a label/placeholder and the picker is reachable by keyboard inside the Dialog.
- Name field keeps `autoFocus` and standard input semantics; Save stays disabled (not just visually) when invalid.

---

## 14. Consistency / other surfaces (optional, low-effort)

For full recognition transfer, consider showing `ChatGroupAvatar` wherever a group is named outside the sidebar — e.g. the chat tab-bar group label and the `ChatGroupHoverCard` header. Not required for the core spec (sidebar + modals), but each is a one-line `<ChatGroupAvatar size="sm" … />` drop-in and reinforces identity. Call out explicitly if cut, so it's a decision and not an omission.

---

## 15. Tests

**UI / frontend**
- `ChatGroupAvatar`: renders emoji on the color bg; falls back to the uppercased first letter when content is empty; applies `shape="rounded"`.
- `Avatar` `shape`: `circle` (default) keeps `rounded-full` on root + fallback; `rounded` applies the squircle radius; existing snapshots/usages unaffected.
- `ChatGroupIcon`: expanded → emoji chip + right-slot status both present for running/unread; collapsed → spinner/dot replaces the tile, idle shows the `md` chip.
- `RenameChatGroupDialog`: prefills name/color/emoji; live preview tracks edits; Save disabled on empty name and on no-change; Cancel/Esc/backdrop discard; submits `{ name, avatar }`.
- `AvatarPicker` (refactor) regression: profile + workspace flows still save `{ color, content }`; initials path still validates via `validateAvatarContent`.
- Emoji validator: add focused tests for simple emoji, flags, ZWJ families, skin-tone modifiers, ZWJ flags, two-letter initials, and invalid multi-character content before wiring the full picker into profile/workspace/group modals.

**Backend / persistence**
- `workers/main/tests/user-do-chat-groups.test.ts`: update the existing `"migrates UserDO to schema V9"` assertion from V9 to V10.
- Creation: `createChatGroup`, `ensureGroupForThread`, and `moveThreadToNewGroup` all return an avatar with a deterministic spread color and default emoji.
- Migration: legacy rows receive deterministic workspace-local colors, `💬`, and `avatar_content_source = "default"`; rerunning migration remains safe.
- Update: user avatar saves set `avatar_content_source = "user"`; cosmetic name/avatar updates do not reorder groups by changing `updated_at`.
- API route: `PATCH /api/chat-groups/:id` accepts `{ name, avatar }`, rejects invalid names/colors/emoji, preserves ownership checks, and allows a valid avatar update without requiring a changed name.
- Hydration: `hydrateChatGroups`, lightweight group creation, move-menu groups, and fallback active group all include `avatar`.
- Title flow: generated emoji writes to the group only, never the thread title, and only when the avatar source is still `default`.
- Backfill: lazy LLM enrichment verifies/skips missing AI binding, caps batch size, records attempt timestamps, is idempotent, covers non-empty fallback-name groups, and never overwrites `user` or `generated` avatars. Mock the LLM helper in tests.

**Run:** `bun run typecheck`, `bun run lint`, the relevant Vitest UI tests, and `bun run test:workers` for the chat-group DO/API changes.

---

## 16. Open questions — resolved

- **Can the emoji be cleared, falling back to initials/a letter?** No user-facing "clear" for groups. Emoji is always auto-assigned and editable; `ChatGroupAvatar` keeps a **defensive letter fallback** (first letter of the name, on the same colored tile) only for legacy/empty data. Keeps every chip complete with the least surface area.
- **Is the custom color picker gated?** No — available to everyone (matches the spec).
- **Opacity (`100%` in the prototype)?** Dropped — chips are solid/saturated. Confirmed by product; the editor exposes no opacity/alpha control.
- **Status indicator color/behavior?** Unchanged. The unread dot stays `bg-amber-500` and all status logic is out of scope (see §5, §17). The prototype's green/teal dot is **intentionally not reproduced** — do not retune status to match the prototype.

---

## 17. Out of scope

- Reordering chat groups, or any change to selection/close/drag behavior beyond adding the chip.
- Changing status semantics (spinner/unread/cascade) — untouched.
- Avatar images/uploads for groups (emoji + color only).
- Theming the workspace switcher / nav icons — only the chat-group identity changes.
- Server-side rendering of emoji into thread titles — emoji is group-only by design.
