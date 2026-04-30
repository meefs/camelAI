# Domains Settings Page Restyle Plan

## Goal

The custom-domain *feature* is fine. This is a styling and information-architecture pass to make the page match the visual conventions we just landed for Billing / Usage / AI Provider:

- Match the layout idiom (`SettingsHeader` + `Separator` + sectioned content; **no nested containers**).
- Lead with the chat-with-Camel CTA — Camel has the custom-domain MCP tools and is the fastest path for any non-trivial setup or troubleshooting.
- Cut the visual noise around the DNS-target callout box and the per-app DNS record cell.
- Trust readers — drop or shorten the multi-paragraph explainer that sits in front of every user.

Functional behavior (loader, action, MCP wiring, DNS record handling) stays identical. **No backend changes.**

---

## Problems with the current page

Reviewed against [_app.settings.organization.domains.tsx](src/routes/_app.settings.organization.domains.tsx):

1. **Camel CTA is buried.** "Start chat with Camel" is a small `outline` button at the *bottom* of a paragraph block, after two paragraphs of setup explainer ([_app.settings.organization.domains.tsx:348-362](src/routes/_app.settings.organization.domains.tsx#L348-L362)). The user wants this to be the page's primary affordance — Camel can run the MCP custom-domain tools, the user can't.
2. **Two nested containers we don't need.**
   - The "DNS target" summary at [_app.settings.organization.domains.tsx:367-373](src/routes/_app.settings.organization.domains.tsx#L367-L373) is wrapped in `rounded-md border bg-muted/30 p-3` — a card-shaped box for one row of text and a copy button.
   - The per-app DNS record cell at [_app.settings.organization.domains.tsx:266-268](src/routes/_app.settings.organization.domains.tsx#L266-L268) is wrapped in `rounded-md border p-3` *inside* a table cell that's already inside the bordered table wrapper at [_app.settings.organization.domains.tsx:384](src/routes/_app.settings.organization.domains.tsx#L384) — a card inside a card.
3. **The "Setup" heading is misleading.** It introduces explainer text + a "Start chat with Camel" button, then the actual setup happens in the table below. There's no real "Setup" section — there are just instructions.
4. **Long explainer paragraphs.** "Enter the hostname you want for an app, save it, then create the DNS record shown in that app's row…" duplicates what the table columns already communicate.
5. **DNS record column is dense.** Each cell renders a Type / Name / Target stack with two copy buttons — visually heavy when most users only ever copy the `Name` value (since `Target` is the same for every app and is already shown once at the top of the page).
6. **Status column has hard-coded green.** [_app.settings.organization.domains.tsx:98](src/routes/_app.settings.organization.domains.tsx#L98) sets `bg-green-600` directly — same anti-pattern we just cleaned up on AI Provider. Should use a theme token.
7. **Empty-app state is a one-liner under the table area.** Should be a clearer empty state when no apps are deployed (since the whole table is the entire reason to be on this page).

---

## Design Goals (carried over from the Billing/Usage/AI Provider redesign)

- `SettingsHeader` + `Separator` + plain section headings + content directly on the page background. No `Card` wrappers around sections.
- Section headings are `<h2 className="text-base font-semibold">`.
- Match settings-page width via the layout cap at [_app.settings.tsx](src/routes/_app.settings.tsx) (no per-page width caps).
- Use theme tokens (`text-primary`, `text-destructive`, `bg-success`/`text-success` if available, otherwise muted variants) instead of hard-coded Tailwind palette colors.
- Lead with the highest-leverage action. On Domains that's "Have Camel set this up for you."

---

## ASCII Design — No domains configured (typical "first visit" view)

```
┌────────────────────────────────────────────────────────────────────────┐
│  Domains                                                               │
│  Point your own hostname at each deployed app, then update DNS.        │
├────────────────────────────────────────────────────────────────────────┤
│  ─────────── separator ───────────                                     │
│                                                                        │
│  💬  Have Camel set up your custom domain                              │  ← Hero CTA section
│                                                                        │
│  Camel has tools to inspect DNS, configure your hostname, and          │
│  troubleshoot SSL. It walks you through DNS provider steps live.       │
│                                                                        │
│                                          [  Start chat with Camel  ]   │  ← Primary button
│                                                                        │
│  ─────────── separator ───────────                                     │
│                                                                        │
│  Configure manually                                                    │
│                                                                        │
│  Prefer to do it yourself? Add a hostname to any deployed app, then    │
│  point your DNS at the camelAI target below.                           │
│                                                                        │
│  DNS target   custom-hostname.camelai.app           [ Copy ]           │  ← Plain row, no card
│                                                                        │
│  ─────────── separator ───────────                                     │
│                                                                        │
│  Apps                                                                  │
│                                                                        │
│  App                Hostname                       Status              │  ← Table header
│  ──────────────────────────────────────────────────────────────────    │
│  invoices-api       www.example.com   [ Save ] [🗑]   Active           │
│  staff-portal       (Add hostname)    [ Save ]        — not configured │
│  notes-app          help.acme.com     [ Save ] [🗑]   Pending SSL      │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

When `apps.length === 0`:

```
│  Apps                                                                  │
│                                                                        │
│  No apps deployed yet. Once you publish an app, add its hostname here. │
```

When the user is **not** an org admin:

```
│  Only organization admins can change custom domains. Ask an admin to   │
│  add a hostname for an app.                                            │
```

(Render this as a single `text-sm text-muted-foreground` line above the Apps section, **not** a destructive `Alert` — the current `<Alert variant="destructive">` is overkill for a permissions notice. The Apps table can still render but its inputs/buttons stay disabled like today.)

---

## ASCII Design — Per-app row (expanded behavior)

The current table has four columns: App / Hostname / Status / DNS record. The DNS record column is going away as a column — we move that information to a **collapsible disclosure under the row** so it only shows up when the user actually needs it.

```
│  invoices-api    www.example.com  [ Save ] [🗑]    Active   [ DNS ▾ ]  │
│                                                                        │
│  ┌── DNS for www.example.com ───────────────────────────────────────┐  │
│  │  Type    CNAME                                                   │  │  ← Disclosure body
│  │  Name    www.example.com                              [ Copy ]   │  │
│  │  Target  custom-hostname.camelai.app                  [ Copy ]   │  │
│  │                                                                  │  │
│  │  For root domains, use your DNS provider's CNAME flattening,     │  │
│  │  ALIAS, or ANAME option.                                         │  │
│  └──────────────────────────────────────────────────────────────────┘  │
```

Why this change:

- **Most rows don't need DNS detail visible.** Once the row is `Active`, the DNS record is just historical. Hiding it tightens the table to a glanceable status grid.
- **The Target value is the same for every app** and is already shown once at the top of the page. Pushing it into a disclosure removes the duplication-per-row that makes the current table feel cramped.
- **Disclosure pattern is already in our toolbox.** Use shadcn `Collapsible`, the same primitive AI Provider's earlier draft used, controlled by per-row local state. No new dependency.

When a row has no hostname yet, the `[ DNS ▾ ]` button is hidden — there's nothing to disclose.

When `app.error` is set (the row is in a failed state), default the disclosure to **open** so the DNS record + the error are visible immediately. Re-collapsing is allowed. The error message renders inside the disclosure body in `text-xs text-destructive`, replacing the small "❗" footer the current design uses.

---

## Component structure

All sections are inlined directly in [_app.settings.organization.domains.tsx](src/routes/_app.settings.organization.domains.tsx) as plain JSX — same convention we used on Billing/Usage. The only thing worth extracting is the per-row disclosure component, since it has its own state.

```
src/routes/_app.settings.organization.domains.tsx
├── DomainsPage (default export)
│   ├── SettingsHeader + <Separator />
│   ├── Hero CTA section          ← <h2> + paragraph + primary <Button> (existing chat wiring)
│   ├── <Separator />
│   ├── Configure manually section
│   │   ├── <h2> + brief paragraph
│   │   └── DNS target row        ← plain flex row, no card
│   ├── <Separator />
│   └── Apps section
│       ├── <h2>
│       ├── if !isAdmin → muted-text permissions notice
│       └── if apps.length === 0 → muted-text empty state
│           else → <Table> with <AppDomainRow /> per row
│
├── AppDomainRow (existing — modified)
│   ├── App / Hostname (input + Save + Trash) / Status / DNS toggle button
│   └── Renders <AppDnsDisclosure /> as a second TR under the row when expanded
│
└── AppDnsDisclosure (new, small)
    └── Renders DNS Type / Name / Target rows with copy buttons + the
        "For root domains…" helper line
```

`StatusBadge`, `CopyButton`, and `DnsRecordLine` already exist in the file — keep them, drop the `bg-green-600` hard-coded colors (see Theme tokens below), and reuse `DnsRecordLine` inside `AppDnsDisclosure`.

---

## ASCII Design — Hero CTA framing

The single highest-priority element on this page. Visual treatment:

```
┌────────────────────────────────────────────────────────────────────────┐
│   ⓘ  Have Camel set up your custom domain                              │  ← icon + h2
│                                                                        │
│      Camel has tools to inspect DNS, configure your hostname, and      │
│      troubleshoot SSL. Walks you through DNS provider steps live.      │
│                                                                        │
│                                       [  Start chat with Camel  ]      │  ← default Button
└────────────────────────────────────────────────────────────────────────┘
```

Implementation notes:

- Use a `MessageSquare` icon (`lucide-react`) inline with the heading at `size-5 text-primary`. This is the only place on the page where the primary brand color shows up — visually anchors the CTA.
- Heading is `<h2 className="text-base font-semibold">` (matches Billing/Usage conventions).
- Body copy is `text-sm text-muted-foreground` — two short sentences max.
- Button is `<Button>` (default variant — the page's primary action), full default size. **No `variant="outline"`, no `size="sm"`** — this is the headline button on the page.
- Right-align the button with a `flex justify-end` container so it visually sits to the right of the text on desktop (mobile collapses naturally because the parent is `space-y-3`).
- Disabled state: only when `chatLoading || !workspaceId` — same as today. Surface the disabled-because-no-workspace case with a small muted line under the button if needed.

**Do not wrap this in a `Card` or any bordered container.** It sits directly on the page background, separated from the next section by `<Separator />` like every other section on the page.

---

## ASCII Design — DNS target row

The "DNS target" callout currently sits inside `rounded-md border bg-muted/30 p-3`. Drop the chrome:

Before:
```
┌──────────────────────────────────────────────────┐
│  DNS target  custom-hostname.camelai.app   [📋]  │  ← bordered, muted bg
└──────────────────────────────────────────────────┘
```

After:
```
DNS target  custom-hostname.camelai.app  [ Copy ]      ← plain flex row, no border, no fill
```

Implementation:

```tsx
<div className="flex flex-wrap items-center gap-3 text-sm">
  <span className="text-muted-foreground">DNS target</span>
  <span className="font-mono break-all">{dnsTarget}</span>
  <CopyButton value={dnsTarget} />
</div>
```

---

## ASCII Design — Apps table changes

### Columns

Drop the `DNS record` column. New column set: **App / Hostname / Status / DNS toggle button** (the toggle button column has no header — it's just an action affordance).

### Hostname cell

Keep the same Input + Save + Trash layout. Today it's at [_app.settings.organization.domains.tsx:218-260](src/routes/_app.settings.organization.domains.tsx#L218-L260). Visual change: use the project's standard `Input` size — drop the `h-9` and `text-xs` overrides at [_app.settings.organization.domains.tsx:225](src/routes/_app.settings.organization.domains.tsx#L225) so the field matches Billing's "domain" input pattern (and the other settings pages in general). The `font-mono` is fine.

The `Trash2` icon currently uses `text-destructive` directly on the icon — that's fine *because the Button itself is `variant="ghost"`*. To match how AI Provider styles its destructive Remove button, switch the trash button to `variant="destructive" size="icon-sm"`. That uses the project's destructive-button tokens (light red bg, dark red icon) so it reads as destructive in both light and dark mode without hand-mixed classes.

### Status cell

Same `<StatusBadge>` component. **Two changes:**

1. Replace `bg-green-600 hover:bg-green-600` ([_app.settings.organization.domains.tsx:98](src/routes/_app.settings.organization.domains.tsx#L98)) with a theme-token treatment. Options, in order of preference:
   - If the project's `Badge` already has a `success`/`positive` variant (check [src/components/ui/badge.tsx](src/components/ui/badge.tsx)), use that.
   - Otherwise, use `variant="outline"` plus `text-primary border-primary/30` so "Active" reads as a positive state without invoking a hardcoded green.
   - **Do not** keep `bg-green-600`. It is the same anti-pattern we cleaned up on the AI Provider test result.
2. The "Pending SSL" badge stays `secondary`; "Needs attention" stays `destructive`; "Not configured" stays `outline`.

### DNS toggle column

A small ghost button rendered in the last cell when `app.hostname` is truthy:

```tsx
<Button
  variant="ghost"
  size="sm"
  onClick={() => setExpanded((open) => !open)}
  aria-expanded={expanded}
  aria-controls={`dns-${app.name}`}
>
  DNS
  <ChevronDown
    className={cn("size-3.5 transition-transform", expanded && "rotate-180")}
  />
</Button>
```

When `expanded` is true (or when `app.error` is non-null on first render), render an additional `<TableRow>` immediately under the main row whose single cell has `colSpan={4}` and contains the `<AppDnsDisclosure>` body.

### Per-row disclosure markup

```tsx
{expanded ? (
  <TableRow id={`dns-${app.name}`}>
    <TableCell colSpan={4} className="bg-muted/30">
      <div className="space-y-2 px-2 py-3 text-sm">
        <DnsRecordLine
          label={`DNS for ${app.hostname}`}
          name={app.hostname!}
          target={dnsTarget}
        />
        <p className="text-xs text-muted-foreground">
          For root domains, use your DNS provider's CNAME flattening, ALIAS, or
          ANAME option.
        </p>
        {error || app.error ? (
          <p className="text-xs text-destructive">{error ?? app.error}</p>
        ) : null}
      </div>
    </TableCell>
  </TableRow>
) : null}
```

Notes:

- `bg-muted/30` is the only "container-y" treatment on the page, and it's *inside* the table that already has its own border. That's the one acceptable nested treatment because the muted fill is the disclosure's only visual indicator that it's secondary content; without it, the expanded row reads as another sibling row.
- The `DnsRecordLine` component is already in the file and renders Type / Name / Target. Reuse it as-is.
- Move the per-row error-message line ([_app.settings.organization.domains.tsx:256-258](src/routes/_app.settings.organization.domains.tsx#L256-L258)) into this disclosure so all of a row's per-app context is in one place.
- The disclosure body opens by default when `app.error` is non-null so failures are immediately visible without an extra click.

---

## Theme token cleanup (Round 1 — pull list)

While we're in this file, replace each hardcoded color with a token:

| Location | Before | After |
|---|---|---|
| [_app.settings.organization.domains.tsx:98](src/routes/_app.settings.organization.domains.tsx#L98) | `bg-green-600 hover:bg-green-600` | Project's `Badge` `success`/`positive` variant if it exists, else `variant="outline"` + `text-primary border-primary/30` |
| [_app.settings.organization.domains.tsx:252](src/routes/_app.settings.organization.domains.tsx#L252) | `<Trash2 className="… text-destructive" />` inside a `variant="ghost"` Button | `<Trash2 className="size-4" />` inside a `<Button variant="destructive" size="icon-sm">` so the destructive variant tokens apply to the wrapper, not just the icon |
| [_app.settings.organization.domains.tsx:257](src/routes/_app.settings.organization.domains.tsx#L257) | `text-xs text-destructive` for the error line | Keep — `text-destructive` is already a token |

If the `Badge` component does **not** have a positive variant, leave a `// FIXME(badge-positive):` comment pointing at this redesign; we can add the variant later in the same way we extracted destructive into a proper variant. Don't introduce a new shadcn primitive for this single use.

---

## shadcn components used

All already installed.

| Element | Component | Source |
|---|---|---|
| Page header | `SettingsHeader` | [src/components/settings/settings-header.tsx](src/components/settings/settings-header.tsx) |
| Section headings | Plain `<h2 className="text-base font-semibold">` | — |
| Section dividers | `Separator` | [src/components/ui/separator.tsx](src/components/ui/separator.tsx) |
| Hero CTA button | `Button` (default variant — primary action) | [src/components/ui/button.tsx](src/components/ui/button.tsx) |
| Apps table | `Table`, `TableHeader`, `TableBody`, `TableRow`, `TableHead`, `TableCell` | [src/components/ui/table.tsx](src/components/ui/table.tsx) |
| Hostname input | `Input` | [src/components/ui/input.tsx](src/components/ui/input.tsx) |
| Save / DNS / Trash buttons | `Button` (default / ghost / destructive variants) | [src/components/ui/button.tsx](src/components/ui/button.tsx) |
| Status badge | `Badge` | [src/components/ui/badge.tsx](src/components/ui/badge.tsx) |
| DNS disclosure animation | `Collapsible` (optional — a controlled `useState` boolean is fine if we don't need transition animations) | [src/components/ui/collapsible.tsx](src/components/ui/collapsible.tsx) |
| Copy button | Existing in-file `CopyButton` | — |
| MessageSquare icon | `MessageSquare` from `lucide-react` | — |
| Chevron | `ChevronDown` from `lucide-react` | — |

The `Alert` import goes away (the not-admin notice becomes a plain muted line — see Empty/permission states above).

---

## Loader / action contract — unchanged

Nothing changes server-side. All restyling. The `loader` keeps returning `{ org, isAdmin, dnsTarget, workspaceId, apps }` and the existing `chatFetcher` / `fetcher` flows for "Start chat with Camel" and per-app set/remove are untouched.

---

## Files Changed Summary

#### New files
None — disclosure markup is small enough to inline in the route.

#### Modified files
| File | Change |
|---|---|
| `src/routes/_app.settings.organization.domains.tsx` | Restructure body per ASCII; drop the bordered DNS-target callout in favor of a plain row; drop the bordered DNS cell on each row in favor of a per-row disclosure; promote "Start chat with Camel" to a leading hero CTA section; replace the destructive `Alert` for non-admins with a muted-text line; drop hardcoded `bg-green-600` on the Active badge and use a theme-token treatment; rework the trash button to use `variant="destructive" size="icon-sm"` |

#### Deleted files
None.

---

## Implementation Order

1. **Hero CTA promotion + section reordering.** Move the "Start chat with Camel" button into its own first section above the manual-configure section. Smallest visual change with the biggest UX win — confirm the chat-launch flow still works end-to-end.
2. **Drop nested containers.** Strip the `rounded-md border bg-muted/30` wrapper from the DNS-target row and prepare the per-row disclosure component. (Leave the per-row DNS column rendering as-is for one beat.)
3. **Restructure the table.** Drop the `DNS record` column; add the `DNS` toggle column; render the disclosure as a `colSpan={4}` row when expanded. Move the per-row error rendering into the disclosure.
4. **Theme-token cleanup.** Replace `bg-green-600` on the Active badge; switch the trash button to a destructive-variant Button.
5. **Permissions notice softening.** Replace the destructive `Alert` with a muted-text line.
6. **`bun run typecheck && bun run lint`.**
7. **Manual smoke.**
   - As an admin with no apps deployed → Apps section shows the empty-state line.
   - As an admin with apps deployed → table renders, DNS toggle expands, copy buttons work, save & remove flows work.
   - As a non-admin → muted-text permissions line shows, table inputs are disabled.
   - In a failed-domain state → row's disclosure is open by default and shows the error.
   - "Start chat with Camel" still navigates to a new chat with the existing prompt.
   - Light mode and dark mode both look correct (status badge, trash button, disclosure shading).

---

## Out of scope

- **Adding new MCP tools or changing the agent prompt** — `chatPrompt` and the chat-creation fetcher stay verbatim.
- **Per-app SSL certificate diagnostics surfaced inline** — the disclosure shows whatever `app.error` already contains; we don't add new diagnostic strings.
- **A "retry" button per row** — the current page doesn't have one; not adding one in this pass.
- **Adding a `Badge` `success` variant** — if it doesn't exist, leave a FIXME and use `outline + text-primary` for now. Adding the variant is a separate small PR.
- **Backend changes** — none. This is a styling and information-architecture pass only.
