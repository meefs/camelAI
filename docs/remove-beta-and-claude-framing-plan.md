# Remove Beta Tag & Claude-Specific Product Framing — Plan

## Status

2026-05-29 — Draft v1 (for review)

## Goal

camelAI is no longer in beta (it is a paid product) and is no longer a
Claude-only product (we are betting on open-source models over time). This plan
removes two classes of UI copy:

1. **Beta indicators** — the sidebar "Beta" badge and the welcome-screen "early
   access beta" notice. (This is essentially the reversal of
   `docs/beta-messaging.md`, which added them.)
2. **Claude-as-the-product framing** — places where the UI implies the product
   *is* Claude (e.g. "Claude has a permanent computer here"). We keep all
   *legitimate* Claude references: the model picker, model names, and model
   providers (Anthropic / Bedrock / OpenRouter).

These are deletions and small copy edits — no new UI, no new components.

---

## Final copy (locked)

Three spots are a word swap rather than a delete. The exact strings to ship:

**1. Onboarding welcome subhead** — `src/routes/_onboarding.welcome.tsx:490`

> From: "camelAI is your AI software engineer. **Claude** has a permanent
> computer here, so **it** can build, deploy, and maintain applications for you."
>
> To: "camelAI is your AI software engineer. **Your agents** have a permanent
> computer here, so **they** can build, deploy, and maintain applications for
> you."

Plural is intentional — users can create many agents. Note both verb agreements:
"Claude **has**" → "Your agents **have**", and "so **it** can" → "so **they**
can".

**2. Computer-tab delete confirmation** — `src/components/pages/computer/computer-page-content.tsx:2441-2443`

Soften to a plain "are you sure?" — drop the agent messaging entirely. The
`DialogTitle` already reads "Delete {kind}?", so the description becomes a single
sentence:

> From:
> ```
> {dialogState.path} will be permanently removed with no way to recover it. <br></br><br></br>
> Claude may reference this elsewhere. Unless you are certain, ask Claude to handle the deletion in chat.
> ```
> To:
> ```
> {dialogState.path} will be permanently removed with no way to recover it.
> ```

Remove the second sentence and the two `<br></br>` line breaks.

**3. File-editing-disabled message** — `computer-page-content.tsx:161` and
`src/routes/api/workspaces.utils.ts:134`

> From: "File editing is disabled **during beta**."
> To: "File editing is disabled."

Keeps the read-only behavior, just drops the beta reference.

> ⚠️ **Behavioral note (confirmed):** the Computer tab stays read-only. It is
> currently hard-coded read-only (`canMutate = false`) and the file-mutation API
> routes return 403 via `blockBetaFileEdit()`. Re-enabling file editing is an
> intentional, separate decision and **won't ship for a while** — this plan only
> rewords the copy and does **not** re-enable editing.

---

## Part A — Remove beta indicators

### A1. Sidebar "Beta" badge

**File:** `src/components/sidebar/app-sidebar.tsx`

Remove the badge block in `SidebarHeader` (currently lines ~108–115):

```tsx
// DELETE this entire wrapper div:
<div className="flex px-2 transition-[justify-content] duration-200 ease-in-out" style={{ justifyContent: state === "expanded" ? "flex-start" : "center" }}>
  <Badge
    variant="secondary"
    className="text-[10px] tracking-wider font-semibold uppercase"
  >
    Beta
  </Badge>
</div>
```

After removal, `SidebarHeader` contains just `<WorkspaceSwitcher />`.

Cleanup in the same file:
- Remove the now-unused `import { Badge } from "@/components/ui/badge"` (line 18).
  `Badge` is not used anywhere else in this file — confirm with a search before
  deleting the import.
- `useSidebar()`/`state` is used elsewhere in the file for collapse behavior, so
  **leave it** — do not remove `state`. (Verify it has other references before
  touching it.)

**Before / after (expanded sidebar):**

```
   BEFORE                          AFTER
┌─────────────────────────┐    ┌─────────────────────────┐
│  🐪 My Workspace        │    │  🐪 My Workspace        │
│     Acme Inc             │    │     Acme Inc             │
│  ┌──────┐                │    ├─────────────────────────┤
│  │ BETA │   ← remove     │    │  ＋ New chat             │
│  └──────┘                │    │  Chat Groups…           │
├─────────────────────────┤    │  Workspace…             │
│  ＋ New chat             │    └─────────────────────────┘
│  Chat Groups…           │
└─────────────────────────┘
```

### A2. Welcome-screen beta notice

**File:** `src/components/welcome-screen/index.tsx`

The beta notice is the only thing wiring up the welcome screen's local help
dialog, so remove the notice *and* its now-orphaned dialog plumbing:

1. Remove the import: `import { BetaNotice } from './beta-notice';` (line 21).
2. Remove the rendered notice block (lines ~421–423):
   ```tsx
   <div className="-mt-6">
     <BetaNotice onFeedbackClick={() => setHelpOpen(true)} />
   </div>
   ```
3. Remove the now-unused `helpOpen` state: `const [helpOpen, setHelpOpen] = useState(false);` (line ~350).
4. Remove the orphaned `<GetHelpDialog ... />` render at the bottom (lines ~546–550)
   and its import (`import { GetHelpDialog } from '@/components/get-help-dialog';`, line 11).

> **Why removing GetHelpDialog here is safe:** after step 2 nothing calls
> `setHelpOpen(true)`, so the dialog is dead code. Feedback/help is still fully
> reachable from the **sidebar's "Get Help"** item (`app-sidebar.tsx`, its own
> `GetHelpDialog` instance), which is untouched. Verify `helpOpen`/`setHelpOpen`
> have no other references in this file before deleting.

**Before / after (welcome / new-chat screen):**

```
   BEFORE                                  AFTER
        Hey, Jane 👋                            Hey, Jane 👋
   What would you like to build?          What would you like to build?

  You're in the early access beta.        ┌──────────────────────────────┐
  Things may break — share feedback       │  Ask anything...    [Submit] │
        ↑ remove                          └──────────────────────────────┘
  ┌──────────────────────────────┐        Your recent chats   View all →
  │  Ask anything...   [Submit]  │        …
  └──────────────────────────────┘
  Your recent chats   View all →
```

### A3. Delete the BetaNotice component

**Delete file:** `src/components/welcome-screen/beta-notice.tsx`

It has exactly one importer (the welcome screen, removed in A2). Confirm no
other references before deleting.

### A4. Computer-tab file-editing copy (reword only — see Final copy #3)

**File:** `src/components/pages/computer/computer-page-content.tsx`

- Update the message string (line 161) per Final copy #3. The constant is
  referenced at several render sites (read-only tooltips/hints, e.g. lines
  ~1995, 2055, 2287) — all consume the constant, so editing the string value is
  enough.
- Update the inline `// File editing disabled during beta.` comment on the
  `canMutate = false` line (398) to drop "beta" (e.g. `// File editing is
  currently disabled.`). Do **not** change the `false` value.

### A5. Internal rename to drop "beta" from identifiers

Code hygiene — no user-visible effect — removes "beta" from the codebase so it
doesn't read as stale later. (Confirmed in scope; the larger diff is fine.)

- `computer-page-content.tsx`: rename constant `BETA_FILE_EDIT_DISABLED_MESSAGE`
  → `FILE_EDIT_DISABLED_MESSAGE` (and its references in the same file).
- `src/routes/api/workspaces.utils.ts`: rename `blockBetaFileEdit` →
  `blockFileEdit`, update the message string (Final copy #3) and the doc comment
  (lines 127–131). Update all importers:
  - `src/routes/api/workspaces.$id.fs.move.ts`
  - `src/routes/api/workspaces.$id.fs.write.ts`
  - `src/routes/api/workspaces.$id.fs.mkdir.ts`
  - `src/routes/api/workspaces.$id.fs.delete.ts`
  - `src/routes/api/workspaces.$id.fs.create.ts`
  - `src/routes/api/workspaces.$id.fs.upload.ts`
  - `src/routes/api/ext.files.write.ts`
  - `src/routes/api/ext.files.upload.ts`
  - Also update the `// Beta: file editing disabled...` comments at each call site.

---

## Part B — Remove Claude-specific product framing

### B1. Onboarding welcome subhead

**File:** `src/routes/_onboarding.welcome.tsx:490` — apply Final copy #1 ("Claude
has … it" → "Your agents have … they").

### B2. Computer-tab delete confirmation

**File:** `src/components/pages/computer/computer-page-content.tsx:2441-2443` —
apply Final copy #2 (soften to a single-sentence "are you sure?"; remove the
Claude/agent sentence and the `<br></br>` breaks).

### B3. Explicitly KEEP (do NOT touch) — legitimate Claude references

These are correct and in scope to keep. Listed so the implementer doesn't
over-reach:

- **Model picker & model names** — anything rendering "Claude Opus/Sonnet/Haiku"
  as a selectable model (`src/lib/model-catalog.ts`, the picker UI, pricing
  display, `.replace("claude-", "")` formatting in usage/admin views).
- **Model providers** — Anthropic, Bedrock, OpenRouter settings and BYOK config
  (`src/lib/llm-provider-config.ts`, `byok-providers.ts`, AI-provider settings
  routes, `ANTHROPIC_API_KEY_VALIDATION_MODEL`).
- **Filesystem paths** — `/home/claude` workspace root prefixes in
  `file-link.tsx`, `computer-page-content.tsx:158`, `AppCard.tsx:107`,
  `skill-details.tsx`, and API utils. These are the sandbox's actual home
  directory, not branding. **Do not rename** — it's an infra path with no UI
  branding meaning and changing it is risky/out of scope.
- **Internal/model-routing code** in `workers/main/src/` (Bedrock/OpenRouter
  model maps, `provider: 'claude' | 'codex'`, legacy `claude_session_id`
  migration helpers). Not user-facing.
- **Admin-only surfaces** — e.g. `_admin.threads.$id.tsx` "Update thread title
  and Claude model", the `claude_proxy_models` experimental flag. These are
  internal admin tools, not the customer product. *Optional:* the admin thread
  card description could be reworded to "…and model", but it's low priority and
  not required for this task.
- **Code comments** referencing Claude behavior (e.g. `Chat.tsx` stream
  comments) — internal, leave as-is.

---

## Files summary

### Delete
| File | Reason |
|------|--------|
| `src/components/welcome-screen/beta-notice.tsx` | Beta notice component, no longer used |

### Modify
| File | Change |
|------|--------|
| `src/components/sidebar/app-sidebar.tsx` | Remove "Beta" badge block + unused `Badge` import (A1) |
| `src/components/welcome-screen/index.tsx` | Remove `BetaNotice`, orphaned `helpOpen` state + `GetHelpDialog` + imports (A2) |
| `src/components/pages/computer/computer-page-content.tsx` | Reword file-editing message (A4), soften delete dialog (B2), rename `BETA_FILE_EDIT_DISABLED_MESSAGE` constant (A5), update beta comments |
| `src/routes/_onboarding.welcome.tsx` | Reword subhead "Claude" → "Your agents" (B1) |
| `src/routes/api/workspaces.utils.ts` | Rename `blockBetaFileEdit` → `blockFileEdit`, reword 403 message, update doc comment (A5 + Final copy #3) |
| 8 fs/ext API route files (see A5 list) | Update `blockFileEdit` import name + "Beta:" call-site comments (A5) |

### Do NOT modify
- `get-help-dialog.tsx` — leave the `defaultCategory` prop in place (harmless,
  optional API; the sidebar caller still works). No change needed.
- All Part B3 "KEEP" items.

---

## Testing

- `bun run typecheck` — catches dangling imports/refs after the removals
  (especially `Badge`, `BetaNotice`, `GetHelpDialog`, `helpOpen` in the welcome
  screen).
- `bun run lint`.
- Relevant Vitest: run any existing tests touching the welcome screen, sidebar,
  or `workspaces.utils` (`bun run test:run` for the affected files). If A5 is
  done, run the worker tests that hit the fs API routes
  (`bun run test:workers`) to confirm the 403 path still works after the rename.
- Manual smoke (optional): new-chat/welcome screen shows no beta line; sidebar
  header shows no Beta badge (expanded and collapsed); onboarding welcome and the
  Computer delete dialog read with the new copy; "Get Help" still works from the
  sidebar.

## Out of scope

- Re-enabling Computer-tab file editing (separate behavioral change — see the ⚠️
  note under Final copy #3).
- Non-UI surfaces: system prompt, emails, marketing/sales site.
- Renaming the `/home/claude` workspace path or any model-routing internals.
- Adding any new copy, banners, or "paid product" messaging (this task is
  removal only).
