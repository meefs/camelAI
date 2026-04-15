# Settings Pages — Remove Unnecessary Card Containers

## Problem

Three settings pages wrap sections in `Card` components that add visual noise without serving a grouping purpose. The page itself is the container — sections should flow as flat content separated by `Separator` or headings, matching the pattern used by General, Team, and AI Provider.

**Good pattern** (General, Team, AI Provider):
```
SettingsHeader
────── separator ──────
Flat content / form fields / table
────── separator ──────
Next section heading + content
```

**Bad pattern** (Experimental, Domains, Usage):
```
SettingsHeader
────── separator ──────
┌─────────────────────────────┐
│  Card wrapping content      │
│  that doesn't need it       │
└─────────────────────────────┘
```

A `Card` (rounded border + background) is justified when:
- Displaying a small chunk of grouped data (e.g., AI Provider "Current key" box)
- Stat cards in a grid (e.g., Usage stat row — this is fine)
- A distinct interactive widget embedded in the page

A `Card` is NOT justified when:
- It wraps an entire section that is the main content of the page
- It wraps a form that could just be flat content
- It wraps a table or list that should flow naturally

---

## Page 1: Experimental

**File:** `src/routes/_app.settings.organization.experimental.tsx`

### Current
```
SettingsHeader "Experimental"
────── separator ──────
┌───────────────────────────────────────────────┐
│  Card: "Chat Models"                          │
│  "Turn on experimental GPT models..."         │
│                                               │
│  ┌──────────────────────────────────────────┐  │
│  │  border row: label + Switch              │  │
│  └──────────────────────────────────────────┘  │
│                                               │
│                              [Save Changes]   │
└───────────────────────────────────────────────┘
```

### Proposed
```
SettingsHeader "Experimental"
────── separator ──────

Chat Models                           ← h3 (text-lg font-medium)
Turn on experimental GPT models...    ← p text-sm text-muted-foreground

┌──────────────────────────────────────────┐
│  Enable GPT-5.4 and GPT-5.4 Mini   [⊙]  │  ← border row is fine, it groups
│  Shows GPT model options in chat...      │    the toggle with its label
└──────────────────────────────────────────┘

                               [Save Changes]
```

### Changes
- Remove `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent` wrapper
- Replace with `h3` heading + `p` description + the existing `rounded-lg border p-4` toggle row
- The inner bordered toggle row stays — that's a justified container (groups a control with its label)
- `Save Changes` button sits below the toggle row, no card needed

---

## Page 2: Domains

**File:** `src/routes/_app.settings.organization.domains.tsx`

### Current (no domain)
```
SettingsHeader "Domains"
────── separator ──────
┌───────────────────────────────────────────────┐
│  Card: "Connect your domain"                  │
│                                               │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐         │
│  │ 1. Add  │ │ 2. DNS  │ │ 3. Wait │         │
│  └─────────┘ └─────────┘ └─────────┘         │
│                                               │
│  [input]  [Add Domain]                        │
└───────────────────────────────────────────────┘
```

### Proposed (no domain)
```
SettingsHeader "Domains"
────── separator ──────

Connect a custom domain                ← h3
Your apps currently use *.camelai.app   ← p text-sm text-muted-foreground
URLs. Add a base domain to serve
them at {app-name}.your-domain.

[apps.example.com     ]  [Add Domain]

ℹ After adding, we'll show the DNS     ← small muted hint text
  records to configure.
```

### Current (domain configured)
```
SettingsHeader "Domains"
────── separator ──────
┌───────────────────────────────────────────────┐
│  Card: domain name + badge + Remove           │
└───────────────────────────────────────────────┘

┌──────────────────────────┐ ┌─────────────────┐
│  Card: "1. Add DNS"      │ │ Card: "2. What  │
│  Record 1 box            │ │ happens next"   │
│  Record 2 box            │ │ ✓ bullet        │
│  ℹ wildcard fallback     │ │ ✓ bullet        │
└──────────────────────────┘ │ ✓ bullet        │
                             └─────────────────┘
```

### Proposed (domain configured)
```
SettingsHeader "Domains"
────── separator ──────

illiana.me                [Pending activation]  [Remove]
Apps are served at {app-name}.illiana.me.        ← p text-sm
URLs switch from *.camelai.app once each
app's hostname and SSL are active.

────── separator ──────

DNS Records                             ← h3
Add both records at your DNS provider.  ← p text-sm text-muted-foreground

┌──────────────────────────────────────────┐
│  Routing                                 │  ← border container (justified:
│  Type    CNAME                           │    groups related DNS fields)
│  Name    *                        [Copy] │
│  Target  custom-domains.camelai   [Copy] │
└──────────────────────────────────────────┘

┌──────────────────────────────────────────┐
│  SSL Validation                          │
│  Type    CNAME                           │
│  Name    _acme-challenge.domain   [Copy] │
│  Target  1b7fee...dcv.cf.com     [Copy] │
└──────────────────────────────────────────┘

ℹ If your DNS provider doesn't support
  wildcard records, add per-app records.

────── separator ──────

App Status                              ← h3

  App              Hostname                Status
  ─────────────────────────────────────────────
  illiana-homepage  illiana-homepage.i...   ● SSL pending
  portfolio         portfolio.illiana...    ✓ Active

────── separator ──────

ℹ Having trouble? The camelAI agent      ← Alert (lightweight)
  can troubleshoot your DNS and SSL.
  [Troubleshoot in Chat →]
```

### Changes
- Remove the domain header `Card` — use flat `h3` + `Badge` + `Button` in a flex row
- Remove the side-by-side `grid-cols-[1.35fr_1fr]` layout
- Remove the "What happens next" card entirely — fold its content into the domain header description
- Remove the "Step 1 / Step 2" card framing
- DNS record containers stay as `rounded-md border p-4` (justified: group related fields)
- Add `Separator`s between sections
- Add App Status table (new — requires loader change)
- Add help section as `Alert`

---

## Page 3: Usage

**File:** `src/routes/_app.settings.organization.usage.tsx`

### Current
```
SettingsHeader "Usage"
────── separator ──────

┌──────────┐ ┌──────────┐ ┌──────────┐     ← stat cards (KEEP)
│ $12.34   │ │ 156 reqs │ │ OK       │
└──────────┘ └──────────┘ └──────────┘

┌───────────────────────────────────────────┐
│  Card: "Spend Windows"                    │
│  "Rolling time windows with budget caps"  │
│                                           │
│  ┌──────────────┐  ┌──────────────┐       │
│  │ 5h: $4/$25   │  │ 7d: $12/$100 │       │
│  │ ██████░░░░░  │  │ ██░░░░░░░░░  │       │
│  └──────────────┘  └──────────────┘       │
└───────────────────────────────────────────┘

┌───────────────────────────────────────────┐
│  Card: "Recent Requests"                  │
│  Table with model/input/output/cost/time  │
└───────────────────────────────────────────┘
```

### Proposed
```
SettingsHeader "Usage"
────── separator ──────

┌──────────┐ ┌──────────┐ ┌──────────┐     ← stat cards (KEEP — justified,
│ $12.34   │ │ 156 reqs │ │ OK       │       small grouped data chunks)
└──────────┘ └──────────┘ └──────────┘

────── separator ──────

Spend Windows                           ← h3
Rolling time windows with budget caps.  ← p text-sm text-muted-foreground

┌──────────────┐  ┌──────────────┐      ← border containers (KEEP —
│ 5h: $4/$25   │  │ 7d: $12/$100 │       justified, each is a data card)
│ ██████░░░░░  │  │ ██░░░░░░░░░  │
└──────────────┘  └──────────────┘

────── separator ──────

Recent Requests                         ← h3
Last 20 AI requests.                    ← p text-sm text-muted-foreground

  Model    Input    Output   Cost    Time
  ─────────────────────────────────────────
  sonnet   1,234    567      $0.01   Apr 14
  ...
```

### Changes
- Top stat cards: **keep** — these are justified small data chunks in a grid
- "Spend Windows" card: remove `Card` wrapper, replace `CardTitle`/`CardDescription` with `h3` + `p`. The inner bordered window items stay (justified).
- "Recent Requests" card: remove `Card` wrapper, replace with `h3` + `p` + bare `Table`. The table doesn't need a card around it.
- Add `Separator`s between sections

---

## Summary of Pattern

For all three pages, the transformation is the same:

| Before | After |
|--------|-------|
| `Card` > `CardHeader` > `CardTitle` | `h3 className="text-lg font-medium"` |
| `CardDescription` | `p className="text-sm text-muted-foreground"` |
| `CardContent` | Direct children, no wrapper |
| `Card` boundary between sections | `Separator` |

Inner bordered containers (`rounded-md border p-4` or `rounded-lg border p-4`) that group small data chunks (DNS records, toggle rows, stat windows) are fine and should stay.

## Components to Remove (imports)

- **Experimental:** Remove `Card`, `CardContent`, `CardDescription`, `CardHeader`, `CardTitle` imports
- **Domains:** Remove `Card`, `CardContent`, `CardDescription`, `CardHeader`, `CardTitle` imports (note: the domains redesign plan already covers this — this plan is the container-specific rationale)
- **Usage:** Remove `Card` wrapper from "Spend Windows" and "Recent Requests" sections. Keep `Card` imports for the top stat row.
