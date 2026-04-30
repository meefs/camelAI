# @ Mention Menu — Implementation Feedback

**Date:** 2026-04-29
**Branch:** `illianaa/at-menu-connections`
**Reviewing commit:** `c5e6330b Add @-mention menu for connections in chat input`

---

## TL;DR

Three real bugs and one wrong route. Plus two latent correctness issues in the keyboard-handling code that will surface as "selected the wrong connection on Enter" once the data flow is fixed.

| # | Severity | Issue |
|---|---|---|
| 1 | **Blocker** | Welcome screen (`/chat` new chat) never enables the menu — `WelcomeScreen` doesn't pass `mentionableConnections` / `onMentionAddNewClick` to its `<PromptInput>`. |
| 2 | **Blocker** | Active-thread route (`_app.chat.$id.tsx`) doesn't load `welcomeData.connections`, so the active-chat composer always sees `[]` and the menu shows the empty discovery state instead of real connections. |
| 3 | **Bug** | "Add a connection" CTA navigates to `/settings/workspace/connections`. Should navigate to `/connections`. |
| 4 | **Bug (latent)** | The mention menu and the parent's keyboard handler use **two different filter functions** over the same connection list, so highlighted ↔ inserted item can desync. |
| 5 | **Bug (latent)** | Parent's `filteredMentionConnections` doesn't include matches against the registry `displayName`, but the menu's `rankConnections` does. Users who type a registry display name see results highlighted that Enter can't select. |
| 6 | **Inconsistency** | `Chat.tsx:4444` reads `welcomeData?.connections` (raw prop) while the slug map at line 1573 reads `resolvedWelcomeData.connections` (with fallback). One of these can be a different list at runtime. |

---

## Bug 1 — Menu doesn't show on `/chat` (new-chat / welcome screen)

**Root cause:** `WelcomeScreen` renders its own `<PromptInput>` and never passes the new mention props.

**File:** `src/components/welcome-screen/index.tsx`

```tsx
// Line ~408
<PromptInput
  textareaRef={textareaRef}
  value={inputValue}
  onChange={onPromptChange}
  onSubmit={onSubmit}
  ...
  modelDisabled={isCreatingThread}
  // ← missing: mentionableConnections, onMentionAddNewClick
/>
```

The component already has the data — `connections: Integration[]` is one of its props (line 194), and the file imports / uses `useNavigate` (line 339).

**Fix:**

```tsx
<PromptInput
  ...existing props...
  mentionableConnections={connections}
  onMentionAddNewClick={() => navigate('/connections')}
/>
```

---

## Bug 2 — Connections don't populate the menu in an active chat

**Root cause:** The active-thread route mounts `<Chat>` without `welcomeData`, so `welcomeData?.connections` is `undefined` → `[]`.

**File:** `src/routes/_app.chat.$id.tsx` (line ~335)

```tsx
<Chat
  key={threadId}
  threadId={threadId}
  workspaceId={workspaceId}
  initialMessages={chatData.messages}
  ...
  // ← no welcomeData / no connections prop at all
/>
```

Compare to `_app.chat._index.tsx:133-141` which already loads `connections` via `WORKSPACE.getIntegrations()` and passes them through `welcomeData`. The active-thread route needs the same loader fetch and the same wire-through.

**Fix (recommended):** load connections in `_app.chat.$id.tsx`'s loader (mirror lines 133-141 of `_app.chat._index.tsx`) and pass them into `<Chat>`. Since the rest of `welcomeData` (apps, recent threads, etc.) isn't relevant to an active thread, consider adding a dedicated `connections?: Integration[]` prop on `<Chat>` rather than reusing the `welcomeData` shape — see "Bug 6" below for a cleaner version of this.

If a dedicated prop is preferred, then in `Chat.tsx`:

```tsx
interface ChatProps {
  ...existing...
  connections?: Integration[];   // NEW — independent of welcomeData
}

// Replace both reads:
//   resolvedWelcomeData.connections (line 1573)  ← used for rendering chips in the bubble
//   welcomeData?.connections ?? []  (line 4444)  ← used by composer mention menu
// with a single source:
const mentionConnections = connections ?? welcomeData?.connections ?? [];
```

Then both `mentionSlugMap` and the composer's `mentionableConnections` use `mentionConnections`. This also fixes Bug 6.

---

## Bug 3 — "Add a connection" navigates to the wrong page

**File:** `src/components/Chat.tsx:4445`

```tsx
onMentionAddNewClick={() => navigate('/settings/workspace/connections')}
```

`/settings/workspace/connections` is the workspace-level settings view. The user-facing connections hub (full list + add/edit) is `/connections`. The welcome screen already links to that route (`linkHref="/connections"` in `welcome-screen/index.tsx:449`).

**Fix:** change to `navigate('/connections')`. Apply the same fix in the welcome-screen wiring from Bug 1.

---

## Bug 4 — Highlight / insertion can desync because the menu and parent run different filters

`src/components/prompt-input.tsx` (parent) and `src/components/connection-mention-menu/index.tsx` (menu) each compute their own filtered list, with different rules.

**Parent filter (`prompt-input.tsx:558-567`):**

```ts
const filteredMentionConnections = useMemo(() => {
  const q = mentionTrigger.query;
  const all = mentionableConnections ?? [];
  if (!q) return all;                              // ← unsorted
  return all.filter((c) => {
    const name = c.name.toLowerCase();
    const type = c.integration_type.toLowerCase();
    return name.includes(q) || type.includes(q);   // ← substring only
  });
}, [mentionableConnections, mentionTrigger.query]);
```

**Menu filter (`connection-mention-menu/index.tsx:105-141`):**

```ts
function rankConnections(connections, query) {
  // sorts alphabetically when query is empty;
  // tiers prefix matches above substring matches;
  // ALSO matches against getIntegrationDefinition(...).displayName
  ...
}
```

These produce different orderings and (per Bug 5) different memberships. The parent uses **its** list to:

- decide whether to dismiss the menu (`matchesAvailable` → `hasMatches`)
- handle ↑/↓ (`filteredMentionConnections.findIndex(c => c.id === activeMentionId)`)
- handle Enter (`filteredMentionConnections.find(...) ?? filteredMentionConnections[0]!`)

The menu's `useEffect` autoselects the first item from its **own** ranked list. Result: the visually highlighted row in the menu and the Enter-target in the parent disagree — Enter inserts the wrong connection, and ↑/↓ from the highlighted item jumps somewhere unexpected.

**Fix:** centralize the filter. The cleanest version is to lift `rankConnections` into `src/lib/connection-mentions.ts` (or the menu module) and have both the menu and the parent import the same function. The parent's keyboard handler should iterate the same ranked array the menu renders.

Suggested shape:

```ts
// in connection-mentions.ts (or a new sibling)
export function rankMentionableConnections(
  connections: Integration[],
  query: string,
): Integration[] { ... }
```

Then `prompt-input.tsx` builds `filteredMentionConnections = rankMentionableConnections(mentionableConnections ?? [], query)` and the menu uses the same call (or, even better, the parent passes the already-ranked list down as a prop and the menu becomes purely presentational).

---

## Bug 5 — Registry `displayName` matches don't survive the parent filter

Sub-case of Bug 4, but worth calling out independently. A user with a connection of type `postgres` and a custom name "Sales DB" who types `@postgresql` will:

- See the menu show "Sales DB" because `rankConnections` matches against the registry display name `"PostgreSQL"`.
- Press Enter and… nothing happens, because the parent's `filteredMentionConnections` filter only checks `name` and `integration_type`, so `activeMentionId` is dropped from the parent's list, the parent fallback `filteredMentionConnections[0]!` is `undefined`, and `e.preventDefault()` runs but `insertMention` never gets a target. (Actually, `filteredMentionConnections[0]!` is non-null assertion on `undefined` here — could throw at runtime; needs verification.)

**Fix:** unify the filter (Bug 4 fix covers this).

---

## Bug 6 — `welcomeData?.connections` vs `resolvedWelcomeData.connections` inconsistency

`Chat.tsx` reads connections from two different sources:

```ts
// Line 1573 — used for rendering chips in past message bubbles
const mentionSlugMap = useMemo(
  () => buildSlugMap(resolvedWelcomeData.connections) as Map<string, Integration>,
  [resolvedWelcomeData.connections],
);

// Line 4444 — used by the composer's mention menu
mentionableConnections={welcomeData?.connections ?? []}
```

`resolvedWelcomeData` falls back to `{ connections: [] }`; `welcomeData?.connections ?? []` falls back to `[]`. Today they happen to converge to the same value (both `[]`) when `welcomeData` is undefined, but anyone editing the fallback later will introduce drift. Use one source.

**Fix:** unify on a single derived `mentionConnections` (see Bug 2 fix).

---

## Code review — selection logic

The user reported they couldn't test selection. I reviewed the relevant code; here is what I found:

### What looks correct

`src/components/prompt-input.tsx:592-612` — `insertMention`:

```ts
const insertMention = useCallback((connection: Integration) => {
  if (!mentionTrigger.open) return;
  const computedSlug = slugForIntegration(connection, slugMap);
  if (!computedSlug) return;
  const before = value.slice(0, mentionTrigger.triggerStart);
  const after = value.slice(mentionTrigger.triggerEnd);
  const insertion = `@${computedSlug} `;
  const nextValue = `${before}${insertion}${after}`;
  onChange(nextValue);

  const nextCaret = before.length + insertion.length;
  requestAnimationFrame(() => {
    const ta = effectiveTextareaRef.current;
    if (!ta) return;
    ta.selectionStart = nextCaret;
    ta.selectionEnd = nextCaret;
    setCaretPos(nextCaret);
  });
  mentionLockoutValueRef.current = null;
  mentionLockoutCaretRef.current = -1;
}, [mentionTrigger, slugMap, value, onChange, effectiveTextareaRef]);
```

The slice-and-splice is correct. The caret restoration via `requestAnimationFrame` is reasonable — `onChange` schedules a state update; rAF fires after React commits the new `value` to the DOM. ✓

`Popover` keeps focus in the textarea (`onOpenAutoFocus={(e) => e.preventDefault()}`), so click-to-select on a `<CommandItem>` will fire `onSelect` (mouse events don't depend on focus). ✓

### What's broken (per Bugs 4 & 5)

Keyboard selection is unreliable. With the fixes for Bugs 4 & 5 applied, Enter / Tab / ↑↓ behave correctly. Mouse click selection works today. So once the data-flow bugs (1, 2) are fixed, mouse selection should immediately be testable; keyboard selection becomes reliable once Bugs 4/5 are fixed.

### Subtle edge case worth a note (not blocking)

`slugForIntegration` returns `null` when the integration's `name` slugs to the empty string (e.g. a name of just `"@@@"` or `"   "`). In that case, `insertMention` silently no-ops with no user feedback. Unlikely in practice but harmless to guard.

---

## Suggested fix order

1. **Bug 3** — one-line route change in `Chat.tsx` and `welcome-screen/index.tsx`.
2. **Bug 2 + Bug 6 together** — load `connections` in `_app.chat.$id.tsx` loader, add `connections?: Integration[]` prop to `<Chat>`, derive a single `mentionConnections` value used in both places. This unblocks active-chat testing.
3. **Bug 1** — pass `mentionableConnections` + `onMentionAddNewClick` to the welcome-screen's `PromptInput`. Unblocks `/chat` testing.
4. **Bugs 4 & 5** — extract a shared `rankMentionableConnections(connections, query)` and use it from both the parent's keyboard handler and the menu component.

After these, run `bun run typecheck` + `bun run test:run` and re-test the four reported user-facing scenarios:

- [ ] On `/chat` (welcome screen), typing `@` opens the menu populated with the workspace's connections.
- [ ] On an active thread, typing `@` opens the menu populated with the workspace's connections.
- [ ] Selecting a connection (mouse + keyboard Enter) inserts `@<slug> ` at the cursor and closes the menu.
- [ ] In the zero-connections state, "Add a connection" navigates to `/connections`.
- [ ] Sending a message with `@my_prod_db` causes the agent to respond using that connection's env vars (smoke-test that the `applyConnectionMentionContext` path is actually executing — log `hadMatchedMentions` once if needed).
