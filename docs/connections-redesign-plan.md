# Connections Tab Redesign — Implementation Plan

Audience: the coding agent implementing this, plus a backend/logic reviewer who will patch the data contract. This plan is **UI-led**: it specifies the component structure, shadcn usage, and exact layout, and it isolates the backend data work into one contract section (§5) so it can be reviewed and corrected independently.

The goal is two things:
1. **Differentiate channels from connections** in the `/connections` tab without adding visual weight.
2. **Make `/connections` feel like `/automations`** — same chrome, same push-split detail panel, same motion — so the product feels like one system.

The source spec was supplied as a chat attachment/context dump. This plan is the authoritative build doc; where it tightens or reconciles the spec, follow this plan rather than relying on an attachment path that may not exist in the implementation workspace.

---

## 1. Reference implementations (read these first)

The redesign **mirrors the Automations page**. Read these before writing code; copy their structure and class names rather than inventing new ones.

| Purpose | File |
|---|---|
| Push-split container + mobile Sheet + URL-driven selection | `src/components/pages/automations/automations-client.tsx` |
| List wrapper (rows + separators, empty states) | `src/components/pages/automations/automation-list.tsx` |
| Row anatomy, hover/selected states, row overflow menu | `src/components/pages/automations/automation-row.tsx` |
| **Detail panel** — chrome, type chip + tooltip, section + label/value patterns | `src/components/pages/automations/automation-panel.tsx` |
| Shared types/helpers split out of the client | `src/lib/automations-shared.ts` |

What we are **replacing**: the current `src/components/pages/connections/connections-client.tsx` renders a flat `grid md:grid-cols-2` of shadcn `Card`s with a category-filter `Tabs` row and no detail panel. The list and its filters get rewritten. The **add/edit/delete/clone machinery is reused as-is** (see §2).

---

## 2. What we reuse unchanged (do NOT rebuild)

All of the existing connection lifecycle UI and server actions stay. The redesign is the **list + detail panel**; everything that mutates a connection is reused:

- **`AddConnectionDialog`** (`src/components/pages/connections/AddConnectionDialog.tsx`) — the "Add connection" picker → credential form flow.
- **`EditConnectionDialog`** (`src/components/pages/connections/EditConnectionDialog.tsx`) — config + credentials edit, including `forceCredentialUpdate`, and the existing remote-MCP OAuth reconnect button. **Use it for "Configure" / credential updates instead of building inline config editors.** It is **not** the rename UX (rename is inline, §8.3), and it does not currently expose Slack/Notion/Salesforce reconnect buttons; those should use the OAuth redirect helper described in §9.
- The **picker `Dialog`**, **custom-connection chat handoff `ConfirmDialog`**, **delete `ConfirmDialog`**, and **clone-to-workspace `Dialog`** currently in `connections-client.tsx` — carry them over verbatim.
- The **server `action`** in `src/routes/_app.connections.tsx` (`createIntegration` / `updateIntegration` / `deleteIntegration` / `duplicateIntegration`) — unchanged unless you choose to implement the optional Telegram re-link action in §9.
- **`handleNewChat`** logic: `writeDraft(currentWorkspace.id, null, "@" + slug + " ", [])` then `navigate('/chat')`. Both the row chat icon and the panel "Open in chat" call this.
- Helpers: `buildSlugMap` / `slugForIntegration` / `filterMentionableConnections` (`src/lib/connection-mentions.ts`), `IntegrationIcon` / `hasIntegrationIcon` / `resolveLogoType` (`src/lib/integration-icons.tsx`), `getIntegrationAuthLabel` (`src/lib/integration-auth-label.ts`), `INTEGRATION_REGISTRY` (`src/lib/integration-registry.ts`).

**Remove** from the page: the category-filter `Tabs` row, the "Showing N of M / Clear filters" bar, and the `Card`-grid renderer. (Spec §3: no category chips.)

---

## 3. New file layout

Mirror the Automations component split.

| File | Status | Responsibility |
|---|---|---|
| `src/components/pages/connections/connections-client.tsx` | **rewrite** | Push-split container, URL selection (`?selected=`), search/sort state, mobile `Sheet`, and host for all reused dialogs (§2). |
| `src/components/pages/connections/connection-group-list.tsx` | **new** | Renders the two labeled groups (Channels, Connections), section headers + counts, and the responsive grid that collapses to one column when the panel is open. |
| `src/components/pages/connections/connection-row.tsx` | **new** | One grid cell: logo well + name + chat icon (when mentionable) + overflow menu. Hover + selected states. |
| `src/components/pages/connections/connection-panel.tsx` | **new** | The detail panel. Shared header (type tag + overflow + close) and title row, then a body that branches `connection` vs `channel`. |
| `src/lib/connections-shared.ts` | **new** | Pure helpers/types: the `PanelItem` union (§4), channel detection, the email synthetic item, capability derivation (§7), archetype → detail-field mapping (§8.5), and the type-tag tooltip copy. Keep it framework-free so the backend reviewer can correct logic in one place. |
| `src/routes/_app.connections.tsx` | **modify loader** | Pass the additional data in §5. The `action` stays unchanged unless implementing the optional Telegram re-link action in §9. |

Keep `connections-loading.tsx` (HydrateFallback) working; update its skeleton shape only if the layout shift is jarring.

---

## 4. Item model — unify connections, channels, and email

The list shows three things that must feel uniform but carry different data. Normalize them into one discriminated union in `connections-shared.ts`:

```ts
import type { Avatar, Integration } from "@/types";

// Channels are NOT "category === communication". SendGrid/Twilio/Discord/Teams are
// communication-category but outbound-only, so they stay under Connections.
// Channels are exactly: Slack + Telegram integration records, plus the synthetic Email item.
export const CHANNEL_INTEGRATION_TYPES = ["slack", "telegram"] as const;

export interface ConnectionListItem extends Integration {
  auth_status?: string | null;
  auth_error_code?: string | null;
  auth_error_message?: string | null;
  auth_checked_at?: number | null;
  reauth_required_at?: number | null;
  token_expires_at?: number | null;
  created_by_name?: string | null;
  created_by_avatar?: Avatar | null;
  channelMetadata?: {
    team_id?: string | null;
    team_name?: string | null;
    bot_user_id?: string | null;
  };
}

export type PanelItem =
  | { kind: "connection"; id: string; connection: ConnectionListItem }
  | { kind: "channel"; channel: "slack" | "telegram"; id: string; connection: ConnectionListItem }
  | { kind: "channel"; channel: "email"; id: "email"; email: EmailChannel };

export interface EmailChannel {
  address: string | null;     // workspaceEmailAddress from loader; null if domain unset
  handle: string | null;      // workspace.email_handle
  inboxEnabled: boolean;       // plan gate (billing-plans emailInbox)
  workspaceCreatedBy: string | null;
  workspaceCreatedByName?: string | null;
  workspaceCreatedByAvatar?: Avatar | null;
  workspaceCreatedAt: number | null;
}
```

Rules:
- **Selection id** = the integration id for connections/Slack/Telegram; the literal `"email"` for the email channel. Drives the `?selected=` search param (same mechanism as Automations).
- **Channels group** = email item (always present, see §6.4) + any `slack`/`telegram` integrations.
- **Connections group** = every other integration (all categories, including the outbound-only communication types **and any Gmail / Google-mail connections**).
- **Gmail connections are NOT channels.** A user can create their own Gmail connection (e.g. "Bella's Gmail App", "Bella's Google Gmail OAuth" in the screenshots) — those are ordinary connections and live under **Connections**. The **only** email *channel* is the single native, built-in, per-workspace email address (`email_handle`). The `CHANNEL_INTEGRATION_TYPES = ["slack", "telegram"]` rule already excludes Gmail, but call it out explicitly: **the prototype screenshots wrongly grouped the two Gmail connections under Channels — do not replicate that.** In those screenshots the real channel set is Slack + Telegram + native Email (3), not 4.
- Build the **slug map once** over `filterMentionableConnections(connections)` and pass it down; rows/panels read their slug from it. Slack and Telegram are `@`-mentionable today because they are real integration records and appear in the slug map. The native Email channel is not an integration record, so it must stay outside the slug map until Codex adds an explicit synthetic mention model (see §5 B7).

---

## 5. Backend data contract (for the backend/logic reviewer)

The current loader (`src/routes/_app.connections.tsx`) returns `Integration[]` with: `id, integration_type, name, category, auth_method, config (parsed), created_by (user id), created_at, updated_at, has_credentials`. That is enough for connection rows and most of a connection panel, but **the channel panels and a few panel fields need data the loader does not yet expose.** Per the spec, the backend should expose these rather than have the UI reconstruct them from KV.

**(A) Already available — no backend work:**
- Connection identity fields for archetypes that live in `config` (host/port/db/schema, project urls, scoping fields, server_url, region, etc.).
- `has_credentials` (drives the v1 "Stored / Not stored" + attention badge).
- `created_at` / `updated_at`.
- Mention slug (client-side via `buildSlugMap`).
- Provider icon + display name (registry + `integration-icons`).

**(B) Required new loader output / type expansion:**
1. **Do not keep using the raw `Integration` shape unchanged for panel data.** `WorkspaceIntegrationRecord` already has useful fields that `recordToIntegration()` currently drops (`auth_status`, `auth_error_code`, `auth_error_message`, `auth_checked_at`, `reauth_required_at`, `token_expires_at`). v1 can still render only `has_credentials`, but create a `ConnectionListItem`/extended integration type now so adding richer health later does not require another client contract rewrite. Keep secret-bearing `credentials_encrypted` server-only.
2. **Email channel** — add to the loader (the sibling settings route already uses the helpers):
   - `workspaceEmailAddress: string | null` via `buildWorkspaceEmailAddress(workspace.email_handle, domain)` where `domain = getWorkspaceEmailDomain(env)`.
   - `emailInboxEnabled: boolean` from `getBillingPlanLimits(authContext.currentOrg.billing_plan, authContext.currentOrg.billing_status).emailInbox`.
   - `emailHandle: string | null` (`workspace.email_handle`).
   - `workspaceCreatedBy` / `workspaceCreatedAt` from `authContext.currentWorkspace` for the email channel's housekeeping rows.
3. **Slack channel identity** — the current OAuth callback stores `team_name`, `team_id`, and `bot_user_id` only in encrypted credentials, while `SlackTeamRegistryDO` stores `team_id`/`bot_user_id` but not `team_name`. Do **not** expose credentials to the client. Preferred backend patch: when Slack connects or reauths, also mirror non-secret identity into integration `config` (`team_id`, `team_name`, `bot_user_id`). For existing Slack records, the loader may decrypt server-side once to backfill or to attach a sanitized `channelMetadata` object, but the browser should only receive those non-secret fields.
4. **Telegram channel identity** — connected chat metadata is already mirrored into the integration `config` by `completeTelegramSetup()` (`status`, `chat_id`, `chat_type`, `chat_title`, `connected_at`, `connected_by_telegram_user_id`, `bot_username`). `TelegramRegistryDO` is routing state keyed by chat id; it only returns `workspaceId`, `orgId`, and `integrationId`, so it is **not** the right source for panel display metadata. Read connected-state display fields from `config`. For the pending setup state, use `config.bot_username`, `config.setup_token`, `config.setup_expires_at`, `buildTelegramDeepLink()`, and `TELEGRAM_SETUP_TTL_SECONDS`.
5. **"Added by" display name** — the panel shows a person, not a user id. The loader returns `created_by` as an id only. Resolve unique creator ids with `getUsersByIds(getAuthEnv(env), ids)` and attach `{ created_by_name, created_by_avatar }` per connection (Automations already uses this shape). For the native Email channel, resolve `workspaceCreatedBy` into `workspaceCreatedByName` / `workspaceCreatedByAvatar` the same way.
6. **Capabilities** — see §7. Main now has a worker/runtime `summarizeConnection()` in `workers/main/src/connections-runtime.ts`, but it is not a client-safe helper to import into React. Either extract a tiny shared pure helper for display chips, or mirror the subset in §7 and keep it tested against `PROVIDER_MCP_REGISTRY`. Do not invent a separate capability taxonomy that drifts from runtime behavior.
7. **Native Email channel `@`-mention — NEEDS CODEX FEEDBACK (design + plumbing).** Product decision: a user should be able to `@`-mention **any** connection in chat, **including channels**. Slack and Telegram are already mentionable (they have integration records and appear in the slug map), so their chat affordance can use the existing connection mention path. **The native Email channel is the open problem:** it has no integration record, and the current mention system (`buildSlugMap`, `expandMentions`, `applyConnectionMentionContext`) resolves only real workspace integrations. What should `@`-mentioning the workspace email channel do, what slug should it use, and should it be represented as a synthetic mention item, a real hidden integration, or a separate channel mention type? Main already exposes outbound `send_email` through `js_exec`/deterministic workflow tools and `tools.help("send_email")`, and code mode can derive the workspace email address, so the backend work is about mention/context modeling rather than inventing a new send primitive. **This is out of scope for the UI plan — Codex (the backend/logic agent) should design and wire it.** Until it's defined, the UI renders the chat affordance for Slack/Telegram/connections and leaves a clearly-marked TODO for the Email item's chat icon + "Open in chat" + mention row (it reads a slug/handler the moment Codex provides one — no UI rework needed).

**(C) Explicitly deferred (NOT in v1 — keep the slot, don't build):**
- Rendering rich auth health: `authStatus`, `auth_checked_at`, `token_expires_at`, `auth_error_message/_code`, reauth CTA. The loader/type can carry these fields now because the DO already stores them, but v1's visible health signal remains `has_credentials`. The attention badge (§8.4) is designed so richer states can render later without moving layout.
- Live per-tool lists (`listConnectionMethods` now exists in `workers/main/src/connections-runtime.ts`, and `env.CONNECTIONS.methods()` exposes it inside `js_exec`, but it can fan out to MCP tool discovery). Capability chips only in the panel v1; do not lazy-load method schemas unless product explicitly asks for a "View tools" expansion.

> Backend reviewer: the UI is written to **degrade gracefully** if (B) fields are missing — channel panels show what they have and omit the rest; capability chips render nothing if the set is empty; "Added by" falls back to the raw id. Nothing crashes. But the channel panels are thin until the type expansion, email metadata, Slack metadata, and creator resolution land, so prioritize (B.1–B.5).

---

## 6. Page + list layout

### 6.1 Container (copy from `automations-client.tsx`)

```tsx
<div className="flex h-full min-h-0">
  <section className="flex min-w-0 flex-1 flex-col">
    <PageHeader breadcrumbs={[{ label: "Connections" }]} />
    <div className="min-h-0 flex-1">
      <ScrollArea className="h-full">
        <div className="mx-auto w-full max-w-5xl px-4 py-6 md:px-6">
          {/* header row, search/sort row, groups */}
        </div>
      </ScrollArea>
    </div>
  </section>

  <aside
    className={cn(
      "hidden shrink-0 overflow-hidden border-l bg-background transition-[width] duration-200 ease-out lg:flex lg:flex-col",
      selectedItem ? "w-[36rem]" : "w-0",
    )}
    aria-hidden={!selectedItem}
  >
    {selectedItem ? <ConnectionPanel item={selectedItem} {...} /> : null}
  </aside>
</div>

{/* Mobile: <Sheet> mirroring automations-client.tsx lines 643–675 */}
```

- Keep `max-w-5xl` (the grid wants more width than Automations' `max-w-4xl`).
- Panel width `w-[36rem]`, `transition-[width] duration-200 ease-out` — identical to Automations. Pure Tailwind, no animation library.
- Below `lg`, the panel is a right-side `Sheet` (`showCloseButton={false}`, `w-[90vw] max-w-none p-0`) reusing the same `ConnectionPanel`.

### 6.2 Header row

```tsx
<div className="flex flex-wrap items-start justify-between gap-4">
  <div className="min-w-0">
    <h1 className="text-2xl font-semibold">Connections</h1>
    <p className="mt-1 text-sm text-muted-foreground">
      Connect external services so your apps can read and write data.
    </p>
  </div>
  {isAdmin && (
    <Button onClick={() => setPickerOpen(true)} disabled={isLoading}>
      <Plus />
      Add connection
    </Button>
  )}
</div>
```

Keep the existing admin gate (`isAdmin`) and OAuth success/error toast handling from the current client.

### 6.3 Search + sort row (no category chips)

One row: a full-width search `Input` with a leading `Search` icon and a clearable `X` (copy the Automations search field markup, lines 569–590), and a `Select` for sort beside it:

```tsx
<div className="mt-6 flex flex-wrap items-center gap-2">
  <div className="relative min-w-[220px] flex-1"> {/* Search input, leading icon, clear button */} </div>
  <Select value={sortBy} onValueChange={...}>
    <SelectTrigger className="w-full sm:w-[170px]"><SelectValue /></SelectTrigger>
    <SelectContent>
      <SelectItem value="updated">Recently updated</SelectItem>
      <SelectItem value="name">Name (A–Z)</SelectItem>
      <SelectItem value="created">Newest first</SelectItem>
    </SelectContent>
  </Select>
</div>
```

- Search filters **both groups** by name / `integration_type` / provider display name (reuse current filter logic). The email item matches on "email" and its address.
- Sort applies **within** each group. Pin the Email item first in the Channels group; sort the rest.
- Drop the category `Tabs` and the "clear filters" bar entirely.
- Keyboard parity with Automations: `/` focuses search; `Escape` closes the panel.

### 6.4 Groups

Two stacked groups, **Channels first**, generous spacing between them (`space-y-8` or `mt-8` between groups). Each group has a header — uppercase, muted, letter-spaced label + muted count, **no divider rule**:

```tsx
<div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
  <span>Channels</span>
  <span className="tabular-nums">{channelItems.length}</span>
</div>
```

- The **Channels group is always shown** — the Email item is a first-class member even when the workspace has no Slack/Telegram and even when email is plan-gated (it renders with the gate note in its panel). This resolves the spec's open question "hide vs empty-state": never empty, never a separate empty state.
- If a search query empties a group, hide that group (header + grid). If both groups are empty, show a single muted "No connections match \"<query>\"." line (mirror `automation-list.tsx` lines 66–72).
- Do **not** keep the current top-level `connections.length === 0 ? empty-card : list` branch. Native Email makes the Channels group present even when there are zero integration records, so that branch would hide the Email channel and break the new model. Always build `channelItems` / `connectionItems` first, render the groups, then optionally show a compact admin-gated "Add your first connection" dashed prompt below the email-only Channels group when `connections.length === 0`.

### 6.5 Grid (collapses to one column when panel open)

Within each group:

```tsx
<div className={cn("mt-3 grid gap-3", selectedItem ? "grid-cols-1" : "grid-cols-1 md:grid-cols-2")}>
  {items.map((item) => <ConnectionRow key={item.id} item={item} ... />)}
</div>
```

When the panel opens, the `aside` compresses the `section` AND we force `grid-cols-1`. This matches the screenshots (two columns closed, one column open) and the spec's push-split requirement.

### 6.6 Row anatomy (`connection-row.tsx`)

Rows are visually uniform across groups. Each row is a clickable cell; the trailing icons are independently clickable (`stopPropagation`). Follow the Automations row interaction model (`role="button"`, Enter/Space to open, hover + selected backgrounds), but render as a bordered cell rather than a separator list item:

```tsx
<div
  role="button"
  tabIndex={0}
  onClick={() => onSelect(item)}
  className={cn(
    "group/row flex cursor-pointer items-center gap-3 rounded-lg border bg-card px-3 py-2.5 transition-colors hover:bg-muted/50",
    isSelected && "border-foreground/20 bg-muted/70",
  )}
>
  {/* logo well */}
  <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
    {hasIcon ? <IntegrationIcon type={resolvedType} className="size-5" /> : <FallbackIcon className="size-4" />}
  </div>

  {/* name — the only required text; no provider-name subtitle */}
  <span className="min-w-0 flex-1 truncate text-sm">{displayName}</span>

  {/* trailing actions */}
  <div className="flex shrink-0 items-center gap-0.5">
    {hasMention && (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="size-7" aria-label="Open in chat"
            onClick={(e) => { e.stopPropagation(); onNewChat(item); }}>
            <MessageSquare />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">Start a chat with @{slug}</TooltipContent>
      </Tooltip>
    )}
    {/* overflow menu — see §9; stopPropagation on trigger */}
  </div>
</div>
```

Row rules:
- **Name only** — no provider-name text next to the logo, no metadata, no status color, no badges. (Spec §4/§8.)
- **Chat icon appears on every mentionable item — connections AND channels.** Product decision: users can `@`-mention any connection, including channels. `hasMention` is true when the item resolves to a mention slug: connections + Slack + Telegram do (via `buildSlugMap`). The **native Email channel** has no slug yet — its `hasMention` stays false until Codex defines the email `@`-mention mechanism (§5 B7), at which point the icon lights up with no UI change. Rows stay structurally uniform either way.
- Icons render at all times (matches the screenshots), not hover-only.
- Use `resolveLogoType(integration_type, [config.display_name, name])` + `hasIntegrationIcon` for the logo, with a neutral fallback (`Settings`/`Plug`) — same as today. The email item uses a mail glyph (`Mail`).

---

## 7. Capability chips (Block 1 of connection panels)

Use small display chips, but keep their logic aligned with the connection runtime. Main now has worker-only helpers in `workers/main/src/connections-runtime.ts` (`summarizeConnection`, `fallbackCapabilities`, `listConnectionMethods`) and provider MCP metadata in `src/lib/provider-mcp-registry.ts`. Do **not** import worker code into the client. Implement a minimal pure display derivation in `connections-shared.ts`:

```ts
import { getProviderMcpDefinition } from "@/lib/provider-mcp-registry";

export type Capability = "query_database" | "mcp_tools" | "authenticated_fetch" | "channel_send";

export function deriveCapabilities(c: Integration): Capability[] {
  const caps: Capability[] = [];

  // User-facing chip: database connections are queryable even when runtime exposes
  // them through hosted MCP brokers rather than a literal "query_database" capability.
  if (c.category === "databases") caps.push("query_database");

  if (
    c.integration_type === "remote_mcp" ||
    getProviderMcpDefinition(c.integration_type)
  ) {
    caps.push("mcp_tools");
  }

  if (c.integration_type === "telegram") caps.push("channel_send");

  // Generic authenticated API fallback only when this is not a database, not an MCP-backed
  // provider, and not a channel-only integration.
  if (
    c.category !== "databases" &&
    c.integration_type !== "remote_mcp" &&
    !getProviderMcpDefinition(c.integration_type) &&
    c.integration_type !== "telegram"
  ) {
    caps.push("authenticated_fetch");
  }

  return caps;
}

export const CAPABILITY_LABEL: Record<Capability, string> = {
  query_database: "Query database",
  mcp_tools: "MCP tools",
  authenticated_fetch: "Authenticated API calls",
  channel_send: "Channel send",
};
```

Render as small chips using shadcn `Badge variant="secondary"`. If the set is empty, render nothing. No per-tool list in v1.

---

## 8. The detail panel (`connection-panel.tsx`)

Model it on `automation-panel.tsx`. Shared header + title for every item; the body branches by `kind`.

### 8.1 Chrome (header)

Copy the Automations header exactly (lines 300–330): a `flex shrink-0 items-center justify-between gap-3 px-6 py-5` row with the **type tag top-left** and **overflow `DropdownMenu` + close `X` `Button` top-right**. Then a `<ScrollArea className="min-h-0 flex-1">` wrapping `<div className="space-y-7 px-6 py-6">`.

### 8.2 Type tag + tooltip (§5 of spec — the primary teaching surface)

Reproduce `AutomationTypeChip` as `ConnectionTypeTag`:

```tsx
<Tooltip>
  <TooltipTrigger asChild>
    <span className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background/40 px-2.5 py-1 text-xs font-normal text-muted-foreground">
      {isChannel ? <Inbox className="size-3.5" /> : <Plug className="size-3.5" />}
      {isChannel ? "Channel" : "Connection"}
    </span>
  </TooltipTrigger>
  <TooltipContent side="bottom" className="max-w-72">{TYPE_COPY[kind]}</TooltipContent>
</Tooltip>
```

Tooltip copy (keep short, friendly, concrete):
- **Channel:** "A channel receives messages from outside camelAI — Slack, email, or Telegram — and turns them into threads the agent can reply to."
- **Connection:** "A connection gives the agent tools it can call. @-mention it in any chat to put its data and actions to work."

### 8.3 Title row + inline rename

Logo + name, prominent. **Legibility callout (spec §6.3 / §8):** the prototype rendered the name in dark text on the dark panel. Use theme tokens — `text-foreground`, never a hardcoded dark color.

```tsx
<div className="flex items-center gap-3">
  <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
    {/* IntegrationIcon / Mail for email */}
  </div>
  {isRenaming ? (
    <Input
      autoFocus
      value={renameValue}
      className="h-9 text-lg font-semibold"
      onChange={(e) => onRenameValueChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); onCommitRename(); }
        if (e.key === "Escape") { e.preventDefault(); onCancelRename(); }
      }}
      onBlur={onCommitRename}
    />
  ) : (
    <h2 className="min-w-0 flex-1 truncate text-2xl font-semibold leading-tight text-foreground">{name}</h2>
  )}
</div>
```

**Inline rename is the chosen rename UX (not the edit dialog).** Mechanics mirror the Automations inline rename (`automation-row.tsx` / `automations-client.tsx`), but the input lives in the **panel title**:
- Enter edit mode via the overflow **"Rename"** item (§9). If the panel is closed, open it first, then enter edit mode.
- Commit on **Enter** or **blur**; cancel on **Escape**. A no-op (empty or unchanged) silently exits.
- Commit submits the existing **`updateIntegration`** action with `name` only (`fetcher.submit({ intent: "updateIntegration", integrationId, name }, { method: "post", action: "/connections" })`). No new server action.
- The current `/connections` action returns only `{ success: true }`, unlike Automations which returns the updated item. If you want optimistic rename, keep local `connections` state plus a `pendingAction` ref and rollback on `fetcher.data.error`, then call `revalidator.revalidate()` on success so timestamps/server state catch up. Simpler acceptable v1: no optimistic update; keep the input disabled/submitting, toast on error, and revalidate after success. Do not assume loader-owned `initialConnections` will update just because `fetcher.submit()` succeeded.
- **Applies to connections + Slack + Telegram.** The **Email** channel name is not editable (`email` has no integration record; managing the address is a workspace-settings concern — link out, don't inline-edit). Disable/omit "Rename" for the Email item.
- Config/credentials/reauthorize still go through `EditConnectionDialog` via the overflow **"Configure"** item; only the *name* is inline.

### 8.4 Attention badge (v1 = `has_credentials` only)

Single badge, shown **only when something needs attention**; nothing when healthy. v1 has one signal: `!has_credentials` → a grey "Setup incomplete" `Badge variant="secondary"` placed in the title row (right-aligned) or directly under the title. Do not show anything when `has_credentials` is true. Design the slot so the deferred amber/red states (§5C) can drop in later without moving layout.

### 8.5 Body — connection vs channel

**No "Description" section for either kind** (spec §6.4). Go from title → (connection: action row) → sections. Use the Automations `DetailRow` (label-left/value-right) and section header patterns verbatim:

```tsx
function DetailRow({ label, children }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-3 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right text-foreground">{children}</dd>
    </div>
  );
}
// Section header: <h3 className="mb-3 text-xs font-medium uppercase text-muted-foreground">…</h3>
```

**Shared "Use in chat" block** (used by both connections and channels — keep it one component):
- **Action row** (spec §6.5): an outlined `Button variant="outline"` "Open in chat" with a `MessageSquare`/`ExternalLink` icon → calls `handleNewChat(item)`. Beneath it, a muted helper line: *"Starts a new chat with @{slug} already attached."* (Same education moment as the row chat icon.)
- **Mention** `DetailRow`: `@{slug}` with a copy `Button` (`Copy` icon) → clipboard. Slug from the shared slug map.
- **Capabilities** (connections only): capability chips (§7). Omit the row if empty; channels don't show capability chips.
- Render this whole block only when the item is mentionable (`hasMention`). For the native Email channel it's hidden until Codex defines the email mention mechanism (§5 B7).

#### Connection body

1. **Use in chat** block (shared, above).
2. **Connection details** section — varies by archetype. Map `integration_type` → which `config` keys to surface. Define the mapping in `connections-shared.ts`. Read values from `connection.config` (already parsed). Never render secrets or full connection strings.

   | Archetype | Types | Detail rows (from `config`) |
   |---|---|---|
   | A. Direct DB | postgres, mysql, clickhouse, mongodb, redis, snowflake | host/endpoint, port, database, schema (whichever exist). Snowflake → account, warehouse. Mongo/Redis → host/cluster target only (never the connection string). |
   | B. Hosted DB | supabase, neon, planetscale, turso, databricks, bigquery | project/instance identity: project url, database url, project id + dataset (bigquery), workspace url (databricks). |
   | C. API-key SaaS | stripe, linear, github, notion-by-key, hubspot, airtable, … | usually none → section minimal/omitted. Types with a scope field show just it: domain (jira), subdomain (zendesk), shop_domain (shopify), data_center (mailchimp), region/environment (square, amplitude), host/project_id (posthog). |
   | D. OAuth SaaS | notion, salesforce | connected account/instance (`instance_url` for salesforce). Reconnect via overflow → OAuth redirect helper (§9), not `EditConnectionDialog` (that dialog only has a remote-MCP OAuth button today). |
   | E. Remote MCP | remote_mcp | server url, transport, auth type (none/bearer/custom header/oauth). OAuth variant → reconnect CTA. |
   | F. Other | other | base url, auth type, user-entered display name/description. |
   | G. Cloud | aws, gcp, azure, vercel, netlify, cloudflare | scope: region + role_arn (aws), project_id (gcp), tenant/subscription (azure), team_id (vercel), account_id (cloudflare). |
   | H. AI services | openai, anthropic, openrouter | minimal: provider name, organization_id (openai) if set. Keep tiny. |

   **Allowlist callout:** when the integration's registry entry has `requiresOutboundIpAllowlist === true` (currently postgres, mysql, snowflake, clickhouse, mongodb, redis), render a small muted callout inside this section showing the egress IP `SANDBOX_OUTBOUND_IP` (`20.46.233.68`, from `src/lib/sandbox-network.ts`) with a copy button and a link to `SANDBOX_NETWORK_DOCS_URL`. Drive it off the registry flag, not a hardcoded type list — it stays correct if the flag set changes. (Spec named four types; the flag also covers postgres/mysql, which is fine and arguably better.)

3. **Status & housekeeping** section:
   - **Credentials**: "Stored" / "Not stored" (`has_credentials`) + an "Update credentials" `Button` → opens `EditConnectionDialog` with `forceCredentialUpdate`.
   - **Added by**: resolved name + `Avatar` (mirror Automations `CreatedBy`); fall back to the raw `created_by` id if unresolved.
   - **Added on**: `created_at`.
   - **Last edited**: `updated_at`.
   - (Deferred: last-checked / token-expiry / error detail — §5C.)

#### Channel body

Channels **lead with where messages arrive**, but — per the product decision in §5 B7 — they **do** get the shared Use-in-chat block when mentionable (Slack/Telegram are; native Email is pending Codex). No play/pause control. After the shared header/title:

1. **Destination & identity** section (per channel) — the hero, placed first:

   **Slack**
   - Connected Slack workspace name (`team_name`) — the hero value. Read from sanitized loader metadata / mirrored `config`, not from client-side credential decryption.
   - Team id (`team_id`) and bot user (`bot_user_id`) — quiet/secondary.
   - Routing note (muted helper): "Messages from this Slack workspace start threads here."

   **Email**
   - **Inbound address** (`workspaceEmailAddress`) — hero value, read-only, with a copy button. If `null` (no domain configured) show a muted "Email isn't configured for this workspace yet."
   - Reply-from = same address (state it).
   - **Plan gate:** if `!emailInboxEnabled`, show a muted note that the workspace's plan doesn't include the email inbox (point to upgrade / workspace settings). Still show the address.
   - Routing note: "Email to this address starts a thread in this workspace. Only workspace members can send."

   **Telegram** — two states:
   - *Mid-setup* (`config.status === "pending"`): hero is the deep link `buildTelegramDeepLink(bot_username, setup_token)` with an "expires in N min" countdown (`setup_expires_at` / `TELEGRAM_SETUP_TTL_SECONDS`). QR optional (skip in v1).
   - *Connected*: linked chat title + chat type (group/private/supergroup), bot username, connected-at, connected-by Telegram user id. These fields are already in `connection.config` after setup; do not query `TelegramRegistryDO` for display metadata.

2. **Use in chat** block (shared, see above) — for Slack/Telegram. Hidden for the native Email channel until its mention mechanism lands (§5 B7). This lets a user `@`-mention a channel in chat, but do not overpromise routing: Slack still needs a Slack `channel_id` outside a Slack-originated thread, while Telegram can send with `integration_id` and can omit it only when exactly one connected Telegram integration exists (current runtime behavior).
3. **Status & housekeeping** section — Credentials status (where meaningful), Added by / Added on / Last edited. For Slack/Telegram these are the integration record's `created_by`/timestamps; for **Email** this section uses `workspaceCreatedBy`/`workspaceCreatedAt`, shows the workspace email handle, and links to `/settings/workspace/general` to manage it.

---

## 9. Overflow menu actions

The **row** overflow (`connection-row.tsx`) and the **panel** overflow (`connection-panel.tsx`) are **identical** — same items, same order, same gating. Build them from one shared menu component so they can't drift. (This overrides the spec's "clone is row-only" decision per product: Clone appears in both.)

| Item | Notes |
|---|---|
| Rename | Enters **inline rename** (§8.3). From the row, this opens the panel (if closed) and focuses the title input. Connections + Slack + Telegram only; omitted for Email. Admin only. |
| Configure (config/credentials) | → `EditConnectionDialog`. Admin only. Omitted for Email. |
| Reconnect / Re-link | Slack/Notion/Salesforce → start the existing `/api/integrations/:type/oauth` flow with `integration_id` + `redirect=/connections`; factor the current `?connection=...&reauth=1` effect into a direct `startReauth(connection)` helper. `remote_mcp` OAuth can keep using the existing button in `EditConnectionDialog` or the same helper if extracted. Telegram **does not** have an existing relink action; either omit "Re-link" in v1 or add a small backend action that regenerates `setup_token`, writes `status: "pending"` / `setup_expires_at` to the existing integration, stores the setup token in `TelegramRegistryDO`, and returns `buildTelegramDeepLink(...)`. |
| Clone to workspace | Admin, and only when `otherWorkspaces.length > 0`. → existing clone `Dialog`. Omitted for Email (no record to clone). |
| Delete | Destructive `variant="destructive"`. → existing delete `ConfirmDialog`. Admin only. Omitted for Email. |

- **Email channel** has no integration record, so most items are omitted. Its menu is minimal — "Copy address" and "Manage email settings" (link to `/settings/workspace/general`). If that leaves the Email menu with only those two utility items, that's fine; the menus are "identical" in the sense of one shared component whose items are gated by item kind/permissions, not literally the same set for the record-less Email item.
- Non-admins: hide Rename/Configure/Reconnect/Clone/Delete (match the current `isAdmin` gate). Channels are typically admin-managed.
- Use `stopPropagation` on the trigger so opening the menu doesn't open/swap the panel (mirror `automation-row.tsx`).

---

## 10. Motion, responsive, accessibility

- **Push-split**: list compresses, panel is never an overlay (desktop). `transition-[width] duration-200 ease-out`, width `0 ↔ 36rem`. Closed on first load.
- **Stay-open navigation**: clicking another row swaps panel content in place via the `?selected=` param; the panel does not close. Selection state highlights the active row.
- **Close**: the `X` in the panel header and `Escape` clear `?selected=` and restore the full-width two-column grid.
- **Mobile (`< lg`)**: panel becomes a right `Sheet` (copy the Automations Sheet block). The two-column grid naturally falls to one column on small screens regardless of panel state.
- **A11y**: rows are `role="button"` + `tabIndex={0}` with Enter/Space handlers; `aria-hidden` on the collapsed `aside`; `aria-label`s on icon buttons; tooltips via shadcn `Tooltip` (Radix). Wrap the page in a `TooltipProvider` (the current client already does).

---

## 11. Resolved decisions + the one Codex callout

Decisions locked for v1 (no further product input needed):
1. **Overflow menus are identical** (one shared component), and **Clone appears in both** row and panel — overriding the spec's "clone is row-only." See §9.
2. **Channel routing = read-only note** in the panel. No deep-link to a fuller routing config screen in v1.
3. **Channels group is always shown**; the native Email item is always a member, so the group is never empty (no separate empty state).
4. **Every mentionable item gets the chat affordance** (icon + Open-in-chat + mention slug) — connections **and** channels. Users can `@`-mention a channel. Slack/Telegram resolve through existing integration mentions today, with the routing caveats in §8.5; the native Email channel is the lone exception pending Codex (below).
5. **Rename is inline in the panel title** (§8.3), submitting the existing `updateIntegration` action — not the edit dialog.

**Needs Codex (backend/logic) feedback — native Email channel `@`-mention (§5 B7):** the native per-workspace Email channel has no integration record and no mention slug, so "how does a user `@`-mention it, what slug, and what does the agent receive" is undefined. This is **out of scope for the UI plan** — Codex should design and wire it. The UI is built so the Email item's chat icon / Open-in-chat / mention row light up automatically once a slug/handler exists (`hasMention` flips to true). Related: **Gmail connections are ordinary connections, not channels** (§4) — the prototype mis-grouped them; don't.

---

## 12. Out of scope (v1)

- Rendering rich auth health (reauth/error/expiry/last-checked) and the amber/red attention states. The type can carry those backend fields now; the UI does not need to surface them in v1.
- Live per-tool lists / `listConnectionMethods` rendering ("View tools" expansion). The runtime helper exists, but panel v1 should avoid method-schema discovery.
- Status colors on rows, metrics/sparklines, provider-name text beside logos, category filter chips, play/pause controls, recent-activity/audit history, OAuth scope lists, QR code for Telegram.

---

## 13. Acceptance criteria

- `/connections` shows two labeled groups — **Channels** (native Email always present; Slack/Telegram when connected) and **Connections** (everything else, including SendGrid/Twilio/Discord/Teams **and Gmail/Google-mail connections**) — each with an uppercase muted label + count and no divider rule. Gmail connections are NOT in Channels.
- A workspace with zero integration records still renders the native Email row in Channels; the "Add your first connection" prompt, if shown, appears below the groups and does not replace the whole list.
- The list is a two-column grid that collapses to one column when the detail panel is open; the panel is a push-split that compresses the list (desktop) and a `Sheet` on mobile, closed on first load, content-swaps in place, closes via `X`/`Escape`.
- Rows show only a provider logo + name + (on mentionable items) a chat icon + overflow; no status color, metadata, or provider-name text. Hover and selected states are visible. The chat icon appears on connections, Slack, and Telegram; on the native Email item only once its mention mechanism is wired (§5 B7).
- The panel matches the Automations panel chrome: type tag (with hover tooltip teaching channel-vs-connection) top-left, overflow + close top-right, uppercase section headers, label-left/value-right rows. Panel text is `text-foreground` (legible on dark).
- Connection panels show: the shared Use-in-chat block (Open-in-chat action + helper, copyable mention slug, capability chips), archetype-appropriate detail rows (with the egress-IP allowlist callout for `requiresOutboundIpAllowlist` types), and credential/added-by/timestamps. No description section.
- Channel panels lead with destination/identity (Slack workspace, email inbound address, Telegram chat/setup), and Slack/Telegram also render the shared Use-in-chat block so they're `@`-mentionable without implying a Slack default destination.
- **Rename is inline** in the panel title (Enter/blur commits, Escape cancels), wired to the existing `updateIntegration` action; available for connections/Slack/Telegram, not Email.
- Add/Edit/Delete/Clone work through the existing dialogs and server `action`; OAuth reconnect uses the existing provider OAuth routes with `integration_id`, except Telegram re-link which is omitted in v1 unless the new backend action in §9 is added.
- Add focused tests for `connections-shared` partitioning/sorting (`email` always first, Slack/Telegram channels, Gmail/SendGrid/Twilio/etc. connections), capability derivation including provider-MCP-backed integrations, and any loader metadata helper added for email/creator display. `bun run typecheck` passes; the most relevant Vitest tests pass.
