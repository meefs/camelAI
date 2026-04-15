# Domains Settings Page Redesign

## Problems with the Current Page

1. **Layout inconsistency** — Uses a side-by-side `grid-cols-[1.35fr_1fr]` layout with "Step 1" and "Step 2" cards that doesn't match other settings pages (General, AI Provider, Team, etc.), which all use a single-column stacked layout.
2. **Confusing information hierarchy** — An overview card on top, then two cards side by side. The "Step 2: What happens next" card is just static text explaining how things work — it's not really a "step" the user performs.
3. **No per-app status visibility** — The user has no idea which apps have active SSL, which are pending, or which failed. They only see the org-level domain status badge.
4. **No agent troubleshooting handoff** — Users who get stuck have no clear path to get help. They email support instead.
5. **DNS records are hard to copy** — Records are shown in a grid that's visually dense but functionally clunky. Users need to copy individual field values from small monospace text.

## Design Goals

- Match the single-column stacked layout used by other settings pages
- Show per-app hostname status so users can see exactly what's working
- Add a clear "Get help" path that starts a chat with a pre-populated troubleshooting message
- Make DNS records easy to copy with explicit copy buttons
- Reduce visual noise — remove the "Step 1 / Step 2" framing and the "what happens next" card

## MCP Permission Fix (already applied)

The `retry_custom_domain_hostnames` tool requires org admin permissions. The final fix does not trust the sandbox proxy's cached `userId`, because that value is connection-scoped and can be stale in multi-user threads. Instead, the control plane reports the currently active turn author to `ChatThreadDO`, and `handleMcpRequest` resolves MCP auth from that turn-scoped user before dispatching the request. This also fixes `set_custom_domain` and `remove_custom_domain`, which use the same admin check.

---

## Proposed Layout

### State: No domain configured

```
┌─────────────────────────────────────────────────────────────────┐
│  Domains                                                        │
│  Point your own domain at camelAI so every app lives at         │
│  {app-name}.your-domain.                                        │
├─────────────────────────────────────────────────────────────────┤
│  ─────────────── separator ───────────────                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  Connect a custom domain                                │    │
│  │                                                         │    │
│  │  Your apps currently use *.camelai.app URLs. Add a      │    │
│  │  base domain to serve them at {app-name}.your-domain.   │    │
│  │                                                         │    │
│  │  ┌──────────────────────────┐  ┌──────────────┐         │    │
│  │  │  apps.example.com        │  │  Add Domain  │         │    │
│  │  └──────────────────────────┘  └──────────────┘         │    │
│  │                                                         │    │
│  │  ℹ After adding, we'll show the DNS records to          │    │
│  │    configure at your DNS provider.                      │    │
│  │                                                         │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Implementation:**
- Single `Card` with `CardHeader` (title + description) and `CardContent` (input + button + hint)
- Same `Input` + `Button` row pattern as current
- Remove the three mini-cards ("1. Add your base domain", "2. Point DNS", "3. Wait") — they add visual complexity without value before the user has committed to a domain

### State: Domain configured

```
┌─────────────────────────────────────────────────────────────────┐
│  Domains                                                        │
│  Point your own domain at camelAI so every app lives at         │
│  {app-name}.your-domain.                                        │
├─────────────────────────────────────────────────────────────────┤
│  ─────────────── separator ───────────────                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ── Section: Domain ────────────────────────────────────────    │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  illiana.me                        [Pending activation] │    │
│  │                                                         │    │
│  │  Apps are served at {app-name}.illiana.me.               │    │
│  │  URLs switch from *.camelai.app once each app's         │    │
│  │  hostname and SSL certificate are active.               │    │
│  │                                            [Remove]     │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                 │
│  ── Section: DNS Records ───────────────────────────────────    │
│                                                                 │
│  Add both records at your DNS provider.                         │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  Routing                                                │    │
│  │                                                         │    │
│  │  Type    CNAME                                          │    │
│  │  Name    *                                       [Copy] │    │
│  │  Target  custom-domains.camelai.app              [Copy] │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  SSL Validation                                         │    │
│  │                                                         │    │
│  │  Type    CNAME                                          │    │
│  │  Name    _acme-challenge.illiana.me               [Copy]│    │
│  │  Target  1b7fee6764db9b60.dcv.cloudflare.com      [Copy]│    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                 │
│  ℹ If your DNS provider doesn't support wildcard records,       │
│    add per-app CNAME records instead.                           │
│                                                                 │
│  ── Section: App Status ────────────────────────────────────    │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  App               Hostname                   Status    │    │
│  │  ───────────────────────────────────────────────────── │    │
│  │  illiana-homepage   illiana-homepage.illiana.me  ● SSL   │    │
│  │                                                 pending │    │
│  │  portfolio          portfolio.illiana.me         ● SSL   │    │
│  │                                                 pending │    │
│  │  blog               blog.illiana.me              ✓ Active│    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                 │
│  ── Section: Need Help? ────────────────────────────────────    │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  ℹ Having trouble with your custom domain?              │    │
│  │                                                         │    │
│  │  The camelAI agent can check your DNS records, verify   │    │
│  │  SSL status, and walk you through fixes.                │    │
│  │                                                         │    │
│  │  [Troubleshoot in Chat →]                               │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Section Details

### 1. Domain Header Card

- Single `Card` with the domain name as `CardTitle` in monospace + status `Badge`
- Description explains the wildcard model in one sentence
- `Remove` button (destructive variant, small) in the card footer or aligned right
- Status badge colors: `active` → green/default, `pending` → secondary/yellow, `failed` → destructive

### 2. DNS Records Section

- Section heading: "DNS Records" (plain `h3` or label, not a card title — keeps it lightweight)
- Subtext: "Add both records at your DNS provider."
- Two stacked bordered containers (not full `Card`s — use `rounded-md border p-4` like the current design but cleaned up)
- Each record shows three rows in a simple label-value layout:
  - **Type** — static "CNAME"
  - **Name** — the host value with a copy button
  - **Target** — the target value with a copy button
- Copy buttons: use a small `Button variant="ghost" size="icon"` with `Copy` icon from lucide, with a brief "Copied!" tooltip/state on click
- Below both records: the wildcard fallback info alert (keep the existing `Alert` with `Info` icon)

### 3. App Status Section

- Section heading: "App Status"
- Use a simple `Table` (shadcn `Table`, `TableHeader`, `TableBody`, `TableRow`, `TableCell`) — not cards
- Columns: **App** (script name), **Hostname** (monospace), **Status** (badge or dot indicator)
- Status rendering:
  - `active` + `active` → green dot + "Active"
  - `pending` / `pending_validation` → yellow dot + "SSL pending"
  - `failed` → red dot + "Failed" (show error in a tooltip or small text)
  - `null` (no hostname) → gray dot + "Not provisioned"
- If there are no apps, show a brief empty state: "No apps deployed yet. Deploy an app and its custom hostname will be created automatically."
- This section needs the loader to fetch `listWorkerScripts()` with custom domain fields — the current loader doesn't do this. Add it.

### 4. Need Help Section

- Use an `Alert` (not a `Card`) with `Info` icon — keeps it visually lightweight
- Title: "Having trouble with your custom domain?"
- Body: "The camelAI agent can check your DNS records, verify SSL status, and walk you through fixes."
- Button: `Button variant="outline" size="sm"` with text "Troubleshoot in Chat" and an `ArrowRight` or `MessageSquare` icon
- **Button behavior:** Uses the existing `pendingMessage:newThread` sessionStorage pattern:
  1. Creates a new thread via the standard thread creation API
  2. Seeds `sessionStorage` with key `pendingMessage:newThread` containing a message like: `Help me troubleshoot my custom domain setup. My base domain is {domain.domain}.`
  3. Navigates to `/chat/{threadId}?newThread=1`
  4. The agent picks up the message, reads the `custom-domain-troubleshooting` skill, and calls `get_custom_domain` to start diagnosing
- Note: This is a plain user message, NOT a `<camelai system message>`. The user should see their own prompt in the chat.

---

## Loader Changes

The current loader fetches:
- `domain` (org custom domain)
- `admin` (isAdmin check)
- `dcvUuid` (DCV delegation UUID)

Add:
- `apps` — call `orgStub.listWorkerScripts()` to get per-app custom domain fields. Map to a lightweight shape: `{ name, hostname, status, ssl_status, error }`. Only include apps that have a custom domain hostname set OR where the org has a custom domain (to show "not provisioned" state).
- `workspaceId` — needed for the "Troubleshoot in Chat" button to create a new thread

---

## Components

All from shadcn/ui — no custom components needed beyond what exists:

| Component | Usage |
|-----------|-------|
| `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent` | Domain header card, "Connect" card |
| `Badge` | Domain status, app status |
| `Button` | Remove, Add Domain, Copy, Troubleshoot in Chat |
| `Input` | Domain input |
| `Alert`, `AlertDescription` | Error, wildcard fallback info, help section |
| `Table`, `TableHeader`, `TableBody`, `TableRow`, `TableHead`, `TableCell` | App status table |
| `Separator` | Page header separator |
| `Tooltip`, `TooltipTrigger`, `TooltipContent` | Copy confirmation, error details |

Icons from lucide: `Globe2`, `Copy`, `Check`, `Trash2`, `Loader2`, `Info`, `AlertCircle`, `MessageSquare` (or `ArrowRight`)

---

## What to Remove

- The side-by-side `grid-cols-[1.35fr_1fr]` layout
- The "Step 1 / Step 2" card framing
- The "What happens next" card (its content is folded into the domain header description)
- The three mini-cards in the "no domain" state (replaced with a simpler inline hint)
- The `Host / Type / Target` three-column grid inside DNS record containers (replaced with label-value rows with copy buttons)
