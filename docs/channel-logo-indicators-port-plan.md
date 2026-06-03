# Channel Logo Indicators Port-Forward Plan

This is a handoff plan for porting the dirty `channel-logo-indicators` worktree onto current `origin/main`.

The rendered design from the dirty worktree was reviewed and **approved** — reproduce it exactly. See the **Visual Design Reference** section below for the visual contract (mockups + exact classes); the per-file frontend ports implement that spec. The dirty branch's UI files are the source of truth: copy their markup verbatim, do not improvise spacing, sizes, or colors.

Source worktree:

```bash
/Users/illiana/conductor/workspaces/chiridion-app/channel-logo-indicators
```

Target implementation worktree should start from current `origin/main`. The source branch is only a patch source. Do not merge or cherry-pick the stale branch state.

The previously used feature plan is here:

```bash
/Users/illiana/conductor/workspaces/chiridion-app/channel-logo-indicators/docs/channel-indicators-plan.md
```

## Why This Port Needs Care

The dirty source worktree contains the right feature shape, but two parts are stale relative to current main:

- The old backend patch edits `workers/main/src/auth.ts`. Current main has split OrgDO into `workers/main/src/identity/org-do.ts`, and `workers/main/src/auth.ts` is now just an export shim. Do not copy backend edits into `auth.ts`.
- The old migration used schema version 30. Staging has already seen `schemaVersion = 30`, so a future `if (version < 30)` migration will be skipped for those Durable Objects forever. The final migration must roll forward to V31, not reuse V30.
- The old `workers/main/src/chat-thread-do.ts` patch may not include newer mainline behavior. Reapply only the channel usage recording edits and preserve current main's Pi keepalive stall watchdog, workspace email sender logic, and Telegram Markdown formatting.

## Safety Rules

- Work from a fresh `origin/main` branch/workspace.
- Do not resolve this by merging the current dirty diff against main.
- Do not run destructive cleanup in the dirty source worktree.
- Treat copied files as source artifacts, then review the final diff against `origin/main`.
- Keep `thread.channel_kind` and `thread.channel_kinds` semantically separate:
  - `channel_kind`: origin/default routing channel.
  - `channel_kinds`: external channel kinds that have participated in the thread.

Before implementation, capture the dirty source patch for reference:

```bash
cd /Users/illiana/conductor/workspaces/chiridion-app/channel-logo-indicators
git diff > .context/channel-logo-indicators.patch
git ls-files --others --exclude-standard > .context/channel-logo-indicators-untracked.txt
```

In the implementation workspace, verify a clean base:

```bash
git status --short --branch
git diff --stat origin/main...HEAD
```

## Copy Directly Or With Minimal Review

These files are new or low-risk and can be copied from the source worktree, then formatted and reviewed:

| Source file | Target file | Notes |
|---|---|---|
| `src/lib/channel-kinds.ts` | `src/lib/channel-kinds.ts` | Copy mostly as-is. This file is intentionally React-free and safe to import from Worker code. Keep `normalizeChannelIndicatorKind`, `collectChannelIndicatorKinds`, and `parseChannelIndicatorKindsJson`. |
| `src/lib/channel-branding.ts` | `src/lib/channel-branding.ts` | Copy mostly as-is. React-only branding lives here. Email currently uses Lucide `Mail`; Slack and Telegram use integration logo types. |
| `src/components/chat/channel-logo.tsx` | `src/components/chat/channel-logo.tsx` | Copy mostly as-is. Provides `ChannelLogo` and `ChannelLogoStack`. Verify `IntegrationIcon` props still match current main. |
| `tests/channel-indicators.test.tsx` | `tests/channel-indicators.test.tsx` | Copy, then adjust imports only if current test setup changed. |
| `public/logos/gmail.svg` | `public/logos/gmail.svg` | Copy if the final product still wants the Gmail registry asset from the dirty worktree. It is separate from the email channel indicator, which currently uses Lucide `Mail`. |

Copy these one-line or small registry/readme/test additions from the source worktree if they are still absent on main:

- `src/lib/integration-logo-registry.ts`: add `gmail: 'single'`.
- `public/logos/README.md`: add the `gmail` row.
- `tests/integration-icons.test.tsx`: add the Gmail logo rendering test.

Email icon decision (settled — this is the approved design):

- The `email` channel renders as the Lucide `Mail` envelope, inheriting `currentColor`. This is the **exact icon the connections tab uses for email** (`connection-row.tsx:204`), so the two surfaces stay visually consistent. The channel kind is provider-agnostic `email`, not Gmail. Do not Gmail-brand the email indicator.
- The `public/logos/gmail.svg` asset and its `gmail: 'single'` registry row are **orthogonal** to the channel indicator — they are *not* wired into `CHANNEL_BRANDS`. Porting them is optional (only if you want the Gmail asset available elsewhere) and does not change the indicators. If you skip the asset, also skip the Gmail row in `tests/integration-icons.test.tsx`.
- `tests/channel-indicators.test.tsx` already pins this: `getChannelBrand("email")?.label === "Email"` with the `Mail` glyph. Keep it.

Why these can be copied:

- They do not depend on the stale Worker module layout.
- They do not change Durable Object schema or runtime coordination.
- The channel helper file is deliberately shared between frontend and Worker code.

## Visual Design Reference (reproduce the dirty branch exactly)

This is the visual contract. Every class name below is copied verbatim from the approved dirty-branch implementation, which itself mirrors the existing **connections tab**. This feature introduces **no new UI primitives**: it composes existing shadcn/ui `Tooltip` + `Button`, Lucide icons, the existing `IntegrationIcon`, and the connections-tab logo chip. Do not invent new styles.

### The chip — single source of truth: `ChannelLogo`

The indicator is a **logo inside a small rounded-square chip**. It is deliberately a *different shape* from the circular author avatar, so it reads as "a channel," not "a person." It mirrors the connections-tab logo chip (`src/components/pages/connections/connection-row.tsx:273` → `flex size-8 ... rounded-md bg-muted`), scaled down to sit inside the `text-xs` history/meta rows.

| Element | Exact classes / props | Why |
|---|---|---|
| Chip container | `flex size-5 shrink-0 items-center justify-center rounded-md bg-muted` | 20px rounded square; `bg-muted` matches the connections chip fill (not white) |
| Glyph size | `size-3.5` (14px) | Same optical size as the `size-3.5` history avatar it sits beside |
| Email glyph | Lucide `Mail`, inherits `currentColor` | Exactly the connections-tab email icon (`connection-row.tsx:204`); provider-agnostic, monochrome |
| Slack / Telegram glyph | `<IntegrationIcon type={brand.logoType} size={14} className="size-3.5" />` | Full-color brand SVGs, already registered `'single'` |
| Stack wrapper | `flex items-center -space-x-1` | Overlapping "coins" |
| Per-chip ring (in stack) | `ring-2 ring-background` | Separates overlapping chips against the row background — same idea as `AvatarGroup` (`avatar.tsx:159`) |

The shipped `src/components/chat/channel-logo.tsx` already encodes all of this — copy it as-is (see the copy table above). The tokens are restated here so the visual intent survives review and so the manual checks below are verifiable.

### Surface 1 — Chat history row

Channel chips sit at the **end of the meta row, after the timestamp**, in fixed canonical order **Email → Slack → Telegram**. The author avatar stays a circle and is never replaced.

```text
Multi-channel chat
  Onboarding flow review with the team
  (M)   Yesterday   (✉)(#)(✈)      <- stacked rounded-square chips, slight overlap,
   |      |                            each ringed in the row background
   |      `- timestamp
   `- author avatar (circle, unchanged)         (✉)=Email (#)=Slack (✈)=Telegram

Single-channel chat
  Customer escalation from Acme Corp
  (S)   2 hours ago   (✉)          <- one chip (Email)

UI-only chat (unchanged)
  Some chat started in the app
  (M)   3 days ago                 <- no chips
```

Each chip carries its own tooltip: `Contains messages sent via Email` / `…Slack` / `…Telegram`.

### Surface 2 — In-chat user message

At rest, a channel message shows **only the logo** beneath the bubble, right-aligned to the bubble edge. On hover/focus the existing `Sent by … at …` + copy controls **fade in to the left** of the logo. The logo never moves.

```text
RESTING  -- only the logo shows
        +--------------------------------+
        | Hey, can you look into a refund |
        +--------------------------------+
                                     (✉)   <- always visible, fixed at the right edge

HOVER  -- meta fades in to the LEFT; logo stays put
        +--------------------------------+
        | Hey, can you look into a refund |
        +--------------------------------+
   Sent by Illiana Reed at 2:49 PM  [copy] · (✉)
```

- Tooltip on the logo → `Sent via Email` / `Sent via Slack` / `Sent via Telegram`.
- **No layout shift.** The fade-in meta group keeps its layout box at rest (it is `opacity-0` + `pointer-events-none`), so revealing it does not push the logo. The `·` separator lives *inside* the fade group, so at rest you see only the logo.
- A UI-only (web) message is **byte-for-byte unchanged** — no logo; the existing meta row fades in exactly as it does today.

## Frontend Ports

These source edits are close to current main and can be replayed manually or by applying the source patch file-by-file.

### `src/components/message-bubble.tsx`

Implements **Surface 2** above. Two parts: surface the per-message source in the parser, then branch the user-message action row.

**Imports:**

```ts
import { ChannelLogo } from '@/components/chat/channel-logo';
import { getChannelBrand } from '@/lib/channel-branding';
```

**Parser (no backend needed — the source token is already captured, then discarded):**

- Add `source: string | null` to the `ParsedAuthor` interface.
- Export `parseMessageAuthor` so parser tests can import it (`export function parseMessageAuthor(...)`).
- In the `AUTHOR_PREFIX_WITH_SOURCE_REGEX` branch (capture group 1 is the source token), set:

```ts
source: matchWithSource[1]?.trim().toLowerCase() || null,
```

- In the two non-source author branches **and** the no-match return, set `source: null`.

**Render — branch the user-message action row.** Just above the user-message `return` (next to where `hasCleanContent` is computed), add:

```ts
const channelBrand = getChannelBrand(author?.source); // null for web / UI / unknown
```

In current main the action row is a single `{showActionRow && ( … )}` block (around `message-bubble.tsx:832`). Replace it with the exact two-branch structure below. This is copied verbatim from the approved dirty branch — the `else` branch is current main's block **unchanged**, so web/UI messages render identically to today.

```tsx
{showActionRow && channelBrand ? (
  <div
    className="flex items-center justify-end gap-1"
    role="group"
    aria-label="Message actions"
  >
    {/* fade-in meta group: author + time + copy + separator. opacity only -> no layout shift */}
    <div
      className={cn(
        "flex items-center gap-0.5 pointer-coarse:gap-1",
        "pointer-events-none group-hover:pointer-events-auto group-focus-within:pointer-events-auto pointer-coarse:pointer-events-auto",
        actionVisibilityClassName,
      )}
    >
      {author && (
        <span className="text-muted-foreground text-xs mr-1">
          Sent by {author.displayName} at
        </span>
      )}
      <span className="text-muted-foreground text-xs mr-1">
        {messageTime}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground pointer-coarse:size-9 pointer-coarse:[&_svg:not([class*='size-'])]:size-4"
            onClick={() => onCopy(message.id, actionCopyContent ?? contentToString(cleanedContent))}
          >
            {isCopied ? <Check /> : <Copy />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {isCopied ? 'Copied!' : 'Copy message'}
        </TooltipContent>
      </Tooltip>
      <span className="text-muted-foreground/60 text-xs mx-1" aria-hidden>
        ·
      </span>
    </div>
    {/* always-visible logo, rightmost and fixed */}
    <ChannelLogo
      channel={channelBrand.kind}
      tooltip={`Sent via ${channelBrand.label}`}
    />
  </div>
) : showActionRow ? (
  // UNCHANGED from current main — keep web/UI message behavior byte-for-byte.
  <div
    className={cn("flex items-center gap-0.5 pointer-coarse:gap-1", actionVisibilityClassName)}
    role="group"
    aria-label="Message actions"
  >
    {author && (
      <span className="text-muted-foreground text-xs mr-1">
        Sent by {author.displayName} at
      </span>
    )}
    <span className="text-muted-foreground text-xs mr-1">
      {messageTime}
    </span>
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground pointer-coarse:size-9 pointer-coarse:[&_svg:not([class*='size-'])]:size-4"
          onClick={() => onCopy(message.id, actionCopyContent ?? contentToString(cleanedContent))}
        >
          {isCopied ? <Check /> : <Copy />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {isCopied ? 'Copied!' : 'Copy message'}
      </TooltipContent>
    </Tooltip>
  </div>
) : null}
```

Design invariants (do not "improve" these — they are what made the approved version look right):

- **Reuse `actionVisibilityClassName`** for the fade group. Current main defines it as `cn("transition-opacity", actionHoverClassName)`, and the default `actionHoverClassName` is the `opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100` string. Do **not** hand-write a new opacity string — reusing the variable keeps the channel and non-channel rows fading identically and inheriting any future tweak.
- The copy control is the **same inline shadcn `Button variant="ghost" size="icon-sm"` + `Tooltip`** the non-channel branch uses, with the same `Check`/`Copy` icons and the same `onCopy(message.id, actionCopyContent ?? contentToString(cleanedContent))` call. Do not substitute a different copy component.
- `pointer-events-none` at rest prevents an invisible copy-button hit target; it flips to `auto` on hover/focus.
- The `·` separator and all meta live **inside** the fade group; `<ChannelLogo>` is the only always-visible element and is the fixed rightmost child of the `justify-end` row, so it never moves on hover.
- Slash-command, interrupt, and assistant-message branches are untouched.

### `src/components/history/chat-row.tsx`

Implements **Surface 1** above. `Thread` is already imported in this file. Add:

```ts
import { ChannelLogoStack } from '@/components/chat/channel-logo';
import { normalizeChannelIndicatorKind } from '@/lib/channel-kinds';
```

Add this helper above the `ChatRow` component (prefers the aggregate; falls back to the origin `channel_kind` for pre-migration rows or stale loader cache; returns `[]` for web/unknown so the stack renders nothing):

```ts
function getThreadChannelKinds(thread: Thread): string[] {
  const channelKinds = Array.isArray(thread.channel_kinds)
    ? thread.channel_kinds.filter((kind) => normalizeChannelIndicatorKind(kind))
    : [];
  if (channelKinds.length > 0) return channelKinds;

  const originKind = normalizeChannelIndicatorKind(thread.channel_kind);
  return originKind ? [originKind] : [];
}
```

Render the stack **immediately after** the `<span>{formatRelativeTime(thread.updated_at)}</span>` in **both** meta rows — the editing-title branch (`chat-row.tsx:311`) and the normal-title branch (`chat-row.tsx:324`). Both rows are `<div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">`, so the existing `gap-2` provides the spacing before the stack — add no extra margin:

```tsx
<span>{formatRelativeTime(thread.updated_at)}</span>
<ChannelLogoStack
  channels={getThreadChannelKinds(thread)}
  tooltipFor={(label) => `Contains messages sent via ${label}`}
/>
```

### `src/types.ts`

Add:

```ts
channel_kinds?: string[] | null;
```

to `Thread`.

### `src/lib/chat-do.server.ts`

Port the source loader conversion:

- Import `parseChannelIndicatorKindsJson`.
- In `toThread`, add:

```ts
channel_kinds: parseChannelIndicatorKindsJson(orgThread.channel_kinds),
```

This must be defensive. Malformed JSON should become `null`, not throw and break chat history.

### `src/routes/_app.chat.$id.tsx`

Port the fallback active group change:

- Import `parseChannelIndicatorKindsJson`.
- Before `buildFallbackActiveChatGroup`, create a `Thread`-typed fallback object that parses the raw OrgThread `channel_kinds`.

Shape:

```ts
const fallbackThread: Thread = {
  ...thread,
  channel_kinds: parseChannelIndicatorKindsJson(thread.channel_kinds),
};
```

Then pass `fallbackThread`.

Why this route needs its own parsing:

- This fallback path receives a raw OrgDO thread, not necessarily a `toThread` result.
- Without parsing here, the active chat group can miss channel indicator data even if history rows have it.

## Backend Port: `workers/main/src/identity/org-do.ts`

Do not copy the old `workers/main/src/auth.ts` diff. Recreate the same behavior in current main's `workers/main/src/identity/org-do.ts`.

### Imports And Helpers

Add a React-free import near the existing app-lib imports:

```ts
import {
  normalizeChannelIndicatorKind,
  type ChannelIndicatorKind,
} from "../../../../src/lib/channel-kinds";
```

Add helper functions near the other top-level helpers:

- `parseThreadChannelKinds(value)`: parse JSON, accept only array strings, normalize/dedupe known kinds, tolerate malformed values by returning `[]`.
- `mergeThreadChannelKinds(existingJson, source)`: normalize source, append only when absent, return `null` when no DB write is needed.

Use the source `auth.ts` implementation as the starting point, but keep the import path above.

### Thread Type

Current main has duplicate split-auth `OrgThread` interface definitions:

- `workers/main/src/identity/org-do.ts`
- `workers/main/src/identity/user-do.ts`

Also, `workers/main/src/identity/index.ts` re-exports `OrgThread` from `user-do.ts`, and `workers/main/src/auth.ts` re-exports `identity/index.ts`. App-side imports such as `src/lib/chat-do.server.ts` therefore see the `user-do.ts` type even though the runtime method lives in `org-do.ts`.

Lower-risk port: update both `OrgThread` interfaces. Do not change the re-export topology as part of this feature unless you intentionally consolidate the type in a separate cleanup.

Add to both `OrgThread` interfaces:

```ts
channel_kinds: string | null;
```

This is the raw stored JSON string in Worker/OrgDO land. The React `Thread` type gets the parsed array.

### Schema Definitions

Add `channel_kinds TEXT` to both current `CREATE TABLE IF NOT EXISTS threads` definitions in `org-do.ts`.

Observed current-main anchors are around the two `CREATE TABLE IF NOT EXISTS threads` blocks. Re-check by running:

```bash
rg -n "CREATE TABLE IF NOT EXISTS threads" workers/main/src/identity/org-do.ts
```

This does not replace the migration; it only makes freshly created DO databases include the column.

### Migration V31

Add a new migration after the current V29 block:

```ts
if (version < 31) {
  // V31: Aggregate external channel kinds that have participated in a thread.
  // V30 was consumed by a staging deployment of this feature; do not reuse it.
  this.ensureColumn("threads", "channel_kinds", "TEXT");

  const rows = this.sql
    .exec<{ id: string; channel_kind: string | null }>(
      "SELECT id, channel_kind FROM threads WHERE channel_kinds IS NULL OR channel_kinds = ''",
    )
    .toArray();

  for (const row of rows) {
    const kind = normalizeChannelIndicatorKind(row.channel_kind);
    if (!kind) continue;
    this.sql.exec(
      "UPDATE threads SET channel_kinds = ? WHERE id = ?",
      JSON.stringify([kind]),
      row.id,
    );
  }
}
```

Then set:

```ts
const CURRENT_SCHEMA_VERSION = 31;
```

If current main has advanced by the time this is implemented, use the next unused schema version greater than both current main and 30. Never use 30 for this final migration.

Migration behavior required:

- Prod/main DOs at 29 run V31 and get the column/backfill.
- Staging DOs already at 30 still run V31.
- Staging rows already backfilled by old V30 are preserved because the update only targets `NULL` or empty `channel_kinds`.
- Rows created during rollback/intermediate deployments with `channel_kinds = NULL` get repaired.
- No downgrade/drop is needed because `channel_kinds` is additive and nullable.

### Self-Healing Schema

Add `channel_kinds` to `ensureThreadSchemaColumns()`:

```ts
if (!names.has("channel_kinds")) {
  try {
    this.sql.exec("ALTER TABLE threads ADD COLUMN channel_kinds TEXT");
  } catch {}
}
```

This is self-healing only. The V31 migration is still responsible for the backfill.

### `createThread`

When `options.channelKind` is present:

- Normalize it with `normalizeChannelIndicatorKind`.
- Store `channel_kinds = JSON.stringify([normalized])` when normalized, else `null`.
- Add `channel_kinds` to:
  - INSERT column list.
  - INSERT values list.
  - returned `thread` object.

Keep `channel_kind` unchanged. It still records origin/default routing metadata even if the new aggregate is empty for unknown channel kinds.

### `recordThreadChannelUsed`

Add a new OrgDO method:

```ts
recordThreadChannelUsed(
  id: string,
  channelKind: string | null | undefined,
): OrgThread | null
```

Behavior:

- Read the thread.
- Merge the normalized channel kind into `existing.channel_kinds`.
- If unknown/web/duplicate, return the existing thread without writing.
- If new, update only `channel_kinds`.
- Do not change `updated_at`, `user_message_count`, or last-message fields.

Why:

- Successful outbound channel sends should show in history, but they should not reorder the thread by activity by themselves.

### `recordThreadUserMessage`

Change the signature to:

```ts
recordThreadUserMessage(
  id: string,
  message: string,
  source?: string | null,
): OrgThread | null
```

Preserve existing behavior:

- Increment `user_message_count`.
- Update `updated_at`.
- Update `last_user_message`.
- Update `last_user_message_at`.
- Dispatch the admin thread upsert.

Add only:

- Merge `source` into `channel_kinds` if it normalizes to email/slack/telegram.
- Include changed `channel_kinds` in the DB update and returned/admin payload.
- Existing two-argument callers must still work.

## Backend Port: `workers/main/src/chat-thread-do.ts`

Port only the channel usage tracking edits from the dirty source patch. Do not wholesale replace `chat-thread-do.ts`.

Preserve current main behavior, especially:

- Pi keepalive stall watchdog logic.
- Current workspace email sender address logic in `sendChannelEmailTool`.
- Telegram Markdown formatting through `formatMarkdownForTelegram`.
- Existing `ChannelHistoryEventRequest.orgId` shape and Telegram outbound history plumbing.

### Import

Add:

```ts
import { normalizeChannelIndicatorKind } from "../../../src/lib/channel-kinds";
```

### Inbound/User Message Metadata

Change `updateThreadMetadataForUserMessage` to accept `messageSource?: string | null`.

In `enqueueRunnerUserMessage`, pass:

```ts
options.messageSource ?? "web"
```

through the existing `ctx.waitUntil(this.updateThreadMetadataForUserMessage(...))` call.

Inside `updateThreadMetadataForUserMessage`, call:

```ts
await orgStub.recordThreadUserMessage(
  context.threadId,
  messageContent,
  messageSource,
);
```

Why:

- Channel ingress already threads a `messageSource` through `enqueueChannelMessage`.
- `"web"` should be harmless because the OrgDO normalizer ignores it.

### Best-Effort Outbound Marker

Add a helper:

```ts
private async markThreadChannelUsedBestEffort(
  context: { orgId?: string | null; threadId?: string | null },
  channelKind: "email" | "slack" | "telegram",
): Promise<void>
```

Behavior:

- Return if `orgId` or `threadId` is missing.
- Call `orgStub.recordThreadChannelUsed(threadId, channelKind)`.
- Catch and log failures.
- Do not fail the external send if metadata recording fails.

### Successful Outbound Sends

Call the helper only after the external side effect succeeds:

- Email: after `env.EMAIL.send(...)` succeeds and after reply reference KV write if present.
- Slack: after `chat.postMessage` or file upload succeeds.
- Telegram: after Telegram text/attachment sends succeed. It is fine to place this after the existing outbound history recording attempt, matching the source patch.

### Appended Channel History

In `appendChannelHistoryEvent`, after `appendPiCoreMessagesIfMissing([message])` succeeds:

- Normalize `channelKind` with `normalizeChannelIndicatorKind`.
- If it is a supported channel, call `markThreadChannelUsedBestEffort` with:

```ts
{
  orgId: input.orgId || this.chatContext?.orgId,
  threadId,
}
```

This keeps mapped channel threads accurate when outbound Telegram history is appended to a separate channel thread.

## Tests To Port And Adjust

### Frontend And Parser Tests

Copy or port:

- `tests/channel-indicators.test.tsx`
- The `parseMessageAuthor` tests added to `tests/message-bubble-parsers.test.ts`
- The Gmail registry test in `tests/integration-icons.test.tsx`, if keeping the Gmail asset/registry change

Run:

```bash
bun run test:run tests/channel-indicators.test.tsx tests/message-bubble-parsers.test.ts tests/integration-icons.test.tsx
```

### OrgDO Tests

Port the new tests from the dirty source `workers/main/tests/auth-do.test.ts`, but adjust them for V31:

- `createThread` seeds `channel_kinds` for channel-created threads.
- V31 backfills `channel_kinds` from `channel_kind`.
- V31 runs even when stored `schemaVersion` is 30.
- V31 preserves existing non-empty `channel_kinds`.
- `recordThreadUserMessage` merges/dedupes source channels and still increments `user_message_count`.
- `recordThreadChannelUsed` records outbound channel usage without changing `updated_at` or `user_message_count`.

Add or adapt a test helper such as `downgradeThreadChannelKindsSchemaForTest()`, but set the stored schema version to `30` for the sticky-staging case. The old source helper set it to `29`; that is not sufficient for the final migration risk.

Run:

```bash
bun run test:workers -- workers/main/tests/auth-do.test.ts
```

### ChatThreadDO Tests

Port the relevant additions from the dirty source `workers/main/tests/chat-thread-codex-external-turn.test.ts`, adjusting for current main line numbers and mocks:

- Email send test should mock `recordThreadChannelUsed` and expect `('thread1', 'email')`.
- Slack send success test should mock `ORG.get(...).recordThreadChannelUsed` and expect `('thread1', 'slack')`.
- Telegram attachment/send test should expect `('thread1', 'telegram')`.
- Appended outbound channel history test should pass `orgId` and expect `recordThreadChannelUsed('telegram-thread', 'telegram')`.

Also verify metadata-write failures do not make successful sends fail if there is no existing coverage.

Run the focused test file if practical:

```bash
bun run test:workers -- workers/main/tests/chat-thread-codex-external-turn.test.ts
```

## Verification

At minimum:

```bash
bun run test:run tests/channel-indicators.test.tsx tests/message-bubble-parsers.test.ts tests/integration-icons.test.tsx
bun run test:workers -- workers/main/tests/auth-do.test.ts
bun run typecheck
```

Also run the focused ChatThreadDO test file if touched substantially:

```bash
bun run test:workers -- workers/main/tests/chat-thread-codex-external-turn.test.ts
```

Manual UI checks (against the Visual Design Reference):

- Chip shape/size: a 20px **rounded square** (`rounded-md bg-muted`), visually distinct from the circular author avatar, glyph at `size-3.5`.
- Email chip matches the connections-tab envelope (Lucide `Mail`); Slack/Telegram render full-color brand SVGs.
- Web-only history row: no channel logo stack.
- Email/Slack/Telegram history rows: logo stack appears after the timestamp.
- Multi-channel thread: logos render in canonical order Email, Slack, Telegram, slightly overlapped (`-space-x-1`) with a `ring-background` ring separating them.
- Channel user message at rest: only the logo is visible beneath the bubble, right-aligned to the bubble edge.
- Channel user message hover/focus: author/time/copy controls fade in to the left; the logo does **not** move (opacity only, no layout shift).
- UI-only user message hover behavior is unchanged from current main.
- Tooltips say `Contains messages sent via ...` in history and `Sent via ...` in chat.
- Light and dark themes: ring/background contrast is clean. History rows tint to `bg-muted/50` on hover — confirm the `ring-background` still separates overlapping chips against that tint; if it looks off, fall back to ringing in the row/card color (verify visually before changing).

## Final Diff Checklist

- [ ] No feature code was copied into `workers/main/src/auth.ts`; it remains the identity export shim.
- [ ] Both split-auth `OrgThread` interfaces include `channel_kinds`: `workers/main/src/identity/org-do.ts` and `workers/main/src/identity/user-do.ts`.
- [ ] `workers/main/src/identity/org-do.ts` uses V31 or a later unused version, never V30.
- [ ] `ensureThreadSchemaColumns()` includes `channel_kinds`.
- [ ] `createThread`, `recordThreadUserMessage`, and `recordThreadChannelUsed` all return `channel_kinds`.
- [ ] `recordThreadChannelUsed` does not update activity metadata.
- [ ] `chat-thread-do.ts` preserves current main email sender and Telegram formatting logic.
- [ ] Frontend parses `channel_kinds` defensively.
- [ ] History rows fall back to `channel_kind` if `channel_kinds` is missing or empty.
- [ ] Chip uses `size-5 rounded-md bg-muted` (mirrors the connections chip); stack uses `-space-x-1` + `ring-2 ring-background`; canonical order Email → Slack → Telegram.
- [ ] Email indicator is Lucide `Mail` (matches the connections tab), not a Gmail brand logo.
- [ ] Channel user message: logo is always visible at rest; meta fades via the existing `actionVisibilityClassName`; logo does not move on hover (opacity + `pointer-events` only, no layout shift).
- [ ] Non-channel (web) user-message action row is byte-for-byte unchanged from current main.
- [ ] `<ChannelLogo>` / `<ChannelLogoStack>` render `null` for web/unknown, so UI-only surfaces are untouched.
- [ ] Parser tests cover source extraction.
- [ ] Worker tests cover the sticky `schemaVersion = 30` case.
