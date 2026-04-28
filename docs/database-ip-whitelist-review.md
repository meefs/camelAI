# Code review — Sandbox IP whitelisting

**Plan reviewed against:** `docs/database-ip-whitelist-plan.md`
**Reviewer:** illiana (via Claude)
**Branch:** `illianaa/whitelist-ip-plan`
**Files changed:** 8 modified, 2 added

## Verdict

Implementation matches the plan closely. All structural decisions landed where they were supposed to, the per-integration flag is wired correctly, and the `instructions`-field plumbing for static integrations is a nice cross-cutting addition that wasn't in the plan but is the right call. Ship-ready with a few small follow-ups.

## What landed correctly

| Plan item | Status | Notes |
|---|---|---|
| `SANDBOX_OUTBOUND_IP` + `SANDBOX_NETWORK_DOCS_URL` in new `src/lib/sandbox-network.ts` | ✅ | Single source of truth, exactly as specced. |
| New shared `<SandboxIpNotice />` component | ✅ | `src/components/connections/sandbox-ip-notice.tsx`. Copy button + clipboard fallback + "Learn more" link. |
| `requiresOutboundIpAllowlist?: boolean` on `IntegrationDefinition` | ✅ | Added to interface, set on the six v1 types. |
| Flag enabled for: postgres, mysql, clickhouse, mongodb, redis, snowflake | ✅ | All six. `mssql` correctly **not** set (not in registry yet). `neon` and `planetscale` correctly **not** set (deferred per plan). |
| Notice placement between config block and credentials block | ✅ | `AddConnectionDialog.tsx:205` and `connection-setup-prompt.tsx:362`. Matches the ASCII mockups in the plan. |
| Always-on system-prompt note in `<environment_variables>` block | ✅ | `sandbox/control-plane.mjs:348`. Single sentence; lists all 7 DB types (incl. mssql). |
| MCP tool description updated to remind agents to mention the IP in `instructions` | ✅ | `workers/main/src/mcp-handler.ts:1186`. |
| AGENTS.md updated with one-line summary | ✅ | Under the Data Proxy section. |

## Beyond-plan additions worth noting (all positive)

The agent extended `instructions` to flow through the **static** (non-`other`) connection-setup path. Previously, `instructions` only worked for dynamic "other" integrations via `dynamicSchema.instructions`. The plan's system-prompt change encourages the agent to use `instructions` to mention the IP for `postgres`/`mysql`-shaped calls, and without this plumbing that guidance would have silently no-op'd for non-`other` types. Specifically:

- `ConnectionSetupRequest`/`PendingConnectionSetupInfo` types both gain `instructions?: string` (`workers/main/src/durable-objects.ts:51,148`).
- `ChatThreadDO` persists `instructions` to KV and replays it on hibernation recovery + on `sendPendingPromptsToWebSocket` (lines 948, 952, 960, 3076). Persistence is consistent with the existing pattern for `message`/`dynamicSchema`.
- `Chat.tsx` forwards the field from the websocket event into `ConnectionSetupPromptData`.
- `connection-setup-prompt.tsx` falls back to `data.instructions` when there's no `dynamicSchema.instructions`, and renders it through the same markdown block.

Net effect: the agent can now provide markdown setup instructions for any DB type, which is a useful capability beyond just the IP-whitelist use case. Recommend keeping this.

## Suggested follow-ups (none blocking)

### 1. Drift risk between system-prompt DB list and the registry flag

`sandbox/control-plane.mjs:348` hardcodes the seven DB types ("postgres, mysql, mssql, clickhouse, mongodb, redis, snowflake") in the system-prompt sentence. The registry uses `requiresOutboundIpAllowlist: true` as the source of truth. These can drift — e.g., if `mssql` lands in the registry with the flag and someone forgets to update the system prompt, the agent will know about the IP but not that mssql counts. Conversely, if we flip `neon`/`planetscale` on later, the system prompt won't mention them.

**Suggestion:** add a short code comment near the system-prompt line pointing to `INTEGRATION_REGISTRY[*].requiresOutboundIpAllowlist` as the canonical list, or generate the sentence at startup by joining the flagged types. Comment is fine for now; codegen is overkill for one line.

### 2. Dynamic ("other") integrations don't get the notice

The condition `!isDynamic && typeDef?.requiresOutboundIpAllowlist` is correct — dynamic schemas don't have a fixed DB type — but it means an agent that uses `prompt_connection_setup` with `integration_type: "other"` to set up a Postgres-style direct connection won't see the notice in the modal. Mitigation today is the system-prompt instruction telling the agent to put the IP in `instructions`. Low-likelihood gap, not worth code today; flagging for awareness.

### 3. Copy fallback failure is silent

`SandboxIpNotice` uses `navigator.clipboard.writeText` and falls back to `document.execCommand('copy')`. If both fail (rare), the `catch` block sets `copied(false)` with no toast or error indication. The user clicks Copy and nothing happens visually. Fine for v1 — but if support tickets come in, consider a `sonner` toast on failure.

### 4. Snowflake form: notice sits above the `<SnowflakeCredentialsForm />`

For Snowflake specifically, the credentials block is a custom component (`SnowflakeCredentialsForm`) rather than the standard credential field loop. The notice still renders correctly above it (between config block and credentials block), but worth eyeballing the actual rendered modal once — the Snowflake form is denser than the standard one, and the notice may visually compete. Pure visual review, no code change predicted.

### 5. No tests added

Plan didn't ask for any, and the changes are mostly UI/copy. If you want a regression guardrail, the highest-value tests would be:
- A render test asserting `SandboxIpNotice` is rendered for `postgres` and absent for `supabase` in `AddConnectionDialog`.
- A snapshot/DOM test on `SandboxIpNotice` itself to lock the IP string `20.46.233.68` and the "Learn more" link target — both are user-contract-shaped.

### 6. Docs draft was correctly left alone

The plan instructed: "if your implementation diverges from the mockup, update the docs draft below." The implementation matches the plan's mockups (placement, copy intent, "Learn more" link wired to `SANDBOX_NETWORK_DOCS_URL`), so the agent correctly left `docs/database-ip-whitelist-plan.md` untouched. illiana can hand-port the draft to the docs repo as planned. ✅

## Design feedback (post-screenshot review)

The functional implementation is correct, but the rendered notice feels cramped and includes a few elements that should come out. Four concrete changes:

### 1. Drop the info icon

The leading `<Info />` icon competes with the "Network access" title for the same horizontal space and makes the alert feel busy. The title alone is enough — users already know it's an informational block from its placement and styling.

### 2. Drop the "Learn more" link

The link points to `https://docs.camelai.com/connections/network-access`, which doesn't exist yet. Shipping a 404 link is worse than not linking at all. Remove the link and the `SANDBOX_NETWORK_DOCS_URL` import for now. When the docs page is published, add it back in a one-line change. (Keep the constant defined in `src/lib/sandbox-network.ts` — or delete it for now and re-add when needed; either is fine, slight preference for removing dead code.)

### 3. The IP itself is the copy button

Right now there are two click targets — the IP code-pill and a separate "Copy" button. Collapse them into one: the IP pill *is* the button. Click anywhere on `20.46.233.68` and it copies. Show the copy/check icon inside the pill (right side) so the affordance is still visible, and toggle to a check briefly after click.

**Two specifics the implementing agent must get right — these are not optional:**

#### 3a. Use the existing `Copy` icon from `lucide-react`

The current implementation already imports `Copy` and `Check` from `lucide-react` — **keep using those**. The `Copy` icon from lucide is the two-overlapping-squares glyph that's used everywhere else in the codebase for copy buttons (e.g., the existing `CopyButton` patterns in chat, code blocks, etc.). Do **not** swap to `Clipboard`, `ClipboardCopy`, `ClipboardCheck`, or any other clipboard-shaped icon — those don't match the rest of the UI. The icon contract is:

```tsx
import { Copy, Check } from 'lucide-react';
// idle:    <Copy className="size-3.5" />
// success: <Check className="size-3.5" />
```

If you're tempted to reach for a different icon because "clipboard" feels more semantically right — don't. Codebase consistency wins.

#### 3b. The pill's background must match the alert's background

In the current screenshot the IP pill has a darker background than the surrounding alert (the agent used `bg-background` on a `bg-primary/5` alert). That darker fill makes it look like an editable input field, which is wrong — it's a button, not a textbox.

The pill should be **visually flush with the alert**: same background as the alert body, with only a subtle border (or no border, just a hover state) to communicate the click target. On hover, darken slightly to confirm interactivity.

Concretely — drop `bg-background`. The pill should inherit the alert's background. Use `border-border/50` (or remove the border entirely) and add `hover:bg-muted/50` for the interaction affordance.

#### Putting 3a and 3b together — target markup

```tsx
<button
  type="button"
  onClick={copyIp}
  className="inline-flex items-center gap-2 rounded border border-border/50 px-3 py-1.5 font-mono text-sm transition-colors hover:bg-muted/50"
  aria-label={copied ? 'Copied' : `Copy IP address ${SANDBOX_OUTBOUND_IP}`}
>
  <span>{SANDBOX_OUTBOUND_IP}</span>
  {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
</button>
```

Note: **no `bg-background`**. The pill sits on whatever background the parent `<Alert />` provides, which is what we want.

This kills one element, makes the click target bigger, removes the "this looks like an input" affordance bug, and matches the copy-icon pattern used everywhere else in the codebase.

### 4. Drop the "API-based services such as Supabase and BigQuery don't need this." sentence

Anyone reading this notice is already inside the Postgres or MySQL (or other flagged DB) form. Telling them BigQuery doesn't need allowlisting is irrelevant context — they're not connecting BigQuery. The sentence adds visual weight without helping the person in front of it. Remove.

### Resulting alert (target)

```
╭────────────────────────────────────────────────────────╮
│  Network access                                        │
│                                                        │
│  If your database sits behind a firewall or VPC,       │
│  allowlist camelAI's outbound IP:                      │
│                                                        │
│   ┌─────────────────────┐                              │
│   │ 20.46.233.68     📋 │   ← whole pill is one button │
│   └─────────────────────┘                              │
╰────────────────────────────────────────────────────────╯
```

Three lines of content instead of five, one click target instead of three, no broken link. Same information density where it matters.

### Files to touch

Only `src/components/connections/sandbox-ip-notice.tsx`. No other component or constant needs to change.

## Diff summary

```
 AGENTS.md                                                 |  1 +
 sandbox/control-plane.mjs                                 |  2 ++
 src/components/Chat.tsx                                   |  1 +
 src/components/connection-setup-prompt.tsx                |  9 +++++++--
 src/components/pages/connections/AddConnectionDialog.tsx  |  3 +++
 src/components/connections/sandbox-ip-notice.tsx          | 78 ++++ (new)
 src/lib/integration-registry.ts                           |  7 +++++++
 src/lib/sandbox-network.ts                                |  5 ++++ (new)
 workers/main/src/durable-objects.ts                       |  5 +++++
 workers/main/src/mcp-handler.ts                           |  3 +-
```

Small, focused, and matches the plan. Approve.
