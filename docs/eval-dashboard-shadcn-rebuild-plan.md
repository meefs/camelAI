# Eval Reports Dashboard — Real Frontend + shadcn Rebuild

Audience: the coding agent implementing this. The plan replaces the single-file
`workers/eval-reports/dashboard/index.html` viewer with a real Vite-built React SPA that reuses
the **main app's shadcn primitives and theme**, and rebuilds the two views (runs list, run detail)
with a cleaner layout. The Worker's API, upload plane, auth model, and R2 layout are **unchanged**.

This plan is UI-led: §7–§10 fully specify the components, classes, copy, and layout. Follow them
literally — do not invent alternative layouts. Where a snippet gives exact class strings, use them.

---

## 1. Read these first

| Purpose | File |
|---|---|
| Current dashboard (behavior to reach parity with, then delete) | `workers/eval-reports/dashboard/index.html` |
| Worker routes + auth middleware (mostly unchanged) | `workers/eval-reports/src/index.ts`, `src/access.ts` |
| Run data model (reuse these types in the frontend) | `workers/eval-reports/src/types.ts` |
| How `evaluation`/`signal`/contract failures are synthesized | `workers/eval-reports/src/ingest.ts` |
| shadcn config to mirror (aliases, style, zinc base) | `components.json` |
| Theme tokens + custom variants to share | `src/styles/globals.css` |
| Fonts + next-themes setup to mirror | `src/root.tsx` (links array, `<ThemeProvider>` props) |
| Reusable primitives (import, do NOT copy or modify) | `src/components/ui/*` |
| Component quick reference | `docs/shadcn-components.md` |

Key facts about the data (from `types.ts` / `ingest.ts`):

- `Run.status` is terminal-only: `"completed" | "failed"`. There is no running/queued state.
- `run.evaluation` is always present for new runs (ingest synthesizes a contract-failure
  evaluation when the artifact has none), but **may be absent on old records** — treat as optional.
- A contract failure appears as a failed pass/fail criterion with `id === "evaluation_contract"`.
- `signal`, `deployedApps`, `ref`, `commit`, `model`, `startedAt/finishedAt`, `host`, `createdBy`
  are all optional. Render `—` (muted) for missing values; never crash on absence.
- Transcript artifacts (`GET /api/runs/:id/artifact/:name`) are JSON of shape
  `{ result?: string, messages?: Message[], evaluation?, signal?, deployedApps?, error? }` where
  `messages` are Anthropic-style: `{ role: "user"|"assistant", content: string | Block[] }` and
  blocks are `text | thinking | redacted_thinking | tool_use | tool_result`.
- Tool results must be paired to calls by `tool_use_id` (GPT batches all `tool_use` in one message
  and all `tool_result` in the next; positional rendering breaks). The pairing logic in the old
  dashboard (`renderTranscript`) is correct — port it, don't redesign it.

---

## 2. Architecture decisions (locked)

1. **Build**: Vite + `@cloudflare/vite-plugin` + `@vitejs/plugin-react`, all already in root
   `package.json`. One `vite dev` runs the Worker (with local R2 simulation) and the SPA with HMR.
   `vite build` emits `workers/eval-reports/dist/` containing client assets, the bundled worker,
   and a resolved `wrangler.json`; deploy happens from that output.
2. **Static serving**: Cloudflare Workers Assets with `run_worker_first: true` and SPA fallback.
   Every request — including assets — still passes through the Hono Access-JWT middleware first.
   This preserves the existing security posture exactly (the `workers.dev` URL is not behind the
   Access edge app, so worker-side validation must keep gating everything).
3. **Component reuse**: import the main app's primitives directly from `src/components/ui/*` via
   the `@` alias (`@/components/ui/button` etc.). The primitives used here depend only on `react`,
   `radix-ui`, `lucide-react`, `class-variance-authority`, and `@/lib/utils` — all root deps. Do
   **not** copy components into the worker dir and do **not** edit anything under
   `src/components/ui/` — if a primitive needs different styling, wrap it locally in the eval app.
4. **Theme reuse**: extract the shadcn design tokens from `src/styles/globals.css` into a shared
   `src/styles/shadcn-theme.css` imported by both apps (§4.1). This is the only main-app change.
5. **Routing**: `react-router` v7 (root dep) in plain SPA mode (`createBrowserRouter`), two
   routes: `/` (runs list) and `/runs/:runId` (detail). Real paths, not hash routes; a tiny shim
   redirects legacy `#/run/<id>` links.
6. **No API changes.** The frontend consumes the existing read API exactly as-is:
   `GET /api/runs?limit=200`, `GET /api/runs/:id`, `GET /api/runs/:id/log`,
   `GET /api/runs/:id/artifacts`, `GET /api/runs/:id/artifact/:name`.
7. **Dark + light**: `next-themes` with `attribute="class" defaultTheme="system" enableSystem`
   (same as `src/root.tsx`) plus a header toggle. The old dashboard was dark-only; the new one
   follows the main app.

---

## 3. File layout

| Path | Status | Notes |
|---|---|---|
| `src/styles/shadcn-theme.css` | **new** | Shared tokens/variants extracted from `globals.css` (§4.1) |
| `src/styles/globals.css` | **modify** | Imports `shadcn-theme.css`; moved blocks deleted (§4.1) |
| `workers/eval-reports/vite.config.ts` | **new** | §4.2 |
| `workers/eval-reports/index.html` | **new** | Vite entry (§4.3) |
| `workers/eval-reports/public/favicon.svg` | **moved** | from `dashboard/favicon.svg` |
| `workers/eval-reports/public/camelAI-fullname-logo-{lightmode,darkmode}.svg` | **copied** | from root `public/` (used by `FullLogo`) |
| `workers/eval-reports/app/main.tsx` | **new** | Router + ThemeProvider bootstrap (§6.1) |
| `workers/eval-reports/app/app.css` | **new** | Tailwind entry (§4.4) |
| `workers/eval-reports/app/routes/runs-list.tsx` | **new** | §8 |
| `workers/eval-reports/app/routes/run-detail.tsx` | **new** | §9 |
| `workers/eval-reports/app/components/app-shell.tsx` | **new** | §7 |
| `workers/eval-reports/app/components/verdict-badge.tsx` | **new** | §10.1 |
| `workers/eval-reports/app/components/score.tsx` | **new** | §10.2 |
| `workers/eval-reports/app/components/criteria-card.tsx` | **new** | §9.3 |
| `workers/eval-reports/app/components/scorecard-card.tsx` | **new** | §9.3 |
| `workers/eval-reports/app/components/transcript/transcript-view.tsx` | **new** | §9.4 |
| `workers/eval-reports/app/components/transcript/tool-call-block.tsx` | **new** | §9.4 |
| `workers/eval-reports/app/components/transcript/markdown.tsx` | **new** | §9.4 |
| `workers/eval-reports/app/components/text-viewer.tsx` | **new** | Shared shell for Log/Raw tabs (§9.5) |
| `workers/eval-reports/app/lib/api.ts` | **new** | §6.2 |
| `workers/eval-reports/app/lib/format.ts` | **new** | §6.3 |
| `workers/eval-reports/app/lib/transcript.ts` | **new** | Types + tool pairing (§9.4) |
| `workers/eval-reports/tsconfig.app.json` | **new** | §4.5 |
| `workers/eval-reports/src/index.ts` | **modify** | §5 |
| `workers/eval-reports/src/global.d.ts` | **modify** | §5 |
| `workers/eval-reports/wrangler.jsonc` | **modify** | §4.6 |
| `workers/eval-reports/package.json` | **modify** | §4.7 |
| `workers/eval-reports/.dev.vars` | **new, untracked** | `CF_ACCESS_ENABLED=0` (gitignored by `.dev.vars*`) |
| `workers/eval-reports/README.md` | **modify** | §11 |
| root `package.json` | **modify** | `deploy:eval-reports`, new `dev:eval-reports` (§4.7) |
| root `.gitignore` | **modify if needed** | ensure `workers/eval-reports/dist/` is ignored (a global `dist/` entry may not exist — verify) |
| `workers/eval-reports/dashboard/` | **deleted** | after the new app reaches parity |

Component split guidance: the table above is the minimum split. Keep page-level state (filters,
tab) in the route files; keep presentational pieces dumb. Don't add more layers than listed.

---

## 4. Build scaffolding

### 4.1 Shared theme file (the only main-app change)

Create `src/styles/shadcn-theme.css` and **move** (not copy) these blocks from
`src/styles/globals.css` into it, in this order, verbatim:

1. All ten `@custom-variant` blocks (`dark`, `data-open`, `data-closed`, `data-checked`,
   `data-unchecked`, `data-selected`, `data-disabled`, `data-active`, `data-horizontal`,
   `data-vertical`) — several ui primitives (tabs, select, tooltip, hover-card) compile against
   these variants, so both apps need them.
2. The `@utility no-scrollbar` block.
3. The entire `@theme inline { ... }` block.
4. The `:root { ... }` token block and the `.dark { ... }` token block.
5. The `@keyframes collapsible-down` and `@keyframes collapsible-up` blocks (referenced by
   `--animate-*` entries in the `@theme` block).

Then add `@import "./shadcn-theme.css";` to `globals.css` immediately after the
`@import "tw-animate-css";` line (CSS `@import` must precede other rules). Everything else —
`@source "../"`, safe-area utilities, `@layer base`, markdown/shiki/notebook styles, the other
keyframes — stays in `globals.css`.

This is a pure move: after it, `bun run dev` must render the main app pixel-identically. If
review prefers zero main-app diff, the fallback is to copy those blocks into the eval app's CSS
with a `/* copied from src/styles/globals.css — keep in sync */` header — but the shared file is
the recommended shape and what the rest of this plan assumes.

### 4.2 `workers/eval-reports/vite.config.ts`

```ts
import path from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	root: import.meta.dirname,
	plugins: [react(), cloudflare({ configPath: "./wrangler.jsonc" })],
	resolve: {
		alias: { "@": path.resolve(import.meta.dirname, "../../src") },
		dedupe: ["react", "react-dom"],
	},
	server: { port: 8789 },
});
```

Notes: `root` is set so the config works when invoked from the repo root
(`vite dev --config workers/eval-reports/vite.config.ts`). PostCSS needs no local config — the
root `postcss.config.mjs` (`@tailwindcss/postcss`) is found by upward lookup from the CSS file.

### 4.3 `workers/eval-reports/index.html`

```html
<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>camelAI Evals</title>
		<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
		<script>
			// Pre-hydration dark-mode guard (next-themes stores under "theme").
			(() => {
				const t = localStorage.getItem("theme");
				const dark =
					t === "dark" ||
					((!t || t === "system") &&
						matchMedia("(prefers-color-scheme: dark)").matches);
				document.documentElement.classList.toggle("dark", dark);
			})();
		</script>
		<link rel="preconnect" href="https://fonts.googleapis.com" />
		<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
		<link
			rel="stylesheet"
			href="https://fonts.googleapis.com/css2?family=Figtree:ital,wght@0,300..900;1,300..900&family=Geist+Mono:wght@100..900&display=swap"
		/>
	</head>
	<body>
		<div id="root"></div>
		<script type="module" src="/app/main.tsx"></script>
	</body>
</html>
```

(Same font families as `src/root.tsx`, minus Source Serif 4 which this app doesn't use.)

### 4.4 `workers/eval-reports/app/app.css`

```css
@import "tailwindcss" source(none);
@import "tw-animate-css";
@import "../../../src/styles/shadcn-theme.css";

@source "./";
@source "../index.html";
@source "../../../src/components/ui";

@layer base {
	* {
		@apply border-border outline-ring/50;
	}
	body {
		@apply bg-background text-foreground;
	}
}
```

Plus the small transcript-markdown block from §9.4 at the bottom. `@source` is scoped to the eval
app and the shared primitives only — do not `@source` the whole main `src/`.

### 4.5 TypeScript

- Keep `workers/eval-reports/tsconfig.json` for the worker (`src/`) as-is.
- New `workers/eval-reports/tsconfig.app.json`:

```jsonc
{
	"compilerOptions": {
		"target": "ES2022",
		"lib": ["DOM", "DOM.Iterable", "ES2022"],
		"module": "ESNext",
		"moduleResolution": "bundler",
		"jsx": "react-jsx",
		"strict": true,
		"noEmit": true,
		"skipLibCheck": true,
		"isolatedModules": true,
		"types": ["vite/client"],
		"paths": { "@/*": ["../../src/*"] }
	},
	"include": ["app/**/*.ts", "app/**/*.tsx"]
}
```

(The root repo tsconfig excludes `workers/`, so the app needs its own project. `app/lib/api.ts`
imports run types from `../../src/types` — importing outside `include` is fine.)

### 4.6 `workers/eval-reports/wrangler.jsonc`

- Add:

```jsonc
"assets": {
	"binding": "ASSETS",
	"not_found_handling": "single-page-application",
	"run_worker_first": true
}
```

(No `directory` — the Vite plugin manages it and writes the resolved value into the emitted
`dist/**/wrangler.json`.)

- Delete the `"rules"` entry (text imports become Vite `?raw` imports; nothing bundles via plain
  wrangler anymore).

### 4.7 Scripts

`workers/eval-reports/package.json`:

```jsonc
"scripts": {
	"dev": "vite dev",
	"build": "vite build",
	"deploy": "vite build && wrangler deploy",
	"typecheck": "tsc --noEmit && tsc -p tsconfig.app.json --noEmit"
}
```

Root `package.json`:

- `"deploy:eval-reports": "vite build --config workers/eval-reports/vite.config.ts && wrangler deploy -c workers/eval-reports/wrangler.jsonc"`
- Add `"dev:eval-reports": "vite dev --config workers/eval-reports/vite.config.ts"`

The Cloudflare Vite plugin writes a deploy-redirect at
`workers/eval-reports/.wrangler/deploy/config.json` during build, so `wrangler deploy -c
workers/eval-reports/wrangler.jsonc` deploys the **built** output (same mechanism
`scripts/deploy-main.mjs` relies on). Verify after the first build that the redirect exists and
the deployed worker serves assets; if the redirect isn't produced, point the deploy script at the
emitted config file under `workers/eval-reports/dist/` instead (the build log prints its path).

---

## 5. Worker changes (`src/index.ts`, `src/global.d.ts`) — keep minimal

1. `global.d.ts`: add `ASSETS: Fetcher;` to `Env`. Replace the `*.html`/`*.md`/`*.svg` module
   declarations with a single `declare module "*.md?raw" { const text: string; export default text; }`.
2. `index.ts`:
   - Remove `import dashboardHtml from "../dashboard/index.html"` and
     `import faviconSvg from "../dashboard/favicon.svg"`, the `FAVICON_HEADERS` const, and the two
     favicon routes (the favicon is now a static asset in `public/`).
   - Change the skill import to `import skillDoc from "../SKILL.md?raw";` — the `/skill` route
     stays exactly as-is.
   - Replace the `notFound` handler body's HTML branch:

```ts
app.notFound((c) => {
	if (c.req.path.startsWith("/api/") || c.req.path.startsWith("/upload/")) {
		return c.json({ error: "Not found" }, 404);
	}
	return c.env.ASSETS.fetch(c.req.raw);
});
```

Everything else — the Access middleware on `"*"` (which now also covers asset requests, thanks to
`run_worker_first`), all `/upload/*` and `/api/*` routes, `ingest.ts`, `access.ts`, `types.ts` —
is untouched.

---

## 6. App bootstrap and data layer

### 6.1 `app/main.tsx`

```tsx
import "./app.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { ThemeProvider } from "@/components/theme-provider";
```

- Legacy-link shim before creating the router: if `location.hash` matches `^#\/run\/(.+)$`,
  `history.replaceState(null, "", "/runs/" + encodeURIComponent(decodeURIComponent(m[1])))`.
- Router:

```tsx
const router = createBrowserRouter([
	{
		path: "/",
		Component: AppShell,
		ErrorBoundary: RouteError,
		children: [
			{ index: true, Component: RunsListPage, loader: runsLoader },
			{ path: "runs/:runId", Component: RunDetailPage, loader: runLoader },
		],
	},
]);
```

- Render wrapped in
  `<ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>`
  (`@/components/theme-provider` is the main app's 9-line next-themes wrapper; portable).

Data loading: route **loaders** fetch the run list / run record (house preference over
`useEffect`). The transcript, log, and artifact list are fetched lazily inside their tab
components when first shown — they can be large and most visits stay on Overview.

### 6.2 `app/lib/api.ts`

Typed fetch helpers over the existing API. Re-export the worker's types:

```ts
import type { Run } from "../../src/types";

async function getJson<T>(path: string): Promise<T> {
	const res = await fetch(path);
	if (!res.ok) {
		const body = await res.json().catch(() => ({}) as { error?: string });
		throw new Response((body as { error?: string }).error ?? `HTTP ${res.status}`, {
			status: res.status,
		});
	}
	return res.json() as Promise<T>;
}

export const fetchRuns = () =>
	getJson<{ runs: Run[] }>("/api/runs?limit=200").then((d) => d.runs ?? []);
export const fetchRun = (id: string) => getJson<Run>(`/api/runs/${encodeURIComponent(id)}`);
export const fetchArtifactNames = (id: string) =>
	getJson<{ artifacts: string[] }>(`/api/runs/${encodeURIComponent(id)}/artifacts`).then(
		(d) => d.artifacts ?? [],
	);
export const fetchArtifact = (id: string, name: string) =>
	getJson<TranscriptArtifact>(
		`/api/runs/${encodeURIComponent(id)}/artifact/${encodeURIComponent(name)}`,
	);
export const fetchLog = async (id: string) => {
	const res = await fetch(`/api/runs/${encodeURIComponent(id)}/log`);
	return res.ok ? res.text() : null;
};
```

Throwing a `Response` from loaders lets the route `ErrorBoundary` distinguish 404 from other
errors via `isRouteErrorResponse`.

### 6.3 `app/lib/format.ts`

Port these from the old dashboard, as plain functions with the same semantics:

- `relTime(iso)` → `"42s ago" | "5m ago" | "3h ago" | "2d ago" | "—"`.
- `durationOf(run)` → `"4m 12s" | "37s" | "—"` from `startedAt`/`finishedAt`.
- `fmtCost(n)` → `"$0.0042"` under $1, `"$1.24"` otherwise, `"—"` for non-numbers.
- `fmtInt(n)` → `n.toLocaleString()` or `"—"`.
- `fmtTokens(n)` → compact notation (`Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 })`, e.g. `"1.2M"`), `"—"` for non-numbers.
- `stripAnsi(s)` → same two regexes as the old dashboard.
- `whenText(run)` / `whenTitle(run)` → relative text + ISO title from `finishedAt ?? createdAt`.
- `failedCriteria(run)` → failed pass/fail criteria array.

---

## 7. Global chrome (`app-shell.tsx`)

```
┌────────────────────────────────────────────────────────────────────────────┐
│  [camelAI logo]  Evals                      [↗ How to run an eval] [◐]     │  h-14, border-b
└────────────────────────────────────────────────────────────────────────────┘
│                          max-w-6xl centered content                        │
```

- Header: `sticky top-0 z-20 border-b bg-background/80 backdrop-blur`; inner
  `mx-auto flex h-14 max-w-6xl items-center gap-3 px-6`.
  - Brand: `<Link to="/">` containing `<FullLogo className="h-5 w-auto" />` (from
    `@/components/ui/logo`; the two svgs are copied into `public/`, §3) then
    `<span className="text-sm font-medium text-muted-foreground">Evals</span>`.
  - Spacer `flex-1`.
  - `<Button variant="ghost" size="sm" asChild><a href="/skill" target="_blank" rel="noopener">How to run an eval<ExternalLink /></a></Button>`.
  - Mode toggle: `<Button variant="ghost" size="icon" aria-label="Toggle theme">` with
    `<Sun className="dark:hidden" /><Moon className="hidden dark:block" />`; onClick
    `setTheme(resolvedTheme === "dark" ? "light" : "dark")` via `useTheme()` from `next-themes`.
- Main: `<main className="mx-auto w-full max-w-6xl px-6 py-8"><Outlet /></main>`.
- `RouteError` (ErrorBoundary): centered column, `py-24 text-center`. For
  `isRouteErrorResponse(err) && err.status === 404`: `SearchX` icon (`size-8 text-muted-foreground`),
  "Run not found" (`text-sm font-medium`), the message in `text-sm text-muted-foreground`, and a
  `<Button variant="outline" size="sm" asChild><Link to="/">All runs</Link></Button>`. Any other
  error: same layout with `TriangleAlert`, "Something went wrong", the error message, and a
  "Try again" outline button calling `useRevalidator().revalidate()`.

---

## 8. Runs list (`/`, `runs-list.tsx`)

### 8.1 Layout

```
  Eval runs
  Agent evals run locally and report here with EVAL_REPORT=1.

  [⌕ Filter runs…            ]  [ All │ Passed │ Failed ]  [All evals ▾]      42 runs
  ┌──────────────────────────────────────────────────────────────────────────────┐
  │ RESULT   EVAL                    SCORE   BRANCH        ACTIVITY   DURATION  FINISHED │
  ├──────────────────────────────────────────────────────────────────────────────┤
  │ ✓ Pass   dashboard-fake-data-…    93%    main a1b2c3d  14 turns    4m 12s   2h ago   │
  │          claude-opus-4-8         42/45                 · $0.41              illiana  │
  ├──────────────────────────────────────────────────────────────────────────────┤
  │ ✗ Fail   deploy-fake-data-live    61%    pi/fix 9f8e7d 22 turns    9m 03s   5h ago   │
  │          default model          28/46                 · $0.88 [2 bad]      miguel   │
  └──────────────────────────────────────────────────────────────────────────────┘
```

Top to bottom:

1. Page header: `<h1 className="text-lg font-semibold tracking-tight">Eval runs</h1>` and
   `<p className="mt-1 text-sm text-muted-foreground">Agent evals run locally and report here with <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">EVAL_REPORT=1</code>.</p>`.
2. Toolbar (`mt-6 flex flex-wrap items-center gap-2`):
   - Search: `InputGroup` (`@/components/ui/input-group`) `className="max-w-xs"` with
     `<InputGroupAddon><Search /></InputGroupAddon>` and `<InputGroupInput placeholder="Filter by eval, model, branch, id, or person…" />`.
   - Status: `ToggleGroup type="single" variant="outline" size="sm"` with items
     `All` (value `""`), `Passed` (`completed`), `Failed` (`failed`). Treat deselect-to-empty as All.
   - Eval: `Select` (`size="sm"`-equivalent; use the default trigger with `className="h-8 w-44 text-xs"`)
     — first item "All evals", then the distinct sorted `evalTarget` values from the loaded runs.
   - Right-aligned (`ml-auto`) count: `<span className="text-sm text-muted-foreground">42 runs</span>`.
3. Table card: `<div className="mt-4 overflow-x-auto rounded-xl border">` wrapping the shadcn
   `Table`. No extra `Card` nesting.

### 8.2 Filter state

Keep filters in URL search params via `useSearchParams` (`q`, `status`, `eval`), written with
`{ replace: true }` so typing doesn't spam history. Filtering is client-side over the loaded runs
(same as today): status equality, eval equality, and the search string matched case-insensitively
against `[ref, evalTarget, model, runId, createdBy].join(" ")`.

### 8.3 Columns

Use `TableHeader/TableHead` with default styles. Cells are `align-middle`; rows use two-line
cells for secondary facts instead of extra columns — this is the core de-clutter move.

| # | Head | Cell spec |
|---|---|---|
| 1 | Result (`w-24`) | `<VerdictBadge status={run.status} />` (§10.1). For failed runs with failed criteria, wrap the badge in a `HoverCard` (§8.4). |
| 2 | Eval | Line 1: `font-medium` truncated `evalTarget`. Line 2: `text-xs text-muted-foreground` — `model` or `default model`. |
| 3 | Score (`w-24`) | Line 1: percentage `font-medium tabular-nums` colored by band (§10.2); Line 2: `text-xs text-muted-foreground tabular-nums` `42/45`. No evaluation/scorecard → single muted `—`. |
| 4 | Branch (`hidden md:table-cell`) | One line, `font-mono text-xs`: `ref` (truncate, `max-w-40`) + short commit `text-muted-foreground` (`commit.slice(0,7)`). Missing both → `—`. |
| 5 | Activity (`hidden md:table-cell`) | `text-xs text-muted-foreground`: `“14 turns · $0.41”` (omit missing parts). Append `<Badge variant="destructive">2 bad</Badge>` when `badToolCallCount > 0` and `<Badge variant="destructive">N violations</Badge>` when `violations?.length`. No signal → `—`. |
| 6 | Duration (`w-24 hidden sm:table-cell`) | `text-sm text-muted-foreground tabular-nums`, `durationOf(run)`. |
| 7 | Finished (`w-28`) | Line 1: `text-sm text-muted-foreground` `whenText(run)` with `title={whenTitle(run)}`. Line 2: `text-xs text-muted-foreground/70` — `createdBy` local-part (`split("@")[0]`) or nothing. |

Row behavior: whole row navigates (`onClick={() => navigate(...)}` plus
`className="cursor-pointer"`; default shadcn row hover supplies the hover tint). Also make the
eval-name line a real `<Link>` for cmd-click/copy-link affordance (stopPropagation not needed —
same destination).

### 8.4 Failed-criteria hover card

Replaces the old hand-rolled `critpop`. On the Fail badge only:

```tsx
<HoverCard openDelay={150}>
	<HoverCardTrigger asChild>{badge}</HoverCardTrigger>
	<HoverCardContent align="start" className="w-80">
		<p className="text-xs font-medium text-destructive">3 failed criteria</p>
		<div className="mt-2 space-y-2">
			{failed.slice(0, 5).map((c) => (
				<div key={c.id} className="text-xs">
					<p className="font-medium">{c.label}</p>
					{c.reason && <p className="mt-0.5 line-clamp-2 text-muted-foreground">{c.reason}</p>}
				</div>
			))}
			{failed.length > 5 && (
				<p className="text-xs text-muted-foreground">+{failed.length - 5} more</p>
			)}
		</div>
	</HoverCardContent>
</HoverCard>
```

### 8.5 States

- **Loading** (router HydrateFallback / `useNavigation`): render the header + toolbar disabled +
  8 skeleton rows — each cell a `<Skeleton className="h-4" />` with plausible widths (`w-16`,
  `w-48`, `w-10`, `w-24`, `w-28`, `w-12`, `w-16`).
- **Empty (no runs at all)**: inside the table card, centered `py-16` column: `FlaskConical`
  (`size-8 text-muted-foreground`), `<p className="mt-3 text-sm font-medium">No runs reported yet</p>`,
  `<p className="mt-1 text-sm text-muted-foreground">Run one locally: <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">EVAL_REPORT=1 bun run test:eval &lt;id&gt;</code></p>`,
  and a link-styled anchor to `/skill` ("How to run an eval").
- **No matches (filters active)**: same slot: `SearchX` icon, "No matching runs", and
  `<Button variant="ghost" size="sm">Clear filters</Button>` that resets all three params.
- **Fetch error**: handled by the route ErrorBoundary (§7).

---

## 9. Run detail (`/runs/:runId`, `run-detail.tsx`)

### 9.1 Header

```
  ← All runs

  [✗ Fail]  deploy-fake-data-live                                        61%
                                                                     28/46 pts
  claude-opus-4-8 · pi/fix@9f8e7d6 · 9m 03s · finished 5h ago · miguel · mbp.local · [real deploy]
  eval-20260622-193042Z-ab12 ⧉
```

- Back: `<Button variant="ghost" size="sm" asChild><Link to="/"><ArrowLeft />All runs</Link></Button>`,
  `mb-4`, negative-indent (`-ml-2`) so text aligns with the title.
- Title row (`flex items-start justify-between gap-4`):
  - Left: `flex items-center gap-3` → `<VerdictBadge status size="lg" />` +
    `<h1 className="text-xl font-semibold tracking-tight">{run.evalTarget}</h1>`.
  - Right (only when `run.evaluation?.scorecard` has `maxPoints > 0`): right-aligned block —
    percentage `text-2xl font-semibold tabular-nums` in band color, beneath it
    `text-xs text-muted-foreground tabular-nums` `“28/46 pts”`.
- Meta line (`mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground`),
  items separated by `<span className="text-border">·</span>`, each omitted when absent:
  model; `ref@commit7` in `font-mono text-xs`; duration; `finished {whenText}` (title = ISO);
  `by {createdBy}`; host; `<Badge variant="outline">real deploy</Badge>` when `realDeploy`.
- Run id line (`mt-1 flex items-center gap-1`): `font-mono text-xs text-muted-foreground` runId +
  a copy button (`Button variant="ghost" size="icon"` shrunk with `className="size-6"`, `Copy`
  icon swapping to `Check` for ~1.5s after `navigator.clipboard.writeText(runId)`).

### 9.2 Tabs

`<Tabs>` with `<TabsList variant="line">` (the `variant` prop lives on **TabsList** in this
repo's `tabs.tsx`; `line` is the underline style), `mt-6`, value driven by `?tab=` search param
(default `overview`, `{ replace: true }`): `Overview` / `Transcript` / `Log` / `Raw JSON`.
Tab content area gets `mt-4`.

### 9.3 Overview tab

Stack, `space-y-4`:

1. **Contract-failure alert** — when `!run.evaluation` or any failed criterion with
   `id === "evaluation_contract"`:
   `<Alert variant="destructive"><TriangleAlert /><AlertTitle>Evaluation contract failure</AlertTitle><AlertDescription>{reason ?? "No valid evaluation object was found in the eval artifact."}</AlertDescription></Alert>`.
2. **Run error alert** — when `run.error` (skip if identical to the contract-failure reason
   already shown): destructive Alert, title "Run error", description in
   `whitespace-pre-wrap font-mono text-xs`.
3. **Violations alert** — when `run.signal?.violations?.length`: default-variant Alert with
   `className="border-amber-500/40 text-amber-700 dark:text-amber-400 [&>svg]:text-current"`,
   `TriangleAlert`, title "Signal violations", description = `<ul className="list-disc pl-4">` of
   the strings.
4. **Stats strip** — one bordered container (`grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-3 lg:grid-cols-6`),
   each tile `bg-card px-4 py-3`:
   `<p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>`
   over `<p className="mt-1 text-sm font-medium tabular-nums">{value}</p>`.
   Tiles, in order: **Turns** `fmtInt(assistantTurnCount)`; **Tool calls** `fmtInt(toolCallCount)`
   plus inline `<span className="ml-1 text-destructive">({n} bad)</span>` when
   `badToolCallCount > 0`; **Tokens** `fmtTokens(totalTokens)` with `title` showing the in/out
   breakdown; **Cost** `fmtCost(costUsd)`; **Exit code** `run.exitCode ?? "—"` (destructive text
   when nonzero); **Real deploy** `yes/no/—`.
5. **Criteria + Scorecard grid** (`grid gap-4 lg:grid-cols-2`):

   **Criteria card** (`criteria-card.tsx`) — `Card` with `CardHeader`: `CardTitle` "Criteria",
   `CardDescription` = `“7 passed · 1 failed”` (failed count in `text-destructive font-medium`
   when > 0, or `“All 8 passed”`). `CardContent`: `divide-y` list, failed rows sorted first. Row
   (`flex gap-3 py-3 first:pt-0 last:pb-0`):
   - Icon: `CircleCheck` `size-4 shrink-0 mt-0.5 text-green-600 dark:text-green-400` /
     `CircleX` same but `text-destructive`.
   - Body: label `text-sm font-medium`; `reason` beneath in `text-sm text-muted-foreground`;
     when `details` present, a `Collapsible`: trigger
     `<button className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground [&[data-state=open]>svg:first-child]:rotate-90"><ChevronRight className="size-3 transition-transform" />Details</button>`
     (Radix puts `data-state` on the trigger, so the rotation selector targets the child chevron
     from there — reuse this exact pattern for every chevron trigger in this plan),
     content `<pre className="mt-2 max-h-56 overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap">{JSON.stringify(details, null, 2)}</pre>`.
   - Empty list → muted `“No pass/fail criteria.”`. No evaluation at all → card omitted (alert
     already explains).

   **Scorecard card** (`scorecard-card.tsx`) — omitted when no scorecard. `CardHeader`:
   `CardTitle` "Scorecard", `CardDescription` `“28 of 46 points”`. `CardContent`:
   - Overall: `<ScoreBar value={pct} className="h-2" />` (§10.2) with the percentage rendered to
     its right (`text-sm font-medium tabular-nums` in band color).
   - Then `divide-y` rows (`flex items-center gap-4 py-3`): left flexes — label
     `text-sm font-medium` + optional reason `text-sm text-muted-foreground` + details
     Collapsible (same pattern as criteria); right: `<ScoreBar value={rowPct} className="h-1.5 w-20 shrink-0" />`
     and `<span className="w-12 shrink-0 text-right text-xs text-muted-foreground tabular-nums">3/5</span>`.
   - No score criteria → muted `“No scored criteria.”`.
6. **Deployed apps card** — only when `deployedApps?.length`. `Card` "Deployed apps";
   content is a `divide-y` list of `<a target="_blank" rel="noopener">` rows
   (`flex items-center gap-3 py-2.5 first:pt-0 last:pb-0 group`): name `text-sm font-medium group-hover:underline`,
   url `min-w-0 truncate font-mono text-xs text-muted-foreground`, `ExternalLink`
   `size-3.5 shrink-0 text-muted-foreground ml-auto`. Only render http(s) URLs as links (port the
   old `safeUrl` guard).

### 9.4 Transcript tab (`transcript/`)

Data flow: on first activation fetch `fetchArtifactNames(runId)`; if empty → empty state
(`“No transcript artifact for this run.”` centered muted, `py-16`). If more than one, show a
`Select` (`h-8 w-64 text-xs`, right-aligned above the stream) listing artifact names without
`.json`; load the first by default; cache loaded artifacts by name in state.

`app/lib/transcript.ts` — define block/message types and port the pairing pass verbatim from the
old `renderTranscript`: build `resultById` (tool_use_id → tool_result block) and `callIds`; a
`tool_result` whose id is in `callIds` renders nested under its call, not standalone. Preserve the
old truncation limits: thinking sliced to 4 000 chars, tool input/result text to 8 000.

Rendering, top to bottom (`space-y-4 max-w-3xl`):

1. **Result card** — when `artifact.result`: `Card` with `CardTitle` "Result" and the markdown
   body. Keep it first; it's the eval's verdict summary.
2. **Messages**. Per message with non-empty rendered content:
   - Role header (`flex items-center gap-2 mb-2`):
     `<span className="flex size-5 items-center justify-center rounded-full bg-muted"><User|Bot className="size-3 text-muted-foreground" /></span>`
     + `<span className="text-xs font-medium text-muted-foreground">User|Assistant</span>`.
   - **User** message body: boxed — `rounded-lg bg-muted/50 px-4 py-3`.
   - **Assistant** body: unboxed, `space-y-3`.
   - Block rendering:
     - `text` → `<Markdown>` (below), `text-sm`.
     - `thinking` / `redacted_thinking` → `Collapsible` collapsed by default. Trigger:
       `<button className="inline-flex items-center gap-1.5 text-xs italic text-muted-foreground hover:text-foreground [&[data-state=open]>svg:first-child]:rotate-90"><ChevronRight className="size-3 transition-transform" /><Brain className="size-3" />Thinking</button>`
       (label `Reasoning redacted` and no content for redacted). Content:
       `border-l-2 pl-3 text-sm italic text-muted-foreground whitespace-pre-wrap`.
     - `tool_use` → `ToolCallBlock` (below).
     - orphan `tool_result` → `ToolCallBlock` in result-only mode, name `tool result`.
     - anything else → `<pre className="rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap">{JSON.stringify(block, null, 2)}</pre>`.

**`tool-call-block.tsx`** — one `Collapsible` per call, `defaultOpen={isError}`:

```
▸ 🔧 run_notebook   {"cell":"import pandas as p…          [error]
  ┌ INPUT  ───────────────────────────────┐
  │ { …pretty JSON, max-h-64, scroll }    │
  ├ RESULT ───────────────────────────────┤
  │ …text, max-h-80, scroll               │
  └───────────────────────────────────────┘
```

- Trigger: `<button className="flex w-full items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-left text-xs hover:bg-muted/70 [&[data-state=open]>svg:first-child]:rotate-90">` containing
  `ChevronRight` (`size-3.5 shrink-0 text-muted-foreground transition-transform`),
  `Wrench` (`size-3.5 shrink-0 text-muted-foreground`), tool name
  (`font-mono font-medium`), one-line input preview
  (`min-w-0 flex-1 truncate text-muted-foreground`, `JSON.stringify(input)` sliced to ~140 chars),
  and `<Badge variant="destructive">error</Badge>` when the paired result `is_error`.
- Content: `rounded-md border bg-muted/20 mt-1 p-3 space-y-2` with labeled sections — label
  `text-[10px] font-medium uppercase tracking-wide text-muted-foreground`; body
  `<pre className="max-h-64 overflow-auto rounded-md border bg-background p-2.5 font-mono text-xs whitespace-pre-wrap break-words">`.
  Sections: Input (pretty JSON), Result (stringified content — port `toolResultOut`; `max-h-80`;
  muted `“(no result captured)”` when unpaired).

**`markdown.tsx`** — wrap `react-markdown` + `remark-gfm` (both root deps):
`<div className="md-body text-sm"><ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown></div>`.
Add to `app.css` a small scoped block (this replaces the old hand-rolled `mdToHtml`):

```css
.md-body :is(h1, h2, h3, h4) { @apply mt-4 mb-1.5 font-semibold; }
.md-body h1 { @apply text-base; }
.md-body h2 { @apply text-[0.9375rem]; }
.md-body h3, .md-body h4 { @apply text-sm; }
.md-body p { @apply my-1.5 leading-relaxed; }
.md-body ul, .md-body ol { @apply my-1.5 list-outside pl-5; }
.md-body ul { @apply list-disc; }
.md-body ol { @apply list-decimal; }
.md-body li { @apply my-0.5; }
.md-body code:not(pre code) { @apply rounded bg-muted px-1 py-0.5 font-mono text-xs; }
.md-body pre { @apply my-2 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs; }
.md-body table { @apply my-2 w-full border-collapse text-xs; }
.md-body th, .md-body td { @apply border px-2 py-1 text-left; }
.md-body th { @apply bg-muted/50 font-medium; }
.md-body blockquote { @apply my-2 border-l-2 pl-3 text-muted-foreground; }
.md-body a { @apply text-primary underline underline-offset-2; }
.md-body hr { @apply my-3; }
```

Render markdown links with `target="_blank" rel="noopener"` (via a `components={{ a }}` override).

### 9.5 Log and Raw JSON tabs (`text-viewer.tsx`)

One shared shell for both:

```
┌──────────────────────────────────────────────────────────┐
│ output.log                              [⧉ Copy] [↗ Raw] │  px-4 py-2 border-b
│  …mono text, pre-wrap, max-h-[70vh] overflow-auto…       │  p-4
└──────────────────────────────────────────────────────────┘
```

`rounded-xl border` container; header row `flex items-center justify-between border-b px-4 py-2`
with the filename in `font-mono text-xs text-muted-foreground` and ghost `size-sm` buttons; body
`<pre className="max-h-[70vh] overflow-auto p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">`.

- **Log tab**: lazily `fetchLog(runId)`; render `stripAnsi(text)`; `null`/empty →
  `“(no output captured)”` muted, centered `py-12`. "Raw" button links to
  `/api/runs/:id/log` (`target="_blank"`). Copy button copies the stripped text.
- **Raw JSON tab**: `JSON.stringify(run, null, 2)` (already loaded — no fetch). Filename label
  `run.json`; no Raw link; copy copies the JSON.
- Loading state for the log: three stacked `Skeleton` lines inside the body.

---

## 10. Shared micro-components

### 10.1 `verdict-badge.tsx`

```tsx
import { Badge } from "@/components/ui/badge";
import { CircleCheck, CircleX } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RunStatus } from "../../src/types";

export function VerdictBadge({ status, size = "default" }: { status: RunStatus; size?: "default" | "lg" }) {
	const lg = size === "lg" ? "h-6 px-2.5 text-xs [&>svg]:size-3.5!" : "";
	return status === "completed" ? (
		<Badge className={cn("border-transparent bg-green-600/10 text-green-700 dark:bg-green-500/15 dark:text-green-400", lg)}>
			<CircleCheck data-icon="inline-start" />
			Pass
		</Badge>
	) : (
		<Badge variant="destructive" className={lg}>
			<CircleX data-icon="inline-start" />
			Fail
		</Badge>
	);
}
```

The list uses default size; the detail header uses `size="lg"`.

### 10.2 `score.tsx` — bands, value, bar

```tsx
export type ScoreBand = "good" | "mid" | "bad";
export const scoreBand = (pct: number): ScoreBand => (pct >= 80 ? "good" : pct >= 50 ? "mid" : "bad");

export const scoreTextClass: Record<ScoreBand, string> = {
	good: "text-green-700 dark:text-green-400",
	mid: "text-amber-600 dark:text-amber-400",
	bad: "text-red-600 dark:text-red-400",
};
```

- `ScoreValue({ percentage, points, maxPoints, size })` — renders the colored percentage (and the
  muted `points/maxPoints` line where the spec calls for it). `percentage` non-number → muted `—`.
- `ScoreBar({ value, className })` — wraps the shared `Progress`; the indicator is fixed
  `bg-primary` in the primitive, so recolor via a child selector on the root:

```tsx
const scoreBarClass: Record<ScoreBand, string> = {
	good: "[&_[data-slot=progress-indicator]]:bg-green-600 dark:[&_[data-slot=progress-indicator]]:bg-green-500",
	mid: "[&_[data-slot=progress-indicator]]:bg-amber-500",
	bad: "[&_[data-slot=progress-indicator]]:bg-red-600 dark:[&_[data-slot=progress-indicator]]:bg-red-500",
};
<Progress value={clamped} className={cn(scoreBarClass[scoreBand(clamped)], className)} />
```

Clamp `value` to `[0, 100]`; treat non-finite as 0. Do not modify `src/components/ui/progress.tsx`.

---

## 11. Cleanup + docs

- Delete `workers/eval-reports/dashboard/` entirely (both files) once parity is verified.
- Update `workers/eval-reports/README.md`: Layout section (`dashboard/index.html` →
  `index.html` + `app/` SPA + `vite.config.ts`; note primitives/theme come from the main app's
  `src/components/ui` and `src/styles/shadcn-theme.css`), and the Local dev section
  (`bun run dev:eval-reports` from the repo root, port 8789, `.dev.vars` with
  `CF_ACCESS_ENABLED=0`; the reporter seeding command stays the same). Mention the build-then-
  deploy flow under Deploy.
- `SKILL.md` and root `AGENTS.md` need no changes (verified: no references to the dashboard file
  or the dev/deploy command shapes that change). If you alter the deploy script *name*, update
  both — but this plan keeps `bun run deploy:eval-reports`.

---

## 12. Verification

### 12.1 Commands

```bash
cd workers/eval-reports && bun run typecheck        # both tsconfigs
bun run lint                                        # from repo root; new app/ code is covered
vite build --config workers/eval-reports/vite.config.ts
vite preview --config workers/eval-reports/vite.config.ts   # serves the BUILT worker+assets; smoke it
bun run dev                                         # main app still renders after the globals.css split
```

Also confirm after `vite build`: `workers/eval-reports/.wrangler/deploy/config.json` exists (the
deploy redirect, §4.7) and `dist/` contains a `wrangler.json` with the assets directory set.

### 12.2 Seed fixtures (local dev)

Run `bun run dev:eval-reports` (with `workers/eval-reports/.dev.vars` containing
`CF_ACCESS_ENABLED=0`), then seed three runs covering every visual state:

```bash
BASE=http://localhost:8789

cat > /tmp/eval-pass.json <<'EOF'
{
  "result": "## Verdict\nThe app **deployed cleanly** and all checks passed.\n\n| check | ok |\n|---|---|\n| build | yes |",
  "messages": [
    { "role": "user", "content": "Build a dashboard from the fake data and deploy it." },
    { "role": "assistant", "content": [
      { "type": "thinking", "thinking": "I should scaffold the app first, then wire the data." },
      { "type": "text", "text": "Scaffolding the app now." },
      { "type": "tool_use", "id": "t1", "name": "create_app", "input": { "template": "react", "name": "metrics-dash" } }
    ]},
    { "role": "user", "content": [
      { "type": "tool_result", "tool_use_id": "t1", "content": [{ "type": "text", "text": "created app metrics-dash" }] }
    ]},
    { "role": "assistant", "content": [{ "type": "text", "text": "Done — deployed to the preview URL." }] }
  ],
  "evaluation": {
    "passFail": { "criteria": [
      { "id": "deploys", "label": "App deploys successfully", "status": "passed" },
      { "id": "data", "label": "Charts use the provided data", "status": "passed", "reason": "All three charts bound to fixture rows." }
    ]},
    "scorecard": { "criteria": [
      { "id": "charts", "label": "Charts render", "points": 5, "maxPoints": 5 },
      { "id": "polish", "label": "Visual polish", "points": 4, "maxPoints": 5, "reason": "Minor spacing issues.", "details": { "notes": ["header cramped"] } }
    ]}
  },
  "signal": { "assistantTurnCount": 14, "toolCallCount": 32, "badToolCallCount": 0,
    "tokenUsage": { "totalTokens": 1200000, "inputTokens": 1100000, "outputTokens": 100000, "costUsd": 0.41 } },
  "deployedApps": [{ "name": "metrics-dash", "url": "https://metrics-dash.evals.camelai.app" }]
}
EOF

cat > /tmp/eval-fail.json <<'EOF'
{
  "messages": [
    { "role": "user", "content": "Deploy the app with live data." },
    { "role": "assistant", "content": [
      { "type": "tool_use", "id": "t1", "name": "deploy_app", "input": { "name": "broken-app" } }
    ]},
    { "role": "user", "content": [
      { "type": "tool_result", "tool_use_id": "t1", "is_error": true, "content": "Error: build failed — missing module ./data" }
    ]},
    { "role": "assistant", "content": [{ "type": "redacted_thinking" }, { "type": "text", "text": "The build failed; giving up." }] }
  ],
  "error": "agent gave up after tool failure",
  "evaluation": {
    "passFail": { "criteria": [
      { "id": "deploys", "label": "App deploys successfully", "status": "failed", "reason": "Deploy tool returned a build error.", "details": { "exit": 1 } },
      { "id": "honest", "label": "Agent reports failure honestly", "status": "passed" }
    ]},
    "scorecard": { "criteria": [
      { "id": "progress", "label": "Meaningful progress", "points": 1, "maxPoints": 5, "reason": "Stopped at first error." }
    ]}
  },
  "signal": { "assistantTurnCount": 22, "toolCallCount": 41, "badToolCallCount": 2,
    "violations": ["used forbidden network egress"],
    "tokenUsage": { "totalTokens": 2400000, "costUsd": 0.88 } }
}
EOF

echo '{ "messages": [ { "role": "user", "content": "hi" } ] }' > /tmp/eval-contract.json

seed() { # $1 runId  $2 fixture  $3 complete-body
  curl -sf -X PUT "$BASE/upload/$1/artifacts/$1.json" --data-binary "@$2" -o /dev/null
  printf 'starting eval…\n\x1b[32mPASS\x1b[0m step one\ndone.\n' \
    | curl -sf -X PUT "$BASE/upload/$1/log" --data-binary @- -o /dev/null
  curl -sf -X POST "$BASE/upload/$1/complete" -H 'content-type: application/json' -d "$3" -o /dev/null
}

seed eval-20260707-100000Z-pass1 /tmp/eval-pass.json '{"evalTarget":"dashboard-fake-data-live","exitCode":0,"ref":"main","commit":"a1b2c3d4e5f6","model":"claude-opus-4-8","realDeploy":true,"startedAt":"2026-07-07T09:55:00Z","finishedAt":"2026-07-07T09:59:12Z","host":"mbp.local"}'
seed eval-20260707-110000Z-fail1 /tmp/eval-fail.json '{"evalTarget":"deploy-fake-data-live","exitCode":1,"ref":"pi/tool-fix","commit":"9f8e7d6c5b4a","startedAt":"2026-07-07T10:50:00Z","finishedAt":"2026-07-07T10:59:03Z","host":"mbp.local"}'
seed eval-20260707-120000Z-contract1 /tmp/eval-contract.json '{"evalTarget":"custom-prompt-live","exitCode":0,"ref":"main","startedAt":"2026-07-07T11:58:00Z","finishedAt":"2026-07-07T12:00:00Z"}'
```

### 12.3 Visual states to verify in the browser

Drive each of these (light **and** dark, plus one narrow-window pass on the list):

1. List: three rows with correct badges, band-colored scores, `default model` fallback, `2 bad`
   and `1 violations` badges on the fail row; hover the Fail badge → criteria HoverCard; search /
   status / eval filters (URL params update; "no matches" state; Clear filters); empty state on a
   fresh bucket (delete `.wrangler` state or use a fresh port).
2. Detail (pass run): header score block, meta line with `real deploy` badge, copy runId; stats
   strip; criteria all-pass; scorecard rows with bars + details collapsible; deployed-apps card
   links out.
3. Detail (fail run): run-error alert, violations alert, failed criterion sorted first with
   reason + details, exit-code tile destructive; transcript — thinking collapsed, redacted
   thinking, tool call paired with its error result **auto-expanded** with error badge.
4. Detail (contract run): contract-failure alert; criteria card shows the synthesized
   `evaluation_contract` row; scorecard card absent.
5. Transcript: result card renders markdown (heading + table); multi-artifact Select (seed a
   second artifact into one run to check); "No transcript artifact" on a run with none.
6. Log tab: ANSI stripped, copy + raw-link work; Raw JSON tab shows the run record.
7. Legacy link: `http://localhost:8789/#/run/eval-20260707-100000Z-pass1` redirects to the detail
   page; a bogus `/runs/nope` shows the 404 error boundary; direct-load of
   `/runs/<id>` (hard refresh) works via SPA fallback.

---

## 13. Out of scope — do not do these

- No changes to the upload/read API, `ingest.ts`, `access.ts`, the reporter
  (`scripts/report-eval-run.mjs`), or the R2 layout.
- No edits to any file in `src/components/ui/` or `src/lib/utils.ts`; the only main-app change is
  the `globals.css` → `shadcn-theme.css` split (§4.1) and the root `package.json`/`.gitignore`
  script entries.
- No pagination, sorting controls, charts/trend views, run comparison, auto-refresh/polling, or
  delete/re-run actions.
- No new test suites — this worker has none today; verification is §12.
- Don't touch `workers/e2e-reports/` (separate viewer, still single-file by design).
