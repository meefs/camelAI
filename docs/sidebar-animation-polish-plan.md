# Sidebar Animation Polish — Implementation Plan

**July 14, 2026**

---

## TL;DR

Two independent workstreams, both entirely in `src/` (**no backend change, no new dependency**):

- **A. Live chat-group reordering.** The sidebar's chat-group order comes from server SQL (`ORDER BY updated_at DESC`) and is frozen until the next React Router loader revalidation — so sending a message doesn't move the group until you navigate somewhere, and then the list snaps to a new order with no animation (the jarring reorder-on-page-click). Fix in two parts:
  - **A1 (data):** derive the order client-side in `ChatGroupsProvider` from data it *already overlays live* — the moment you hit send, the group's effective recency becomes "now" and it sorts to the top.
  - **A2 (animation):** a small hand-rolled FLIP hook animates **every** order change — rows glide to their new slots instead of teleporting. This also makes revalidation-driven reorders (the current page-click snap) smooth for free.
- **B. Expand/collapse polish.** The collapsed-only section separators are toggled with `display: none ↔ block` and no transition, so on collapse they pop in **at frame 0 at nearly the full 16rem width** while everything else animates over 200ms. Fix: a staggered cross-fade (labels hand off to separators) using Tailwind v4 discrete transitions + `@starting-style`. Two follow-on polish items (chat-row internals, button timing normalization) are specified separately and are cuttable.

Ship order: A1 → A2 → B1 are the required core; B2 recommended; B3 optional.

---

## Background: how it works today

### Ordering (workstream A)

- **Server sort.** The `routes/_app` loader (`src/routes/_app.tsx:175-184`) streams `chatGroups: Promise<ChatGroupView[]>` from `listGroupsForWorkspace` (`src/lib/chat-groups.server.ts:276-303`), which runs, in the UserDO (`workers/main/src/identity/user-do.ts:1252-1272`):

  ```sql
  SELECT * FROM chat_groups WHERE org_id = ? AND workspace_id = ?
  ORDER BY updated_at DESC LIMIT ?
  ```

- **The client never re-sorts.** `ChatGroupsProvider` (`src/hooks/use-chat-groups.tsx`) resolves that promise and produces `groups` through a memo (`use-chat-groups.tsx:1621-1657`) that only *maps* to overlay live patches (avatar, thread status, summary). Display order === loader order, always.
- **What bumps the server key.** When a user message lands, `ChatThreadDO` calls `touchGroupForThread` (`workers/main/src/chat-thread/metadata.ts:290-309` → `user-do.ts:1822-1831`), which sets `chat_groups.updated_at = now`. So "ordered by most recent user-sent message" is (approximately) the existing semantic — the server key just doesn't reach the client until a revalidation.
- **When revalidation happens.** Navigation (`shouldRevalidate` default-true, `_app.tsx:39-64`), explicit `useRevalidator` calls (close group, move thread, rename…), and the workspace **status WebSocket** (`use-chat-groups.tsx:1304`) which debounce-revalidates 750ms after `thread_status` frames — but **deliberately skips frames for the currently active thread** unless they carry summary metadata (`use-chat-groups.tsx:1588-1598`). That skip is why sending a message in the chat you're looking at never reorders the sidebar until you click away.
- **The client already knows about the send, instantly.** `Chat.tsx` `sendMessage` dispatches a `camelai:thread-status` window event at the moment of send (`src/components/Chat.tsx:3651-3658`) carrying `latestUserMessageAt: Date.now()` and `runningStartedAt`. The provider already consumes it (`handleLocalThreadStatus`, registered near `use-chat-groups.tsx:1227`) and `applyLiveRunningStatuses` (`use-chat-groups.tsx:617`) already folds it into each thread: `thread.latest_user_message_at` and `thread.last_active_at` are live-updated (`use-chat-groups.tsx:695-726`). **All the data for an immediate reorder is already in the memo — nothing sorts on it.** That is the entire gap.
- **Render loop.** `ChatGroupsList` (`src/components/sidebar/chat-groups-list.tsx:189-278`): `<SidebarMenu>` (a `ul`, `gap-px` flex column) → `groups.map(...)` → `<SidebarMenuItem key={group.id}>` (a `li`, `relative`, fixed-height rows: `size="sm"` button = `h-7`). Keys are stable group ids — ideal for FLIP.

### Expand/collapse (workstream B)

- Mode is `collapsible="icon"` (`src/components/sidebar/app-sidebar.tsx:98`): 16rem (`--sidebar-width`) ↔ 3rem (`--sidebar-width-icon`). The gap + fixed container transition width with **`duration-200 ease-linear`** (`src/components/ui/sidebar.tsx:218, 229`). `data-collapsible="icon"` is written on the `group peer` wrapper the instant React state flips (`sidebar.tsx:209`); every `group-data-[collapsible=icon]:*` variant switches on that same frame.
- **Section labels leave smoothly**: `SidebarGroupLabel` has `transition-[margin,opacity] duration-200 ease-linear group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0` (`sidebar.tsx:409`).
- **Separators pop.** Both collapsed-only separators (`app-sidebar.tsx:120` and `:161`) are:

  ```
  my-1 hidden group-data-[collapsible=icon]:block data-[orientation=horizontal]:w-auto
  ```

  `display` is not animatable, so on collapse the separator appears **on the first frame, at full opacity, at the container's still-≈16rem width**, then rides the width animation down. The label it visually replaces fades over 200ms; the separator hard-cuts in at 0ms. That asymmetry is the flash.
- Other frame-0 pops in the same toggle (workstream B2): the chat-group row's name span and count slot are `group-data-[collapsible=icon]:hidden` (`chat-groups-list.tsx:233, 85`), and the avatar swaps between two separately-mounted sizes — `sm` (20px, hidden when collapsed, `chat-groups-list.tsx:115`) and an `md` (24px) collapsed-only layer (`chat-groups-list.tsx:117`).
- Menu buttons clamp to a 32px square via `group-data-[collapsible=icon]:size-8!` with `transition-[width,height,padding,background-color,color]` and **no explicit duration** — Tailwind's default ~150ms/ease vs. the shell's 200ms/linear (workstream B3).

---

## Workstream A — chat groups reorder live, with animation

### A1. Client-side order (data)

**File: `src/hooks/use-chat-groups.tsx`** — two new exported pure helpers (place near `mergeActiveChatGroup`, `use-chat-groups.tsx:267`), plus a two-line change to the memo.

```ts
/**
 * Effective recency for display ordering. Must only run AHEAD of the server's
 * `chat_groups.updated_at` for events that also bump the server key — a user
 * message landing bumps `updated_at` via touchGroupForThread, and the same
 * send live-patches `latest_user_message_at` on the thread. Anything broader
 * (e.g. thread.last_active_at, which also moves on assistant activity) would
 * make the client order disagree with the next revalidation and bounce rows.
 */
export function getChatGroupRecency(group: ChatGroupView): number {
  let recency = group.updated_at;
  for (const thread of group.open_threads) {
    const sentAt = thread.latest_user_message_at ?? 0;
    if (sentAt > recency) recency = sentAt;
  }
  return recency;
}

export function orderChatGroupsForDisplay(
  groups: ChatGroupView[],
  pinnedFirstGroupId: string | null = null,
): ChatGroupView[] {
  const sorted = [...groups].sort(
    (a, b) => getChatGroupRecency(b) - getChatGroupRecency(a),
  );
  if (pinnedFirstGroupId !== null) {
    const index = sorted.findIndex((group) => group.id === pinnedFirstGroupId);
    if (index > 0) {
      const [pinned] = sorted.splice(index, 1);
      sorted.unshift(pinned);
    }
  }
  return sorted;
}
```

Wire it into the existing `groupsBeforePendingExpiry` memo (`use-chat-groups.tsx:1621-1648`) as the **last** step, after all overlays (the live `latest_user_message_at` patch must be applied before sorting). Dependency array unchanged:

```ts
const groupsBeforePendingExpiry = useMemo(() => {
  const loaderGroups = resolvedChatGroups ?? [];
  const activeGroup = getActiveChatGroupFromMatches(matches);
  const activeGroupWasMissing =
    activeGroup !== null &&
    !loaderGroups.some((group) => group.id === activeGroup.id);
  const source = mergeActiveChatGroup(loaderGroups, activeGroup);
  const avatarPatchedSource = applyLocalGroupAvatarPatches(
    source,
    localGroupAvatarPatches,
  );
  const withLiveStatuses = applyLiveRunningStatuses(
    avatarPatchedSource,
    runningThreadIds,
    hasStatusSnapshot,
    activeThreadId,
    resolvedThreadStatuses,
    localThreadSummaryPatches,
  );
  return orderChatGroupsForDisplay(
    withLiveStatuses,
    activeGroupWasMissing ? activeGroup.id : null,
  );
}, [ /* unchanged */ ]);
```

Design decisions the implementer should not revisit:

- **Sort key is `max(group.updated_at, open threads' latest_user_message_at)`** — see the doc comment above. This is the anti-flicker invariant: after the next revalidation the server's `updated_at` lands at ≈ the same timestamp the client used, so the row *stays put* instead of animating up and then bouncing back down. `closed_threads` are excluded (a user message can't land in a closed thread; reopening triggers a revalidation anyway).
- **The `pinnedFirstGroupId` exception** preserves today's `mergeActiveChatGroup` behavior: when the active group is *missing* from the (LIMIT-bounded) loader list, it is prepended and must stay visibly at the top — a strict recency sort would sink it below the fold. Pin only in that missing case; when the active group is in the loader list it sorts by recency like everything else.
- **Do not change the revalidation scheduling** (`scheduleStatusRevalidate`, `shouldRevalidateThreadStatusUpdate`, the active-thread skip). The client-side sort makes the skip harmless; forcing `includeActive` revalidation per send would add loader churn for no visual gain.
- **Other consumers of `useChatGroups().groups`** are order-independent lookups (`.find`/`Map` by id) at `src/routes/_app.chat.$id.tsx:981, 1109-1111` and `src/routes/_app.chat._index.tsx:1077, 1081` — with one exception: the move-to-group picker fallback (`_app.chat.$id.tsx:1112-1120`) inherits list order and will now show most-recent-first. That is acceptable/desirable; no change needed.

### A2. FLIP animation hook

**New file: `src/hooks/use-flip-list.ts`.** No dependency — the repo has no motion library (Tailwind + `tw-animate-css` + WAAPI only), and one vertical list with stable keys and fixed-height rows is the textbook FLIP case.

Contract: children of `listRef` that carry `data-flip-id` are measured every render via `offsetTop` (transform- and container-scroll-immune — `SidebarMenuItem` is `relative`, its `offsetParent` is the `relative` `SidebarGroup`, a consistent basis). When the caller-provided `orderKey` changes, each surviving row animates from its previous visual position to its new layout position with a WAAPI transform.

```ts
import { useLayoutEffect, useRef, type RefObject } from "react";

const FLIP_DURATION_MS = 300;
const FLIP_EASING = "cubic-bezier(0.2, 0, 0, 1)";

/**
 * FLIP-animates vertical reordering of a list's children. Children must carry
 * a stable `data-flip-id`. Only reorders animate: first mount, insertions, and
 * removals render in place. No-ops under prefers-reduced-motion and in
 * environments without WAAPI (jsdom).
 */
export function useFlipList(
  listRef: RefObject<HTMLElement | null>,
  orderKey: string,
): void {
  const positionsRef = useRef<Map<string, number>>(new Map());
  const prevOrderKeyRef = useRef<string | null>(null);
  const animationsRef = useRef<Map<string, Animation>>(new Map());

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const items = Array.from(
      list.querySelectorAll<HTMLElement>("[data-flip-id]"),
    );
    const supportsWaapi =
      typeof Element !== "undefined" &&
      typeof Element.prototype.animate === "function";
    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const orderChanged =
      prevOrderKeyRef.current !== null && prevOrderKeyRef.current !== orderKey;

    if (orderChanged && supportsWaapi && !reduceMotion) {
      for (const el of items) {
        const id = el.dataset.flipId;
        if (!id) continue;
        const stored = positionsRef.current.get(id);
        if (stored === undefined) continue; // new item: appear in place
        const last = el.offsetTop;
        let first = stored;
        const running = animationsRef.current.get(id);
        if (running && running.playState === "running") {
          // Interrupted mid-flight: resume from the currently painted spot.
          const transform = getComputedStyle(el).transform;
          if (transform && transform !== "none") {
            first = stored + new DOMMatrixReadOnly(transform).m42;
          }
          running.cancel();
        }
        const delta = first - last;
        if (Math.abs(delta) < 1) continue;
        const animation = el.animate(
          [{ transform: `translateY(${delta}px)` }, { transform: "none" }],
          { duration: FLIP_DURATION_MS, easing: FLIP_EASING },
        );
        animation.finished.catch(() => {}); // cancel() rejects; expected
        animationsRef.current.set(id, animation);
      }
    }

    positionsRef.current = new Map(
      items
        .filter((el) => el.dataset.flipId)
        .map((el) => [el.dataset.flipId as string, el.offsetTop]),
    );
    prevOrderKeyRef.current = orderKey;
  });
}
```

Notes for the implementer (the *why* behind each line, so nothing gets "simplified" away):

- **The effect runs on every render, with no dependency array** — it must refresh `positionsRef` even when the order didn't change, so the "first" positions are never stale. The work is a handful of `offsetTop` reads; the list is small.
- **`offsetTop`, not `getBoundingClientRect`**: `offsetTop` reports the layout box (ignores the in-flight transform, immune to `SidebarContent` scroll), so "last" is always the true destination slot.
- **The interruption branch** (`running.playState === "running"`) handles a second reorder landing mid-animation: the previous stored position plus the current computed `translateY` (`DOMMatrixReadOnly(...).m42`) is the row's *currently painted* position, so the new animation takes over without a visible jump. Read the transform **before** `cancel()`.
- **Only surviving rows animate.** New ids (`stored === undefined`) mount in place; removed ids simply disappear and the rows below them slide up via their own deltas. Do not add enter/exit animations here.
- The WAAPI animation is fire-and-forget (`fill` defaults to `none`, so no lingering styles) — no `transitionend` bookkeeping, no cleanup on unmount needed beyond letting animations finish.

**Wiring — `src/components/sidebar/chat-groups-list.tsx`:**

```tsx
// top of ChatGroupsList, with the other hooks (before the early returns):
const menuRef = useRef<HTMLUListElement | null>(null);
useFlipList(menuRef, groups.map((group) => group.id).join("\n"));
```

```tsx
<SidebarMenu ref={menuRef}>          {/* main list only, chat-groups-list.tsx:191 */}
  ...
  <SidebarMenuItem key={group.id} data-flip-id={group.id}>   {/* :195 */}
```

Both primitives spread `...props` onto their `ul`/`li` (`sidebar.tsx:455-470`), and this is React 19, so `ref` and `data-flip-id` pass through without touching `sidebar.tsx`. Do **not** attach the ref to the skeleton-state `SidebarMenu`; the hook no-ops while `listRef.current` is null, and the skeleton→data swap must not animate.

### What the user sees

```
t=0: user hits ⏎ in "Marketing site"            t≈300ms: settled
┌──────────────────────────────┐            ┌──────────────────────────────┐
│ + New chat                   │            │ + New chat                   │
│ WORKSPACE                    │            │ WORKSPACE                    │
│   ⌂ Chat History …           │            │   ⌂ Chat History …           │
│ CHAT GROUPS                  │            │ CHAT GROUPS                  │
│   ◇ Data pipeline         3  │ ─┐ slides  │   ◆ Marketing site     ⟳ 2  │ ← glided to top
│   ◇ Landing page          1  │  │ down    │   ◇ Data pipeline         3  │
│   ◆ Marketing site        2  │ ─┘ ↑↑↑     │   ◇ Landing page          1  │
│   ◇ Q3 report             5  │ (stays)    │   ◇ Q3 report             5  │
└──────────────────────────────┘            └──────────────────────────────┘
  All four rows move at once: the sent group translates up over the two rows
  above it; those two slide down one slot; rows below the old position stay.
  300ms, cubic-bezier(0.2, 0, 0, 1). Same animation fires for reorders that
  arrive via revalidation (page clicks, other tabs, Slack/email ingress).
```

---

## Workstream B — expand/collapse polish

### B1. Separator ↔ label cross-fade (required — the reported bug)

Target design — a **staggered baton pass** on the shell's existing 200ms/linear timeline:

```
COLLAPSE (width 16rem → 3rem over 200ms, ease-linear)

0ms                     100ms                    200ms
│ WORKSPACE…(fading)    │ (label gone)           │
│ opacity 1→…, -mt-8    │      ── ─ (fading in)  │ ────   ← separator at 3rem
│ (separator: none)     │ separator appears,     │ full opacity, rail width
│                       │ opacity 0→1            │
width: 16rem            ~9.5rem                  3rem

EXPAND (3rem → 16rem over 200ms)

0ms                     100ms                    200ms
│ ──── (fading out)     │ (separator gone)       │ WORKSPACE   ← label settled
│ opacity 1→0 quickly   │ label sliding in       │
```

The label side already animates (`SidebarGroupLabel`, `sidebar.tsx:409`) — **only the two separator instances change**. Replace the `className` at **`app-sidebar.tsx:120`** and **`app-sidebar.tsx:161`** (identical strings today) with:

```
my-1 hidden opacity-0 starting:opacity-0 transition-[display,opacity] transition-discrete duration-100 ease-linear group-data-[collapsible=icon]:block group-data-[collapsible=icon]:opacity-100 group-data-[collapsible=icon]:delay-100 motion-reduce:transition-none data-[orientation=horizontal]:w-auto
```

How each piece works (Tailwind v4 core utilities; keep them all):

| Utility | Role |
| --- | --- |
| `hidden` / `group-data-[collapsible=icon]:block` | unchanged final states — expanded layout still has zero separator space |
| `transition-[display,opacity] transition-discrete` | `transition-behavior: allow-discrete` lets `display` participate: on **expand**, `display:none` is deferred to the end of the fade (so the fade-out is visible); on **collapse**, `display:block` applies up front |
| `opacity-0` / `group-data-[collapsible=icon]:opacity-100` | the animatable property |
| `starting:opacity-0` | `@starting-style` — required for the fade-**in**: an element coming from `display:none` has no prior rendered style, so without this the opacity would jump straight to 1 |
| `duration-100` + `group-data-[collapsible=icon]:delay-100` | the stagger. Transition timing is read from the destination state: collapsing → fade in during the **second half** (100→200ms, after the labels are mostly gone and the rail is near its final 3rem — this is what kills the "full-width line" artifact); expanding → no delay, quick 100ms fade-out so the line never visibly rides the growing width |
| `motion-reduce:transition-none` | reduced-motion = today's instant toggle |

Degradation: browsers without `@starting-style`/`allow-discrete` (pre-2024) get exactly today's behavior — no regression. If the stacked variants misbehave in the Tailwind build (verify by toggling in the browser, not just by compiling), the fallback is the same declarations as plain CSS on `[data-slot="sidebar-separator"]` in `src/styles/shadcn-theme.css` — but try the utility form first; it should compile as-is.

Keep the two explanatory comments above each separator (`app-sidebar.tsx:117-119, 158-160`); extend them with one line noting the staggered fade if you like. Since the two class strings must stay identical, hoist them into a module-level `const collapsedRailSeparatorClassName = "..."` in `app-sidebar.tsx` and use it for both.

### B2. Chat-row internals join the same timeline (recommended, independently cuttable)

Three frame-0 pops inside each chat-group row, all in `src/components/sidebar/chat-groups-list.tsx`:

**(a) Group name span** (`chat-groups-list.tsx:233`) — fades out in the first 100ms of a collapse (then `display:none` frees its flex space so the avatar centers), fades in on expand:

```
min-w-0 flex-1 truncate text-left starting:opacity-0 transition-[display,opacity] transition-discrete duration-100 ease-linear group-data-[collapsible=icon]:hidden group-data-[collapsible=icon]:opacity-0 motion-reduce:transition-none
```

**(b) Count/status right slot** — same recipe appended to the outer span of `ChatGroupRightSlot` (`chat-groups-list.tsx:85`):

```
ml-auto flex shrink-0 items-center gap-1.5 text-xs tabular-nums text-muted-foreground starting:opacity-0 transition-[display,opacity] transition-discrete duration-100 ease-linear group-data-[collapsible=icon]:hidden group-data-[collapsible=icon]:opacity-0 motion-reduce:transition-none
```

(The inner count span's existing `transition-opacity group-hover/menu-item:opacity-0 …` hover behavior at `:97` is unrelated — leave it.)

**(c) Avatar size swap** (`ChatGroupIcon`, `chat-groups-list.tsx:106-136`). Today two separately-mounted avatars display-toggle (sm = `size-5` container, md = `size-6`; sizes from `src/components/ui/avatar.tsx`). Restack them in one grid cell so they can pure-opacity cross-fade (no discrete-display tricks needed — both stay mounted, exactly as many renders as today), while the wrapper morphs 20px→24px:

```tsx
export function ChatGroupIcon({ group }: { group: ChatGroupView }) {
  const isRunning = group.status === "running";
  const isUnread = group.status === "unread";
  return (
    <span className="relative grid size-5 shrink-0 place-items-center transition-[width,height] duration-200 ease-linear group-data-[collapsible=icon]:size-6 motion-reduce:transition-none">
      <ChatGroupAvatar
        avatar={group.avatar}
        fallbackName={group.name}
        size="sm"
        className="col-start-1 row-start-1 transition-opacity duration-100 ease-linear group-data-[collapsible=icon]:opacity-0 motion-reduce:transition-none"
      />
      <span className="col-start-1 row-start-1 relative size-6 opacity-0 transition-opacity duration-100 ease-linear group-data-[collapsible=icon]:opacity-100 group-data-[collapsible=icon]:delay-100 motion-reduce:transition-none">
        <ChatGroupAvatar
          avatar={group.avatar}
          fallbackName={group.name}
          size="md"
        />
        {isRunning ? (
          /* …running overlay exactly as today (chat-groups-list.tsx:123-126)… */
        ) : isUnread ? (
          /* …unread dot exactly as today (chat-groups-list.tsx:127-132)… */
        ) : null}
      </span>
    </span>
  );
}
```

The component changes from a fragment of two siblings to a single wrapper — the button's flex row (`icon | name | right-slot`) is unaffected. Timeline on collapse: sm avatar fades out 0–100ms, md layer (with its running/unread badge) fades in 100–200ms, wrapper grows 20→24px across the full 200ms. `ChatGroupCollapsedIcon` (`chat-groups-list.tsx:138-147`) is unused by this list — leave it alone.

The "No groups yet" empty state (`chat-groups-list.tsx:180`) keeps its instant `group-data-[collapsible=icon]:hidden` — it's static text, not part of the toggle choreography.

### B3. Menu-button timing normalization (optional)

`sidebarMenuButtonVariants` (`src/components/ui/sidebar.tsx:474`) animates the icon-clamp (`size-8!`) with Tailwind's default ~150ms/ease while the shell runs 200ms/linear, so buttons finish clamping ~50ms before the rail settles. If taking this: append `duration-200 ease-linear` to the base cva string (after `transition-[width,height,padding,background-color,color]`). Side effect to accept knowingly: hover background fades on **all** sidebar menu buttons go from ~150ms/ease to 200ms/linear — a barely-perceptible change, but it is global to the sidebar. If any doubt during review, cut this item; it is cosmetic alignment only.

---

## File-by-file change list

| File | Workstream | Change | Status |
| --- | --- | --- | --- |
| `src/hooks/use-chat-groups.tsx` | A1 | Add `getChatGroupRecency` + `orderChatGroupsForDisplay` (exported, pure); call as the final step of the `groupsBeforePendingExpiry` memo with the missing-active-group pin | Required |
| `src/hooks/use-flip-list.ts` (new) | A2 | The FLIP hook as specified | Required |
| `src/components/sidebar/chat-groups-list.tsx` | A2 | `menuRef` + `useFlipList` + `data-flip-id` on `SidebarMenuItem` | Required |
| `src/components/sidebar/app-sidebar.tsx` | B1 | Replace both separator class strings (`:120`, `:161`) with the staggered-fade recipe (hoisted const) | Required |
| `src/components/sidebar/chat-groups-list.tsx` | B2 | Name span + right-slot fade classes; `ChatGroupIcon` grid cross-fade restructure | Recommended |
| `src/components/ui/sidebar.tsx` | B3 | `duration-200 ease-linear` on `sidebarMenuButtonVariants` | Optional |
| `tests/chat-groups-recency.test.ts` (new) | A1 | Pure-helper tests | Required |
| `tests/use-flip-list.test.tsx` (new) | A2 | Hook tests with stubbed WAAPI | Required |

No `workers/` changes. No `wrangler` changes. No new dependencies.

---

## Do NOT touch

- **Server ordering and bumping** — the UserDO SQL (`user-do.ts:1252-1272`), `touchGroupForThread`, and thread metadata writes. The server key stays authoritative; the client only runs ahead of it between revalidations.
- **Revalidation scheduling** — `scheduleStatusRevalidate`, `shouldRevalidateThreadStatusUpdate`, the 750ms debounce, and the active-thread skip (`use-chat-groups.tsx:1588-1598`). A1 makes the skip harmless.
- **`mergeActiveChatGroup` internals** (`use-chat-groups.tsx:267-281`) — the pin in `orderChatGroupsForDisplay` composes with it; don't fold sorting into it.
- **`SidebarGroupLabel`'s existing animation** (`sidebar.tsx:409`) and the sidebar shell's width transitions/tokens (200ms, `ease-linear`, `--sidebar-width*`). B1 syncs *to* them.
- **No motion library** (framer-motion/`motion`), and **no View Transitions API** for the reorder — view transitions would need `flushSync` wrapping of provider state updates that fire from window events and sockets; the FLIP hook is strictly more targeted.
- The `Chat.tsx` send path and `dispatchLocalThreadStatus` payloads — already emit exactly what A1 needs.

---

## Edge cases

- **First paint / skeleton→data swap:** `prevOrderKeyRef` is null (or the ref isn't attached) → positions recorded, nothing animates. Correct.
- **Workspace switch:** all ids change → every row is "new" → renders in place, no cross-workspace animation.
- **Group closed / removed:** its id leaves the orderKey; remaining rows FLIP up into the gap. The removed row itself just unmounts (no exit animation, by design).
- **Rapid sends / steers in the group already at top:** recency changes but the id order doesn't → orderKey identical → no animation churn.
- **Send interrupting an in-flight reorder:** handled by the interruption branch (resume from painted position); verify by sending in two groups back-to-back.
- **Collapsed rail:** rows are icon-only but still a vertical list of the same `li`s — the FLIP animates avatars gliding up/down the rail identically. B1's fade means a mid-animation toggle composes fine (both are transform/opacity-only).
- **Browser clock skew:** the local bump uses browser `Date.now()` vs. the server's clock in `updated_at`. A skewed-behind browser could under-rank a fresh send relative to another group's server timestamp from the skew window. Self-heals at the next revalidation; not worth plumbing server time.
- **Remote activity (other tab, teammate, Slack/email ingress):** arrives via status-socket frames; if the frame carries `latestUserMessageAt` metadata the reorder is immediate, otherwise it lands with the debounced revalidation ≤ ~750ms later — animated either way.
- **Hover card open while its row moves:** Radix content is portaled and won't chase the transform for the ≤300ms flight. Reorders fire on send (focus is in the composer, not hovering the sidebar), so this is theoretical; do nothing.
- **jsdom:** `tests/chat-groups-ui.test.tsx` renders `ChatGroupsList`; jsdom has no `Element.prototype.animate` — the `supportsWaapi` guard exists precisely so those tests keep passing untouched.
- **`prefers-reduced-motion`:** A2 skips transforms (order still snaps correctly); B1/B2 carry `motion-reduce:transition-none` → exactly today's instant toggle.

---

## Tests

### `tests/chat-groups-recency.test.ts` (new — pure helpers, no DOM)

Build minimal `ChatGroupView` fixtures (only the fields the helpers read: `id`, `updated_at`, `open_threads[].latest_user_message_at`).

- `getChatGroupRecency`: returns `updated_at` with no threads; an open thread's newer `latest_user_message_at` wins; older ones don't; `null` timestamps are safe; `closed_threads` are ignored.
- `orderChatGroupsForDisplay`: sorts descending by recency; **ties keep input (server) order** (stability guard); the live-bump scenario — group B below group A, then B gets a thread `latest_user_message_at` newer than A's `updated_at` → B first.
- Pin: `pinnedFirstGroupId` moves that group to index 0 without disturbing the relative order of the rest; an id not in the list is a no-op; `null` is a no-op.

### `tests/use-flip-list.test.tsx` (new — hook with stubbed WAAPI)

jsdom lacks WAAPI and layout, so stub both: `Element.prototype.animate = vi.fn(() => ({ cancel: vi.fn(), finished: Promise.resolve(), playState: "finished" }))` and mock `offsetTop` per item (e.g. `Object.defineProperty` with values derived from a layout table the test controls). Render a plain `ul` of `li[data-flip-id]` driven by the hook.

- Reorder (swap two items, update mocked offsets): `animate` called on moved items with `translateY(<signed delta>px)` → `transform: "none"`, and **not** called on unmoved items.
- First render: no `animate` calls.
- New item appended: no `animate` call for it.
- `matchMedia` mocked to reduced-motion: no calls.
- Same orderKey re-render: no calls.

### Existing tests

- `tests/chat-groups-ui.test.tsx` must pass unmodified (the `supportsWaapi` guard). Add one rerender-with-reversed-groups assertion there if cheap: DOM order follows the `groups` prop.
- No worker tests are affected (no `workers/` changes).

Run: `bun run typecheck && bun run test:run -- tests/chat-groups-recency.test.ts tests/use-flip-list.test.tsx tests/chat-groups-ui.test.tsx`

### Manual verification (dev server, `bun run dev`)

1. Two+ chat groups; open a chat in a group that is *not* at the top; send a message → the group glides to the top immediately (no navigation), others slide down.
2. Click to another page after background activity → order changes animate instead of snapping.
3. Toggle collapse (`⌘B`) both directions → labels and separators cross-fade in sequence; no full-width line flash. Repeat mid-animation (double-tap ⌘B).
4. With B2: watch a chat row during toggle — text fades, avatars cross-fade, nothing pops.
5. OS reduced-motion on → everything snaps instantly, no broken states.

---

## Implementation order

1. **A1** — helpers + memo sort (+ its tests). Independently shippable: order becomes live everywhere, reorders still snap.
2. **A2** — FLIP hook + wiring (+ its tests). Reorders now animate.
3. **B1** — separator stagger. Independently shippable; verify in-browser, not just by compile.
4. **B2** — row-internals polish (cut freely if anything looks off in review).
5. **B3** — optional timing normalization, last, with the hover-fade side effect called out in the PR.

---

## Out of scope (noticed while planning)

- `src/components/ui/sidebar.tsx` contains a find/replace corruption: the `collapsible` default and variants read `"offExamples"` instead of `"offcanvas"` (`sidebar.tsx:154, 161, 219, 231-232, 296-298`). Inert for this app (it always passes `collapsible="icon"`), but worth a separate two-token cleanup PR. Do not bundle it here.
- Persisting live order server-side more aggressively (e.g. bumping `updated_at` on assistant completion) — changes ordering semantics; not needed for this polish.
- Enter/exit animations for group creation/close, and `NavUser`/`WorkspaceSwitcher` text fades — deliberately untouched to keep this change reviewable.
