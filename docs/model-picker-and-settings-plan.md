# Model Picker & Models Settings Tab Plan

**Date:** 2026-05-06
**Branch:** `illianaa/model-picker-plan`
**Scope:** Replace the chat composer's model `<Select>` with a richer picker (logo rows + hover metadata + "Manage models" link), and add a new admin-only `Settings → Models` tab that lets admins choose which models appear in the picker (org-wide, with optional per-workspace overrides) and which is the default.

---

## 1. Objective

Today the model picker is a plain shadcn `<Select>` rendered inside `prompt-input.tsx` ([src/components/prompt-input.tsx:587-612](src/components/prompt-input.tsx#L587-L612)). It pulls a flat list from `LLM_MODEL_OPTIONS` ([src/lib/llm-provider-config.ts:57-61](src/lib/llm-provider-config.ts#L57-L61)) and shows only `label` + `description`. There is no admin control over which models appear, no metadata (cost/intelligence/speed), no logos, no notion of a per-org or per-workspace catalog, and no concept of a user-default-or-recent fallback.

This plan delivers:

1. **A redesigned picker** with provider logo rows, a hover metadata tooltip ($/intelligence/speed), and a "Manage models" footer link.
2. **A new `Settings → Models` tab** (admin-only) where admins pick the up-to-10 models that appear in their org's picker and select an org-wide default.
3. **A workspace selector** at the top of the Models tab so admins can override the catalog per workspace (only shown for orgs with >1 workspace).
4. **A "most recently used model" `localStorage` fallback** so the picker pre-selects what the user last picked when no admin default is set.
5. **A cost-bucketing utility** that derives `$ / $$ / $$$` from the existing per-token pricing in `services/sandbox-host/internal/app/usage_pricing.go`.
6. **Provider logo plumbing** for Claude, Grok, and Kimi (files already downloaded — they need to be moved into `public/logos/` and registered).

Out of scope (explicit non-goals): the "NEW" tag for newly released models, drag-to-reorder, and any backend pricing changes — pricing remains canonical in the Go service.

**Technical audit update:** the picker config is not just presentation state. Any user-facing path that creates a thread or changes a thread model must validate against the effective picker config (workspace override → org default) after BYOK/harness filtering. Otherwise a crafted request could still select hidden models even if the UI no longer shows them.

---

## 2. Current State (one-screen recap)

```
┌── prompt composer ──────────────────────────────┐
│  [text input]                                   │
│                                                 │
│  +  [ Sonnet ▾ ]  ⓘ70%        🎤  ↑           │
└─────────────────────────────────────────────────┘

         ↓ click

   ┌────────────────────────────────────┐
   │ Sonnet      Default and recommended │
   │ Haiku       Faster and cheaper       │
   │ Opus        Smarter, but slower …    │
   └────────────────────────────────────┘
```

Rendering: `<Select>` (shadcn), one row per model. Models hard-coded in `CLAUDE_LLM_MODEL_OPTIONS` and `CODEX_LLM_MODEL_OPTIONS` in `src/lib/llm-provider-config.ts`. Visibility is filtered by `getVisibleLlmModelOptions` based on org provider (BYOK) and the `claude_proxy_models` experimental flag — admins have no other lever.

Existing models (canonical IDs in [src/lib/llm-provider-config.ts](src/lib/llm-provider-config.ts) and [services/sandbox-host/internal/app/usage_pricing.go](services/sandbox-host/internal/app/usage_pricing.go)):

| ID            | Display label  | Provider  | Harness | Pricing key (Go)                |
|---------------|----------------|-----------|---------|----------------------------------|
| `opus`        | Opus 4.6       | anthropic | claude  | `claude-opus-4-6`               |
| `sonnet`      | Sonnet 4.6     | anthropic | claude  | `claude-sonnet-4-6`             |
| `haiku`       | Haiku 4.5      | anthropic | claude  | `claude-haiku-4-5-20251001`     |
| `gpt-5.4`     | GPT-5.4        | openai    | codex   | `gpt-5.4`                       |
| `gpt-5.4-mini`| GPT-5.4 Mini   | openai    | codex   | `gpt-5.4-mini`                  |
| `kimi-k2.6`   | Kimi K2.6      | moonshotai (via OpenRouter) | codex | `kimi-k2.6`         |
| `grok-4.3`    | Grok 4.3       | xai (via OpenRouter)        | codex | `grok-4.3`          |

Note: today's labels (`"Sonnet"`, `"Opus"`) drop the version. Per the mock the new picker shows version-qualified names — `Sonnet 4.6`, `Opus 4.6`, `Haiku 4.5`. This plan adds those labels.

`gemini-3-flash-preview` is in the Go pricing table but is a **virtual-AI-only** model (used for thread auto-titling per recent commits) — keep it out of the user-facing picker.

---

## 3. New Picker UX

### 3.1 Layout

```
┌──────────────────────────────────────────┐
│ Ⓐ  Opus 4.6                            ✓ │   ← selected row: bg-accent + check
│ Ⓐ  Sonnet 4.6                            │
│ Ⓐ  Haiku 4.5                             │
│ Ⓞ  GPT-5.4                               │
│ Ⓞ  GPT-5.4 Mini                          │
│ Ⓜ  Kimi K2.6                             │
│ Ⓧ  Grok 4.3                              │
│ ──────────────────────────────────────── │
│  Manage models                           │   ← muted, plain text link
└──────────────────────────────────────────┘
```

Per row:
- Provider logo (16×16, themed via `<IntegrationIcon>`-style component — see §7)
- Model label
- Right side: ✓ if currently selected (no other adornments in v1 — NEW tag is out of scope)

Footer (always visible, separator above):
- "Manage models" — `text-xs text-muted-foreground` link to `/settings/organization/models`. If the user is **not** an org admin, hide the link entirely.

### 3.2 Hover state — metadata tooltip

```
┌─────────────────┐  ┌──────────────────────────┐
│ Ⓐ Opus 4.6   ✓ │  │ Opus 4.6                 │
│ Ⓐ Sonnet 4.6   │  │ ──────────────────────── │
│ ...            │  │ cost            $$$      │
└─────────────────┘  │ intelligence    high     │
                     │ speed           slow     │
                     └──────────────────────────┘
```

A floating card sits to the right of the menu (or to the left if it would overflow viewport) and reflects the row currently hovered. Implementation: a single `<HoverCard>` (shadcn) per row, positioned `side="right" align="start"` with `openDelay={150}`. The hovered model's metadata fills the card.

If no row is hovered, no tooltip is rendered.

### 3.3 Implementation — replace the `<Select>`

Build a new component **`src/components/model-picker.tsx`** that wraps shadcn `<DropdownMenu>` (not `<Select>`; we need fully custom row rendering, footer link, and hover tooltips per item — `<Select>`'s `<SelectItem>` is too constrained).

```tsx
interface ModelPickerProps {
  value: LlmModel;
  onValueChange: (model: LlmModel) => void;
  options: ReadonlyArray<ModelCatalogEntry>;   // already filtered + sorted by caller
  isOrgAdmin: boolean;
  recentModelScope?: { orgId: string; workspaceId: string };
  disabled?: boolean;
  manageModelsHref?: string;                   // defaults to /settings/organization/models
}
```

Composition:

| Element         | shadcn primitive                                                |
|-----------------|------------------------------------------------------------------|
| Trigger         | Reuse the current trigger styling from `prompt-input.tsx:593-599` (transparent, underline-on-focus pill). Wrap in `DropdownMenuTrigger asChild`. |
| Menu shell      | `DropdownMenuContent align="start"`                              |
| Each row        | `DropdownMenuItem` — flex row: logo, label, spacer, ✓ if selected. Wrap in `<HoverCard>` for the tooltip. |
| Separator       | `DropdownMenuSeparator`                                          |
| Footer link     | `DropdownMenuItem asChild` containing `<Link to={manageModelsHref}>` (text-xs, muted) |

Wire-up in **`src/components/prompt-input.tsx`**:

- Replace the `<Select>` block (lines 587-612) with `<ModelPicker>`.
- Pass `options` as the already-filtered catalog (caller-provided).
- Pass `isOrgAdmin` (resolved from auth context one level up — `prompt-input.tsx` doesn't fetch auth itself; caller in `Chat.tsx` will pass it).
- Add `manageModelsHref="/settings/organization/models"`.
- Trigger keeps its existing classes so the pill placement in the composer footer is unchanged.

### 3.4 Catalog filtering callers must do

The existing helper `getVisibleLlmModelOptions(provider, experimentalSettings, includeModel, options)` already filters by harness + BYOK org provider. **Wrap it** into a pure helper `resolveModelPickerCatalog(...)` (in the new `src/lib/model-catalog.ts` — see §4). Do not make this helper fetch Durable Objects; loaders/actions should load configs, resolve inheritance, and pass the effective config in. The helper additionally:

1. Accepts the already-resolved picker config (workspace override → org default — see §5).
2. Intersects with the harness/provider-allowed set returned by `getVisibleLlmModelOptions`.
3. Maps each ID into a `ModelCatalogEntry` (label, provider logo type, cost bucket, intelligence, speed).
4. Sorts: first by provider in display order (Anthropic → OpenAI → OpenRouter), then by `added_at` desc within each provider (newest in the org's picker first — admins control "added_at" via add/remove actions).

### 3.5 Picker is fully switchable on any thread

The model can be switched on **any** thread at **any** time. The user-facing path already supports this: `intent=updateThreadModel` in [src/routes/_app.chat.$id.tsx:164-212](src/routes/_app.chat.$id.tsx#L164-L212) calls `chatDO.updateThreadModel`, then rebroadcasts via `chatThread.setModel` + `refreshRunnerConfig` — no server-side guard against switching mid-thread.

So the picker on an existing thread renders just like the picker on the welcome screen: full catalog, fully interactive. The `modelDisabled` prop on `<PromptInput>` is only used for **transient** disable while a send is in flight ([src/components/Chat.tsx:5862-5866](src/components/Chat.tsx#L5862-L5866) — `loading || isStreaming || updateThreadModelFetcher.state !== "idle"`). Keep that behavior; it prevents picker thrash mid-send and is unrelated to thread locking. The `<ModelPicker>` accepts `disabled?: boolean` and forwards it to `<DropdownMenuTrigger>`.

**Dead lock logic to remove from the user-facing path** — the coding agent should grep + delete. Per [src/lib/llm-provider-config.ts:13-14](src/lib/llm-provider-config.ts#L13-L14), the constant `THREAD_MODEL_LOCK_MESSAGE` exists but is no longer referenced from any user-facing flow:

| File | Status | Action |
|---|---|---|
| `src/lib/llm-provider-config.ts:13-14` (constant) | Still exported, but only consumed by admin paths now | **Keep** — admin paths still want it |
| `src/routes/_admin.threads.$id.tsx:7,70` | Admin backdoor blocks model edits on existing threads | **Keep** — intentional admin-side restriction |
| `workers/main/src/routes/admin/routes.ts:21,1393,1400,1417,1424` | Admin API blocks model edits | **Keep** — same |
| `src/components/admin/thread-edit-form.tsx:10,98` | Admin form shows the message | **Keep** — same |
| Any other usage in `src/components/`, `src/routes/_app.*`, `src/lib/` | Should be **none** | If grep finds any, delete it as part of this PR |

Run `rg "THREAD_MODEL_LOCK_MESSAGE|modelDisabled" src/` once before shipping. The expected hits are: the four admin-path lines above, the `modelDisabled` prop in `prompt-input.tsx`/`Chat.tsx`/`welcome-screen/index.tsx`. Any other hit is dead code from the old lock semantics — remove it.

### 3.6 Server-side enforcement for hidden models

The picker config must be enforced on the backend wherever users can choose or default into a chat model:

| Path | Current code | Required change |
|---|---|---|
| `src/routes/_app.chat._index.tsx` create-thread action | Validates `isLlmModelAllowedForNewThread(...)` only | Also validate `model ∈ effective visible catalog` for the current workspace. Return 400 if hidden/removed. |
| `src/routes/_app.chat.$id.tsx` loader | Loads BYOK config but does not pass `llmProvider` / `allowedThreadModels` to `Chat` | Return `llmProvider`, `allowedThreadModels`, and the effective picker default for existing-thread reconciliation. |
| `src/routes/_app.chat.$id.tsx` update action / `src/lib/chat-do.server.ts:updateThreadModel` | Validates BYOK/harness only | Also reject models not in the effective visible catalog for that thread's workspace. |
| `src/routes/api/workspaces.$id.chat.threads.ts` | Validates BYOK/harness before delegating to `chatDO.createThread` | Either remove duplicate validation or update it to use the same effective-catalog helper; `chatDO.createThread` should remain the final authority. |
| `workers/main/src/workspace-cron.ts`, `workers/main/src/email-ingress.ts`, `workers/main/src/routes/integrations.ts` | Create threads directly with `getDefaultLlmModel(...)` | Use the shared server helper for the effective default so scheduled, email, and Slack-created threads honor admin model settings. |

Add a shared server-safe resolver (for example in `src/lib/model-picker-config.ts`, with only pure helpers and DO callers passing fetched configs in):

```ts
export function resolveAllowedPickerModels(args: {
  effectiveConfig: EffectiveModelPickerConfig;
  provider: ChatHarness;
  experimentalSettings: OrganizationExperimentalSettings;
  orgProvider: LlmProvider | null;
}): ModelCatalogEntry[];

export function resolveDefaultModelForChat(args: {
  effectiveConfig: EffectiveModelPickerConfig;
  visibleCatalog: ModelCatalogEntry[];
  recentModel?: LlmModel | null;
}): LlmModel | null;
```

For existing threads, keep the current model only if it is still present in the visible catalog. If an admin removes that model while a user has the thread open, `Chat` should reconcile after revalidation: pick the same fallback chain from §6.1, submit `updateThreadModel` once when idle, and disable sending if no visible model remains. Do not silently send the next user message on a model the admin removed.

---

## 4. Model Catalog & Metadata

Create **`src/lib/model-catalog.ts`** as the single source of truth for picker-facing model metadata. It hangs alongside (does not replace) the harness-routing logic in `llm-provider-config.ts` — that file stays focused on provider/harness wiring.

```ts
import type { LlmModel } from "@/types";

export type ProviderLogoType =
  | "claude"      // Anthropic-family models (Claude logo, not Anthropic logo — see §7)
  | "openai"
  | "kimi"
  | "grok";

export type CostBucket = "$" | "$$" | "$$$";
export type Intelligence = "low" | "medium" | "high";
export type Speed = "slow" | "balanced" | "fast";

export interface ModelCatalogEntry {
  id: LlmModel;
  label: string;                 // version-qualified, e.g. "Sonnet 4.6"
  providerLogo: ProviderLogoType;
  providerOrder: number;         // 0 = Anthropic, 1 = OpenAI, 2 = OpenRouter (Kimi, Grok)
  cost: CostBucket;              // derived (see §4.1)
  intelligence: Intelligence;    // manual
  speed: Speed;                  // manual
}

export const MODEL_CATALOG: Readonly<Record<LlmModel, ModelCatalogEntry>> = {
  opus:           { id: "opus",           label: "Opus 4.6",      providerLogo: "claude", providerOrder: 0, cost: "$$$", intelligence: "high",   speed: "slow" },
  sonnet:         { id: "sonnet",         label: "Sonnet 4.6",    providerLogo: "claude", providerOrder: 0, cost: "$$",  intelligence: "medium", speed: "balanced" },
  haiku:          { id: "haiku",          label: "Haiku 4.5",     providerLogo: "claude", providerOrder: 0, cost: "$",   intelligence: "low",    speed: "fast" },
  "gpt-5.4":      { id: "gpt-5.4",        label: "GPT-5.4",       providerLogo: "openai", providerOrder: 1, cost: "$$",  intelligence: "high",   speed: "balanced" },
  "gpt-5.4-mini": { id: "gpt-5.4-mini",   label: "GPT-5.4 Mini",  providerLogo: "openai", providerOrder: 1, cost: "$",   intelligence: "low",    speed: "fast" },
  "kimi-k2.6":    { id: "kimi-k2.6",      label: "Kimi K2.6",     providerLogo: "kimi",   providerOrder: 2, cost: "$",   intelligence: "medium", speed: "balanced" },
  "grok-4.3":     { id: "grok-4.3",       label: "Grok 4.3",      providerLogo: "grok",   providerOrder: 2, cost: "$",   intelligence: "medium", speed: "fast" },
};
```

The intelligence + speed values above are **set by the user** and should be shipped as written. They live as plain strings on the wire so future tweaks are a copy edit, not a schema migration.

> Note: `Intelligence` no longer needs `"very high"` — drop it from the type union since no model uses it.

### 4.1 Deriving the cost bucket

The Go service stores per-token USD pricing in [services/sandbox-host/internal/app/usage_pricing.go:16-121](services/sandbox-host/internal/app/usage_pricing.go#L16-L121). Multiplying by 1,000,000 gives per-million-token pricing, which we bucket as follows:

| Bucket | Input price (USD/M) | Output price (USD/M) | Models                                                |
|--------|---------------------|----------------------|--------------------------------------------------------|
| `$`    | < $2                | < $10                | `haiku` (1/5), `gpt-5.4-mini` (0.75/4.5), `kimi-k2.6` (0.74/4.66), `grok-4.3` (1.25/2.5) |
| `$$`   | $2 – $4             | $10 – $20            | `sonnet` (3/15), `gpt-5.4` (2.5/15)                    |
| `$$$`  | ≥ $5                | ≥ $20                | `opus` (5/25)                                          |

Decision: bucket assignments are **hard-coded in `MODEL_CATALOG`** above rather than computed at runtime. Reasons:

- The coding agent should not import Go pricing into TS just to display a tier indicator — that creates a cross-language data dependency for cosmetics.
- Pricing changes are infrequent and already require a Go deploy. Make the picker bucket part of the same review.
- A single source-of-truth comment in `model-catalog.ts` should reference `services/sandbox-host/internal/app/usage_pricing.go` so future pricing edits have a paired-edit reminder.

Add this comment block above `MODEL_CATALOG`:

```ts
// Cost buckets are derived by hand from per-token pricing in
// services/sandbox-host/internal/app/usage_pricing.go. If you change pricing
// there, update the `cost` field below in the same PR.
//
// Buckets (USD per million tokens):
//   $   = input < $2  AND output < $10
//   $$  = input $2-4  AND output $10-20
//   $$$ = input ≥ $5  OR  output ≥ $20
```

### 4.2 Dock — Adding a new model

When a new model joins the platform (either a new Anthropic/OpenAI release or a new third-party via OpenRouter), the agent doing that work has to touch several files to keep the picker, pricing, and harness routing in sync. The plan installs a discoverable checklist in three places so nothing is forgotten:

**A. A header comment block at the top of `src/lib/model-catalog.ts`** — the canonical location:

```ts
// ┌─────────────────────────────────────────────────────────────────┐
// │ Adding a new model — checklist                                  │
// │                                                                 │
// │ 1. Add the canonical ID to the LlmModel union in src/types.ts   │
// │ 2. Add the harness-routing branches in                          │
// │    src/lib/llm-provider-config.ts:                              │
// │      - getProviderForModel                                      │
// │      - isLlmModel (both branched + unbranched)                  │
// │      - isLlmModelAllowedForOrgProvider (BYOK gating)            │
// │      - CLAUDE_LLM_MODEL_OPTIONS or CODEX_LLM_MODEL_OPTIONS      │
// │ 3. Add per-token pricing in                                     │
// │    services/sandbox-host/internal/app/usage_pricing.go          │
// │    (input + output, plus cache_creation/cache_read for Claude)  │
// │ 4. Add a MODEL_CATALOG entry below with:                        │
// │      - version-qualified label ("Sonnet 4.7", not "Sonnet")     │
// │      - providerLogo type (must exist in integration-logo-       │
// │        registry.ts; add the SVG to public/logos/ if new)        │
// │      - providerOrder (0 Anthropic, 1 OpenAI, 2 OpenRouter)      │
// │      - cost bucket (derive from §4.1 thresholds)                │
// │      - intelligence + speed (manual; ask the user if unsure)    │
// │ 5. Update the default org picker config in OrgDO if the model   │
// │    should ship in the default catalog (see §8.4).               │
// │ 6. Add a row to the model catalog test in                       │
// │    src/lib/model-catalog.test.ts so it doesn't regress.         │
// │ 7. Confirm the LlmModel union, MODEL_CATALOG, pricing table,    │
// │    and isLlmModel agree on the new ID — the test suite in §11   │
// │    catches drift between catalog and pricing.                   │
// └─────────────────────────────────────────────────────────────────┘
```

**B. A short "Adding a new model" entry in `AGENTS.md`** under the "Chat And Runtime Flow" section, pointing back to this checklist:

```md
### Adding a new chat model

When adding a new model (Claude, OpenAI, OpenRouter), follow the checklist at
the top of `src/lib/model-catalog.ts`. The picker, pricing, and harness
routing live in separate files (TS catalog, Go pricing) and the catalog test
will fail if any of them drift apart.
```

**C. Cross-reference comments at the call sites** — short pointers, not duplicated checklists:

```go
// services/sandbox-host/internal/app/usage_pricing.go (above modelPricingTable)
// When adding a model here, also add it to the picker catalog at
// src/lib/model-catalog.ts. See the checklist there.
```

```ts
// src/lib/llm-provider-config.ts (above CLAUDE_LLM_MODEL_OPTIONS)
// When adding a model here, also add it to the picker catalog at
// src/lib/model-catalog.ts and the pricing table at
// services/sandbox-host/internal/app/usage_pricing.go.
```

The §11 test suite includes a catalog-completeness test (`every LlmModel has a MODEL_CATALOG entry`) and a pricing-coverage test (`every LlmModel maps to a non-fallback price`), so missing one of these steps fails CI rather than slipping through.

---

## 5. Settings → Models Tab (admin-only)

### 5.1 Routing

New route: `/settings/organization/models`. Add to **`src/routes.ts`** in the organization layout (line 49-78), and to **`src/components/settings/settings-nav.tsx`** in the Organization group with `adminOnly: true`. Place it directly below "AI Provider" so admins find both LLM-facing tabs together.

```ts
// src/routes.ts — inside the organization layout
route(
  "settings/organization/models",
  "routes/_app.settings.organization.models.tsx",
),
```

```ts
// src/components/settings/settings-nav.tsx — Organization items
{ label: "AI Provider", href: "/settings/organization/ai-provider", adminOnly: true },
{ label: "Models",      href: "/settings/organization/models",      adminOnly: true },
```

### 5.2 Page layout — single-workspace org

No outer cards or framed containers — sections sit directly on the settings page surface and are separated by a single `<Separator>` line. Star + remove controls are right-aligned on each row.

```
┌──────────────────────────────────────────────────────────────────┐
│  Models                                                          │
│  Choose which models appear in your team's picker.               │
│                                                                  │
│  In your picker                                       4 of 10    │
│   Ⓐ Opus 4.6                                  ★      [ remove ] │
│   Ⓐ Sonnet 4.6                                ☆      [ remove ] │
│   Ⓐ Haiku 4.5                                 ☆      [ remove ] │
│   Ⓞ GPT-5.4                                   ☆      [ remove ] │
│                                                                  │
│  ──────────────────────────────────────────────────────────────  │
│                                                                  │
│  Additional models                                  3 available  │
│   Ⓞ GPT-5.4 Mini                                     [ add ]    │
│   Ⓜ Kimi K2.6                                        [ add ]    │
│   Ⓧ Grok 4.3                                         [ add ]    │
└──────────────────────────────────────────────────────────────────┘
```

- Section headers ("In your picker", "Additional models") are plain text — `text-sm font-medium` — with the count right-aligned in `text-sm text-muted-foreground` on the same row (`flex items-center justify-between`). No card wrapper, no border, no padding box.
- Single `<Separator />` between the two sections (no separator at top or bottom).
- Each row is a `flex items-center` div: logo + label on the left, star + remove button group right-aligned via `ml-auto` (or `justify-between` on the row container).
- `[remove]` and `[add]` are `<Button variant="outline" size="sm">`.
- Star is a `<Button variant="ghost" size="icon">` toggling between outlined `Star` and filled `Star` from `lucide-react`. Only one star can be filled at a time — clicking a different row's star moves the default and unsets the previous; clicking a filled star unsets it (no default → falls back to "most recently used", see §6).
- When `n === 10`, "Additional models" Add buttons are disabled with a tooltip "Picker capacity reached (max 10)."

Sort within "In your picker": `providerOrder` ASC, then `added_at` DESC (newest in picker first within each provider). Sort within "Additional models": `providerOrder` ASC, then `label` ASC.

Empty state: if a workspace's picker is empty (admin removed everything), the "In your picker" section shows a muted "No models in the picker — add at least one below for your team to chat." line. The chat composer must **not** fall back to `sonnet` in this case; it disables sending and shows the no-models message from §6.1 until an admin adds at least one visible model.

### 5.3 Page layout — multi-workspace org adds a workspace selector

When the org has more than one workspace, prepend the selector row above the sections. No "EDITING" label — the pills are self-explanatory.

```
┌──────────────────────────────────────────────────────────────────┐
│  Models                                                          │
│  Choose which models appear in your team's picker.               │
│                                                                  │
│  ┌─────────┐ ┌──────┐ ┌──────────────────┐ ┌──────────┐ ┌────────┐│
│  │Org      │ │● Core│ │● Customer Support│ │● Data Tm │ │● Resrch││
│  │default  │ │      │ │      CUSTOM      │ │          │ │ CUSTOM ││
│  └─────────┘ └══════┘ └──────────────────┘ └──────────┘ └────────┘│
│  ───────────────────────────────────────────────────────────────  │
│  ☑ Use org defaults for this workspace                           │
│                                                                  │
│  [ In your picker / Additional models sections — read-only       │
│    when the toggle is ON, editable when OFF ]                    │
└──────────────────────────────────────────────────────────────────┘
```

Selector behavior:

| Selected pill        | Body shows                                         | Toggle row             |
|----------------------|----------------------------------------------------|------------------------|
| "Org default"        | Org-wide config, fully editable                    | (toggle hidden)        |
| Specific workspace   | That workspace's config (inheriting if `use_org_defaults: true`) | "Use org defaults for this workspace" — checked by default for new workspaces |

When the toggle is **on**, the two sections render in read-only mode (no buttons, stars are non-interactive, an inline note says "Inheriting from org defaults — turn off the toggle to customize"). When **off**, the sections become editable and writes target the workspace, not the org.

The `CUSTOM` badge appears on each pill whose workspace currently has `use_org_defaults: false`.

Implementation:
- Workspace pill = `Button` variant `outline`, with selected state visualized via `data-[state=on]:ring-2 data-[state=on]:ring-primary` (use `<ToggleGroup type="single">` for the row).
- Workspace dot = a `size-2 rounded-full` colored using `workspace.avatar.color` ([src/types.ts:280](src/types.ts#L280)).
- The `Badge` "CUSTOM" reuses the existing `Badge variant="secondary"` from connections.

URL state: encode the editing scope as `?scope=org` (default) or `?scope=ws&workspaceId=xxx`. Mirrors the `?filter=` pattern in [src/routes/_app.settings.workspace.connections.tsx:206-211](src/routes/_app.settings.workspace.connections.tsx#L206-L211). Loaders read it, actions read it, no client-only state for the selector.

### 5.4 Loader + action contract

Modeled on the AI Provider page ([src/routes/_app.settings.organization.ai-provider.tsx](src/routes/_app.settings.organization.ai-provider.tsx)):

**Loader** — `routes/_app.settings.organization.models.tsx`:
1. `requireOrgAdmin`.
2. From URL: scope (`org` | `ws`) and `workspaceId`.
3. Fetch org picker config from OrgDO.
4. Fetch full workspace records via `listOrgWorkspaces(authEnv, orgId)` ([src/lib/auth-do.ts:716](src/lib/auth-do.ts#L716)), not just `orgStub.getWorkspaces()`. `OrgDO.getWorkspaces()` only returns id/name/archive metadata; the selector needs `workspace.avatar.color`, which lives on the `WorkspaceDO` `Workspace` JSON.
5. Fetch each workspace's `getModelPickerConfig()` in parallel to compute `hasCustomConfig` for the selector. For `scope=ws`, validate that `workspaceId` belongs to the current org before reading or writing the workspace DO.
6. Resolve the effective picker config (workspace override → org fallback) and split into `inPicker[]` / `additional[]` arrays.

Returns:
```ts
{
  scope: "org" | "ws",
  selectedWorkspaceId: string | null,
  workspaces: Array<{ id, name, avatarColor, hasCustomConfig: boolean }>,
  useOrgDefaults: boolean,                       // for ws scope; org scope ignores
  config: {
    inPicker: Array<{ entry: ModelCatalogEntry; addedAt: number; isDefault: boolean }>,
    additional: ModelCatalogEntry[],
    capacity: { used: number; max: 10 },
  },
}
```

**Action** — same route file. `useFetcher` with `intent` field, mirroring AI Provider's pattern:

| intent             | params                                          | side effect                                      |
|--------------------|-------------------------------------------------|--------------------------------------------------|
| `addModel`         | `{ model: LlmModel }`                           | append to `inPicker` (if not at capacity)        |
| `removeModel`      | `{ model: LlmModel }`                           | remove from `inPicker`; if it was default, clear default |
| `setDefault`       | `{ model: LlmModel \| null }`                   | set/clear default                                |
| `setUseOrgDefaults`| `{ useOrgDefaults: boolean }`                   | flip the workspace's inheritance flag while preserving any existing workspace models/default |

Each action infers org scope vs workspace scope from `?scope=` and `?workspaceId=` in the request URL. Workspace-scope actions must verify the target workspace belongs to the current org before mutating `WorkspaceDO`. All actions revalidate the loader on success (no manual state plumbing in the component).

Audit/logging: log model-picker changes inside the owning DO method (`setModelPickerConfig` can accept optional `{ actorId, action, details }`, or expose explicit action methods that call the existing private `log(...)`). Include the actor id, intent, model id where applicable, and before/after `use_org_defaults` for inheritance changes. These are admin-facing settings changes and should leave the same kind of audit trail as other org/workspace settings.

Toast on each: "Added Sonnet 4.6 to picker", "Removed Opus 4.6", "Set Sonnet 4.6 as default", etc. Matches AI Provider's `toast.success(...)` pattern.

### 5.5 Capacity enforcement

- **Client**: Add buttons disabled when `inPicker.length >= 10`; tooltip "Picker capacity reached (max 10)".
- **Server**: action `addModel` rejects with `{ error: "Picker capacity reached" }` when over cap. Belt + braces — never trust the client.

---

## 6. Default Model Resolution & `localStorage`

### 6.1 Resolution order (used by both the welcome screen and any "fresh" picker)

```
1. Effective default from picker config (org or workspace override)
2. localStorage["camelai.recentModel.{orgId}.{workspaceId}"]  ← only set when user actively picks
3. First visible model in (providerOrder, added_at DESC) order
```

Filter at every step against the **currently visible catalog** (picker config × harness × BYOK). If a step yields a model that isn't visible (e.g. user removed their saved-recent from the picker, or BYOK is openai-only and the org default is `sonnet`), skip to the next step.

Step 3 replaces the old "system fallback: sonnet" step because the system fallback could itself be filtered out by BYOK gating. Sorting `providerOrder ASC` then `added_at DESC` means: prefer Anthropic, then OpenAI, then OpenRouter; within each, the most recently added model. For an openai-only BYOK org with the default catalog, this resolves to `gpt-5.4`.

If step 3 also yields nothing (admin emptied the picker entirely AND no models pass the BYOK filter), the welcome screen disables the composer and shows an inline message: "No models are available. Ask an admin to add a model in Settings → Models." This is an unreachable state in practice but worth a defensive surface so the UI doesn't crash.

The chat loaders should return enough metadata for the client to apply this correctly: `allowedThreadModels`, `threadModel`, `hasEffectivePickerDefault`, and `{ orgId, workspaceId }` for recent-model scoping. The client must only apply localStorage recent-model override when `hasEffectivePickerDefault === false`.

### 6.2 `localStorage` write rules

Add a tiny module **`src/lib/recent-model.ts`**:

```ts
import { isLlmModel } from "@/lib/llm-provider-config";
import type { LlmModel } from "@/types";

const PREFIX = "camelai.recentModel";

export interface RecentModelScope {
  orgId: string;
  workspaceId: string;
}

function keyFor(scope: RecentModelScope): string {
  return `${PREFIX}.${scope.orgId}.${scope.workspaceId}`;
}

export function getRecentModel(scope: RecentModelScope): LlmModel | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(keyFor(scope));
  return isLlmModel(raw) ? raw : null;
}

export function setRecentModel(scope: RecentModelScope, model: LlmModel): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(keyFor(scope), model);
}
```

Write site: **only** in `<ModelPicker>`'s `onValueChange`, after calling the parent's `onValueChange(model)`, and only when `recentModelScope` is provided. Reason from spec: "the local storage should only be updated when a user picks a model from the picker list" — not when the welcome-screen loader resolves a default for them. Scope the key by org + workspace so a recent choice in one org/workspace does not become the fallback in another workspace with different admin settings.

Read site: the welcome route loader `_app.chat._index.tsx` cannot access `localStorage` (it runs server-side). So:

- **Loader** still computes a server-side default (org/workspace config → first visible model) and returns it as `threadModel` (existing field, line 247-250).
- **Client** in the welcome composer reads `getRecentModel({ orgId, workspaceId })` once on mount; if it returns a value that's in the visible catalog and no effective admin default is set, it overrides the loader's default. Otherwise it stays with the loader's default.

This keeps the SSR'd render correct (no flash) and only overrides if the user has prior picker history. Avoid `useSyncExternalStore` for this — a one-shot `useState` initializer is fine.

### 6.3 Star toggle write rules

In Settings → Models:
- Empty star → `setDefault(model)` (server action). After success, the row's star fills.
- Filled star → `setDefault(null)`. After success, all stars empty out.
- Only one star can ever be filled — server enforces uniqueness in the picker config record.

The star **does not write to `localStorage`** — that's strictly user-driven (per-user), while the star is admin-driven (per-org/per-workspace).

---

## 7. Logos

### 7.1 Files to move + register

The user has downloaded the following — the coding agent should `mv` them into `public/logos/` with these target filenames, then register in `src/lib/integration-logo-registry.ts`:

| Source path                              | Target filename in `public/logos/` | Registry entry          |
|------------------------------------------|------------------------------------|-------------------------|
| `/Users/illiana/Downloads/claude-ai.svg` | `claude.svg`                       | `claude: 'single'`      |
| `/Users/illiana/Downloads/grok-dark.svg` | `grok_dark.svg`                    | `grok: 'themed'`        |
| `/Users/illiana/Downloads/grok.svg`      | `grok_light.svg`                   | (same — themed entry)   |
| `/Users/illiana/Downloads/kimi-ai.svg`   | `kimi.svg`                         | `kimi: 'single'`        |

Notes:
- The existing `anthropic_light.svg` / `anthropic_dark.svg` files are the **company** logo. The picker uses the **product** logo (Claude). Per the spec we want the Claude logo. The Anthropic files stay where they are — they're still consumed by the BYOK provider list and unrelated UI. Do not overwrite them.
- Confirm Grok needs themed (white-on-dark, black-on-light) per the downloaded file naming. Kimi and Claude are single-variant per the user.
- ChatGPT logo (`openai_light.svg` / `openai_dark.svg`) already exists — used for the `gpt-5.4` family.

Update [public/logos/README.md](public/logos/README.md) "Integration Types" table to add the three new registry entries (`claude`, `grok`, `kimi`) and fix the README's stale pointer from `src/lib/integration-icons.tsx` to the actual registry file, `src/lib/integration-logo-registry.ts`.

### 7.2 Reusing the icon component

`<IntegrationIcon type="claude" />` already does the right thing once `claude` is in the registry — light/dark detection, `<img>` rendering, fallback to a `Settings` icon if missing. The picker's per-row logo can use it directly.

If we want a slightly tighter API for "model logos" specifically, add a thin wrapper:

```tsx
// src/components/model-logo.tsx
export function ModelLogo({ model, size = 16 }: { model: LlmModel; size?: number }) {
  const entry = MODEL_CATALOG[model];
  return <IntegrationIcon type={entry.providerLogo} size={size} className="shrink-0" />;
}
```

This keeps `MODEL_CATALOG → ProviderLogoType` decoupled from the integration-logo registry's internal naming.

---

## 8. Storage Schema

### 8.1 OrgDO — picker config

OrgDO already uses an `org_info` (key, value) SQLite KV table for free-form org metadata, and a separate keyed entry for `experimental_settings` ([workers/main/src/auth.ts:2021-2056](workers/main/src/auth.ts#L2021-L2056)). Reuse the same pattern with a new key `model_picker_config`.

```ts
// New helpers in workers/main/src/auth.ts (OrgDO)

const ORG_MODEL_PICKER_CONFIG_KEY = "model_picker_config";

export interface OrgModelPickerConfig {
  models: Array<{ id: LlmModel; added_at: number }>;   // ordered by added_at DESC within provider
  default_model: LlmModel | null;
}

getModelPickerConfig(): OrgModelPickerConfig {
  const rows = this.sql.exec<{ value: string }>(
    "SELECT value FROM org_info WHERE key = ?",
    ORG_MODEL_PICKER_CONFIG_KEY,
  ).toArray();
  if (rows.length === 0) {
    return defaultOrgModelPickerConfig();   // see §8.3
  }
  try {
    return parseOrgModelPickerConfig(JSON.parse(rows[0]!.value));
  } catch {
    return defaultOrgModelPickerConfig();
  }
}

setModelPickerConfig(config: OrgModelPickerConfig): OrgModelPickerConfig {
  const next = parseOrgModelPickerConfig(config);
  this.sql.exec(
    "INSERT OR REPLACE INTO org_info (key, value) VALUES (?, ?)",
    ORG_MODEL_PICKER_CONFIG_KEY,
    JSON.stringify(next),
  );
  return next;
}
```

Validation (`parseOrgModelPickerConfig` — put in a shared lib like `src/lib/llm-provider-config.ts` or new `src/lib/model-picker-config.ts`):
- Drop unknown model IDs (so a removed catalog entry doesn't crash loaders).
- Cap `models.length` at 10 (server-side enforcement).
- Ensure `default_model`, if set, is in `models`.
- Coerce missing `added_at` to `Date.now()`.

### 8.2 WorkspaceDO — workspace override

WorkspaceDO uses a similar `Workspace` JSON blob in storage ([workers/main/src/workspace.ts:334-383](workers/main/src/workspace.ts#L334-L383)). Add a new keyed config row instead of bolting onto the `Workspace` interface — the picker config is settings, not workspace identity.

WorkspaceDO doesn't have an `org_info`-equivalent KV table today (storage is keyed differently). Two options, in order of preference:

1. **Add a small `kv` table** (or use `this.ctx.storage.kv.put/get`) keyed by `model_picker_config` storing JSON `{ use_org_defaults: boolean; models: Array<{ id, added_at }>; default_model: LlmModel | null }`. The DO storage docs (per AGENTS.md) say `this.ctx.storage.kv` is preferred for new SQLite-backed DOs. Use that.
2. Tack a JSON column onto an existing workspace settings table (rejected: adds a migration for one field).

Implementation (new methods on WorkspaceDO):

```ts
async getModelPickerConfig(): Promise<WorkspaceModelPickerConfig> {
  const raw = this.ctx.storage.kv.get("model_picker_config");
  if (!raw) {
    return { use_org_defaults: true, models: [], default_model: null };
  }
  return parseWorkspaceModelPickerConfig(raw);
}

async setModelPickerConfig(config: WorkspaceModelPickerConfig): Promise<WorkspaceModelPickerConfig> {
  const next = parseWorkspaceModelPickerConfig(config);
  this.ctx.storage.kv.put("model_picker_config", next);
  return next;
}
```

Default for new workspaces: `{ use_org_defaults: true, models: [], default_model: null }`. The flag means "ignore the workspace fields, defer to org" — no migration on existing workspaces; they implicitly inherit.

### 8.3 Effective config resolver (single helper used everywhere)

```ts
// src/lib/model-picker-config.ts
export function resolveEffectivePickerConfig(
  org: OrgModelPickerConfig,
  workspace: WorkspaceModelPickerConfig | null,
): { models: Array<{ id: LlmModel; added_at: number }>; default_model: LlmModel | null; source: "org" | "workspace" } {
  if (!workspace || workspace.use_org_defaults) {
    return { ...org, source: "org" };
  }
  return { models: workspace.models, default_model: workspace.default_model, source: "workspace" };
}
```

Used by:
- The welcome route loader to pick the right `threadModel` default.
- The picker's `options` filter (`resolveModelPickerCatalog`).
- The Settings → Models loader (to pre-populate the editor).
- `src/lib/chat-do.server.ts` and lightweight API routes to validate thread creation/model updates against the effective picker catalog.
- Worker-side thread creators (`workspace-cron.ts`, `email-ingress.ts`, Slack integration routing) to choose the admin-configured default instead of calling `getDefaultLlmModel(...)` directly.

### 8.4 First-time / migration behavior

When an org has no `model_picker_config` entry yet, `getModelPickerConfig()` returns `defaultOrgModelPickerConfig()`. That default should include the same set of user-facing models currently available on hosted/no-BYOK orgs, and pre-sets `default_model: "sonnet"` so brand-new orgs land on a sensible model without falling through to localStorage:

```ts
function defaultOrgModelPickerConfig(): OrgModelPickerConfig {
  const now = Date.now();
  const defaultOrder: LlmModel[] = [
    "opus",
    "sonnet",
    "haiku",
    "gpt-5.4",
    "gpt-5.4-mini",
    "kimi-k2.6",
    "grok-4.3",
  ];
  return {
    default_model: "sonnet",
    models: defaultOrder.map((id, index) => ({ id, added_at: now - index })),
  };
}
```

This means: **no migration script** is required. The first time an admin saves changes on Settings → Models, the row is written. Until then, the loader returns the same set of user-facing models. The staggered `added_at` values make the default sort deterministic and match the mock's provider-recency order. Note: 7 entries fit under the 10-cap with room for future releases.

**OpenAI-only BYOK fallback** — if the org has set BYOK to `openai`, `getVisibleLlmModelOptions` filters out all Claude models, so `default_model: "sonnet"` resolves to nothing visible. The resolver in §6.1 handles this: if the stored default isn't in the visible catalog, fall through to the next step (localStorage), then to the **first visible model in `providerOrder` then catalog order** (typically `gpt-5.4` for openai-only orgs). Same filter logic for any other BYOK arrangement that excludes the stored default.

---

## 9. Files Changed

### New files

| File                                                           | Purpose                                                              |
|----------------------------------------------------------------|----------------------------------------------------------------------|
| `src/components/model-picker.tsx`                              | New picker UI (DropdownMenu + HoverCard + footer link)               |
| `src/components/model-logo.tsx`                                | Thin wrapper over `IntegrationIcon` for model rows                   |
| `src/lib/model-catalog.ts`                                     | `MODEL_CATALOG` + types + cost-bucket comment + `resolveModelPickerCatalog` |
| `src/lib/model-picker-config.ts`                               | Org/Workspace config types, parsers, `resolveEffectivePickerConfig`  |
| `src/lib/recent-model.ts`                                      | `localStorage` get/set for last-picked model                         |
| `src/routes/_app.settings.organization.models.tsx`             | Settings → Models page (loader, action, component)                   |
| `public/logos/claude.svg`                                      | Moved from `~/Downloads/claude-ai.svg`                               |
| `public/logos/grok_light.svg`                                  | Moved from `~/Downloads/grok.svg`                                    |
| `public/logos/grok_dark.svg`                                   | Moved from `~/Downloads/grok-dark.svg`                               |
| `public/logos/kimi.svg`                                        | Moved from `~/Downloads/kimi-ai.svg`                                 |

### Modified files

| File                                                | Change                                                                                   |
|-----------------------------------------------------|------------------------------------------------------------------------------------------|
| `src/components/prompt-input.tsx`                   | Replace `<Select>` block (lines 587-612) with `<ModelPicker>`; accept `isOrgAdmin` prop  |
| `src/components/Chat.tsx`                           | Pass `isOrgAdmin`, recent-model scope, and the resolved catalog into `<PromptInput>`; reconcile selected model if admin settings remove it |
| `src/lib/integration-logo-registry.ts`              | Add `claude: 'single'`, `grok: 'themed'`, `kimi: 'single'`                               |
| `public/logos/README.md`                            | Add Claude, Grok, Kimi rows to the Integration Types table                               |
| `src/routes.ts`                                     | Register `settings/organization/models` route                                            |
| `src/components/settings/settings-nav.tsx`          | Add "Models" entry under Organization (`adminOnly: true`)                                |
| `src/lib/llm-provider-config.ts`                    | Update `CLAUDE_LLM_MODEL_OPTIONS` / `CODEX_LLM_MODEL_OPTIONS` labels to version-qualified names; keep harness/BYOK policy here |
| `src/lib/chat-do.server.ts`                         | Enforce effective picker catalog in `createThread` and `updateThreadModel`; expose/consume a shared default resolver for server callers |
| `src/routes/_app.chat._index.tsx`                   | Loader/action: include picker config in the resolution path; compute `threadModel`, `allowedThreadModels`, `hasEffectivePickerDefault`, recent-model scope, and validate submitted `model` |
| `src/routes/_app.chat.$id.tsx`                      | Loader/action: pass `llmProvider`, `allowedThreadModels`, `hasEffectivePickerDefault`, and recent-model scope to `Chat`; validate `updateThreadModel` against the effective visible catalog |
| `src/routes/api/workspaces.$id.chat.threads.ts`     | Validate API thread creation against the same effective picker catalog (or delegate entirely to `chatDO.createThread`) |
| `workers/main/src/workspace-cron.ts`                | Use effective workspace/org picker default for scheduled-prompt thread creation |
| `workers/main/src/email-ingress.ts`                 | Use effective workspace/org picker default for new inbound-email threads |
| `workers/main/src/routes/integrations.ts`           | Use effective workspace/org picker default for new Slack-originated threads |
| `workers/main/src/auth.ts` (OrgDO)                  | Add `getModelPickerConfig` + `setModelPickerConfig` methods (KV pattern matching `experimental_settings`) |
| `workers/main/src/workspace.ts` (WorkspaceDO)       | Add `getModelPickerConfig` + `setModelPickerConfig` methods                              |
| `src/types.ts`                                      | Export `OrgModelPickerConfig`, `WorkspaceModelPickerConfig` shared types                  |

### Files NOT changed (deliberate)

- `services/sandbox-host/internal/app/usage_pricing.go` — no Go changes; pricing is read-only for our purposes.
- `public/logos/anthropic_light.svg` / `anthropic_dark.svg` — Anthropic logo stays for company-level UIs; Claude logo is added separately.
- Admin-only thread-model lock behavior — `THREAD_MODEL_LOCK_MESSAGE` stays in admin/backdoor paths, but user-facing chat remains switchable per §3.5.

---

## 10. Implementation Order

1. **Logos first** — move the four SVGs into `public/logos/`, update `integration-logo-registry.ts`, and verify they render in dark + light mode by spot-checking with the existing `<IntegrationIcon>`.
2. **Lock cleanup** — `rg "THREAD_MODEL_LOCK_MESSAGE|modelDisabled" src/`. Confirm only the four admin-path hits and the three transient-disable hits remain (see §3.5 table). Delete anything else.
3. **Model catalog + dock** — write `src/lib/model-catalog.ts` with the full `MODEL_CATALOG` map and the §4.2 header checklist comment. Update labels in `llm-provider-config.ts` to version-qualified names. Add the cross-reference comments to `usage_pricing.go` and `llm-provider-config.ts`. Add the AGENTS.md "Adding a new chat model" section. `bun run typecheck`.
4. **Picker component** — build `src/components/model-picker.tsx` against a hard-coded catalog (skip config wiring). Wire into `prompt-input.tsx`. Verify hover tooltips, footer link visibility (admin vs not), selected check, transient-disabled state.
5. **Recent-model localStorage** — add scoped `src/lib/recent-model.ts`; wire into `<ModelPicker>` `onValueChange` with `{ orgId, workspaceId }`. Verify the welcome-route default override only fires when no admin default exists and localStorage has a still-visible model.
6. **OrgDO + WorkspaceDO storage** — add the `getModelPickerConfig` / `setModelPickerConfig` methods. Add the parser/validator in `src/lib/model-picker-config.ts`. Write the §11.6 + §11.7 test files alongside.
7. **Server-side catalog/default enforcement** — update `src/lib/chat-do.server.ts`, `/chat` create action, `/chat/:id` loader/action, lightweight chat API route, and direct worker thread creators so hidden models are rejected and default models come from the effective picker config. This is a blocker before relying on the UI.
8. **Settings → Models loader/action** — single-workspace flow first (no selector). Wire `useFetcher` actions: addModel, removeModel, setDefault. Write the §11.8 test file alongside. Verify toasts and revalidation. Confirm capacity badge updates live.
9. **Workspace selector** — add the pill row + `?scope=ws&workspaceId=...` URL state. Wire `setUseOrgDefaults` action. Confirm the read-only mode renders correctly when toggle is on. Confirm `CUSTOM` badges appear/disappear. Add UO1/UO2 to the test file.
10. **Welcome-route resolution** — update `_app.chat._index.tsx` loader to use `resolveEffectivePickerConfig` for the default `threadModel`. Write the §11.9 test file. Confirm the chain (picker default → localStorage → first visible) works for: org with sonnet default, org with no default, workspace with custom override, openai-only BYOK org filtering out sonnet.
11. **Existing-thread reconciliation** — update `_app.chat.$id.tsx` and `Chat.tsx` so existing threads receive `allowedThreadModels`; if the persisted model is no longer visible, reconcile to the fallback once idle or disable sending when no models remain.
12. **Component tests** — write the §11.10 (`<ModelPicker>`) and §11.11 (Settings page) tests. Plus the §11.12 regression tests.
13. **Cross-language coverage tests** — §11.13 (logo files exist) and §11.14 (Go pricing covers every LlmModel).
14. **Manual smoke** — start the dev server. Visit `/chat`, open the picker, hover rows, click "Manage models". As an admin, add/remove models, set/unset default, switch to a workspace, toggle override on/off. Verify the picker on `/chat` reflects the changes after revalidation. Switch to a non-admin user and confirm the "Manage models" link is hidden. Switch model on an existing thread to confirm RG1/RG2 work end-to-end.
15. **`bun run test:all` + `bun run typecheck` + `bun run lint`**. All of §11 must pass. No Playwright e2e is in scope.

---

## 11. Test Plan

This feature touches the catalog, two Durable Objects, multiple loaders/actions, the welcome-route default chain, and the picker UI. The test suite below exists for two reasons: (1) prove the feature works on initial ship, and (2) prevent silent regressions when someone edits any of the catalog/pricing/picker/storage files later. Every assertion below should be a real test the coding agent writes — not a manual checklist.

### 11.1 Catalog + metadata unit tests

**File:** `src/lib/model-catalog.test.ts` (new)

| # | Assertion |
|---|---|
| C1 | Every `LlmModel` union member has a `MODEL_CATALOG` entry — iterate the union via a type-level check (export an `ALL_LLM_MODELS: readonly LlmModel[]` array and assert `MODEL_CATALOG[m]` is defined for each `m`) |
| C2 | Every entry's `providerLogo` is a key registered in `logoRegistry` ([src/lib/integration-logo-registry.ts](src/lib/integration-logo-registry.ts)) — i.e. logos won't 404 in the picker |
| C3 | `providerOrder` is in `[0, 1, 2]` for every entry |
| C4 | `cost` is one of `"$" | "$$" | "$$$"`; `intelligence` is one of `"low" | "medium" | "high"`; `speed` is one of `"slow" | "balanced" | "fast"` (catches accidental string typos) |
| C5 | `label` is non-empty and not equal to the bare provider name (catches reverting to "Sonnet" without a version) |
| C6 | All Anthropic-family entries (`opus`, `sonnet`, `haiku`) have `providerLogo: "claude"` (not `"anthropic"`) |

### 11.2 Picker config parser/validator tests

**File:** `src/lib/model-picker-config.test.ts` (new)

`parseOrgModelPickerConfig`:

| # | Input | Expected |
|---|---|---|
| P1 | `null` / `undefined` / `{}` | Returns `defaultOrgModelPickerConfig()` (sonnet default + 7 models) |
| P2 | Valid config | Round-trips losslessly through `JSON.stringify → JSON.parse → parse` |
| P3 | `models` containing an unknown ID like `"gpt-3.5"` | Drops it from the result; logs nothing (silent filter) |
| P4 | `models.length === 11` | Truncates to first 10 |
| P5 | `default_model` set to a model not in `models` | `default_model` becomes `null` |
| P6 | `models[i].added_at` missing | Coerced to `Date.now()` (assert it's a finite number close to now) |
| P7 | Empty `models` array | Returns `{ models: [], default_model: null }` (admin's right to nuke the picker) |
| P8 | Malformed JSON string passed in | Returns `defaultOrgModelPickerConfig()` (no throw) |

`parseWorkspaceModelPickerConfig`:

| # | Input | Expected |
|---|---|---|
| P9  | `null` | `{ use_org_defaults: true, models: [], default_model: null }` |
| P10 | `{ use_org_defaults: false }` (no models field) | `models: []`, `default_model: null` |
| P11 | `{ use_org_defaults: true, models: [...] }` | Stored models preserved (so toggling override back-on doesn't lose prior config) |

### 11.3 Effective config resolver tests

**File:** `src/lib/model-picker-config.test.ts` (same file as above)

| # | Org config | Workspace config | Expected source | Expected models/default |
|---|---|---|---|---|
| R1 | sonnet default + 7 models | `null` | `org` | Org config |
| R2 | sonnet default + 7 models | `{ use_org_defaults: true, ... }` | `org` | Org config (workspace fields ignored) |
| R3 | sonnet default + 7 models | `{ use_org_defaults: false, models: [opus], default_model: opus }` | `workspace` | Workspace config |
| R4 | sonnet default + 7 models | `{ use_org_defaults: false, models: [], default_model: null }` | `workspace` | Empty workspace config (admin nuked it) |

### 11.4 Recent-model localStorage tests

**File:** `src/lib/recent-model.test.ts` (new — use `vitest` with `happy-dom` or `jsdom` for `window.localStorage`)

| # | Assertion |
|---|---|
| L1 | `getRecentModel(scope)` returns `null` when storage is empty |
| L2 | `getRecentModel(scope)` returns `null` when the stored value isn't a known LlmModel (e.g. someone wrote `"foo"`) |
| L3 | `setRecentModel(scope, "opus")` then `getRecentModel(scope)` returns `"opus"` |
| L4 | Recent model values are scoped: setting `{orgA, ws1}` does not affect `{orgA, ws2}` or `{orgB, ws1}` |
| L5 | `getRecentModel(scope)` returns `null` when `window` is undefined (SSR safety — set `globalThis.window = undefined` for the test) |
| L6 | `setRecentModel(scope, "opus")` is a no-op when `window` is undefined (no throw) |

### 11.5 Default-model resolution chain tests

**File:** `src/lib/llm-provider-config.test.ts` (extend the existing file or create one)

For a helper like `resolveDefaultModelForChat(pickerConfig, recent, visibleModels)`:

| # | Picker default | localStorage recent | Visible catalog | Expected |
|---|---|---|---|---|
| D1 | `sonnet` | `null` | `[opus, sonnet, haiku, gpt-5.4]` | `sonnet` (step 1 hit) |
| D2 | `sonnet` | `opus` | `[opus, sonnet, haiku, gpt-5.4]` | `sonnet` (step 1 still wins; recent only fires when default is null) |
| D3 | `null` | `opus` | `[opus, sonnet, haiku, gpt-5.4]` | `opus` (step 2) |
| D4 | `null` | `null` | `[opus, sonnet, haiku, gpt-5.4]` | `opus` (step 3 — first visible after `providerOrder ASC, added_at DESC`; default seeded timestamps make Opus the newest Anthropic entry) |
| D5 | `sonnet` | `null` | `[gpt-5.4, gpt-5.4-mini]` (openai-only BYOK) | `gpt-5.4` (step 1 filters out, step 3 picks first visible) |
| D6 | `null` | `sonnet` | `[gpt-5.4]` | `gpt-5.4` (steps 1 & 2 filter out, step 3) |
| D7 | `null` | `null` | `[]` | `null` — defensive surface |
| D8 | `null` | `opus` | `[gpt-5.4]` | `gpt-5.4` — recent value is ignored if admin/BYOK filters it out |
| D9 | `sonnet` | `opus` | `[opus, sonnet]` | `sonnet` — an explicit admin default always wins over localStorage |

### 11.6 OrgDO storage tests

**File:** `workers/main/tests/org-model-picker-config.test.ts` (new)

| # | Assertion |
|---|---|
| O1 | Fresh OrgDO: `getModelPickerConfig()` returns `defaultOrgModelPickerConfig()` (sonnet default + 7 models) without writing |
| O2 | `setModelPickerConfig({ models: [opus], default_model: opus })` then `getModelPickerConfig()` round-trips |
| O3 | `setModelPickerConfig` rejects (or normalizes — pick one and document) configs with `models.length > 10` — assert the stored config has at most 10 |
| O4 | `setModelPickerConfig({ models: [opus], default_model: sonnet })` ⇒ stored `default_model` is `null` (default is filtered out because not in models) |
| O5 | `setModelPickerConfig` with an unknown model ID drops it and stores the rest |
| O6 | Calling `setModelPickerConfig` twice writes only one row in `org_info` (key='model_picker_config') — assert `SELECT count(*) = 1` |
| O7 | The default config does NOT write a row on first read (lazy materialization — reads are pure) |
| O8 | After `setModelPickerConfig`, reading via `getInfo()` (the legacy method) is unaffected — config lives in a separate KV row |

### 11.7 WorkspaceDO storage tests

**File:** `workers/main/tests/workspace-model-picker-config.test.ts` (new)

| # | Assertion |
|---|---|
| W1 | Fresh WorkspaceDO: `getModelPickerConfig()` returns `{ use_org_defaults: true, models: [], default_model: null }` |
| W2 | `setModelPickerConfig({ use_org_defaults: false, models: [opus], default_model: opus })` round-trips |
| W3 | `setModelPickerConfig({ use_org_defaults: true, ... })` followed by `setModelPickerConfig({ use_org_defaults: false, ... })` preserves the previously-stored models (admin can toggle without losing work) |
| W4 | Workspace override capacity cap (10) — same as O3 |
| W5 | `setModelPickerConfig` does not modify the workspace's `Workspace` JSON blob (`getInfo()` unchanged) |
| W6 | Default config does not write a row (lazy) — same as O7 |

### 11.8 Settings → Models route action tests (worker test surface)

**File:** `workers/main/tests/settings-organization-models-route.test.ts` (new)

These exercise the loader + action through `runRequest(...)` style helpers (mirror existing test patterns in `workers/main/tests/`).

**Loader:**

| # | Setup | URL | Expected loader output |
|---|---|---|---|
| S1 | Org admin user | `/settings/organization/models` | `scope=org`, `selectedWorkspaceId=null`, workspaces list populated, `useOrgDefaults` ignored, config = org default |
| S2 | Org admin user | `/settings/organization/models?scope=ws&workspaceId=W1` | `scope=ws`, `selectedWorkspaceId=W1`, `useOrgDefaults` reflects W1's config |
| S3 | Non-admin user | `/settings/organization/models` | Redirects to `/` via `requireOrgAdmin` (unit tests may observe a thrown redirect `Response`) |
| S4 | Org with 1 workspace | `/settings/organization/models` | `workspaces.length === 1` so client knows to hide the selector |
| S5 | Workspace with custom override | scope=ws | Loader returns `useOrgDefaults: false` and the workspace's models |

**Action — `addModel`:**

| # | Setup | Form data | Expected |
|---|---|---|---|
| A1 | Org config has 7 models | Remove `opus`, then `{intent: addModel, model: opus}` | OrgDO storage gains the row with a fresh `added_at`; toast intent set |
| A2 | Org config has 10 models | `{intent: addModel, model: anything}` | 400 with `{ error: "Picker capacity reached" }`; OrgDO unchanged |
| A3 | Unknown model ID | `{intent: addModel, model: gpt-99}` | 400 with validation error; OrgDO unchanged |
| A4 | Workspace scope | scope=ws + `{intent: addModel, model: opus}` | WorkspaceDO storage updated, OrgDO unchanged |
| A5 | Non-admin | any | Redirects to `/` via `requireOrgAdmin`; storage unchanged |
| A6 | Adding a model already in `models` | `{intent: addModel, model: sonnet}` (already present) | No-op or idempotent — pick one and assert; storage length unchanged |

**Action — `removeModel`:**

| # | Setup | Form data | Expected |
|---|---|---|---|
| RM1 | Org has `default_model: sonnet`, sonnet in models | `{intent: removeModel, model: sonnet}` | sonnet removed; `default_model` cleared to `null` |
| RM2 | Org has `default_model: sonnet`, removing opus | `{intent: removeModel, model: opus}` | opus removed; `default_model` still `sonnet` |
| RM3 | Removing a model not in `models` | `{intent: removeModel, model: gpt-99}` | 400 or no-op (pick one); storage unchanged |
| RM4 | Workspace scope, custom override | scope=ws + `{intent: removeModel, model: opus}` | WorkspaceDO updated, OrgDO unchanged |
| RM5 | Non-admin | any | Redirects to `/` via `requireOrgAdmin`; storage unchanged |

**Action — `setDefault`:**

| # | Setup | Form data | Expected |
|---|---|---|---|
| SD1 | Set valid default | `{intent: setDefault, model: opus}` (opus in models) | `default_model: opus` |
| SD2 | Set default to model not in `models` | `{intent: setDefault, model: gpt-99}` | 400; `default_model` unchanged |
| SD3 | Clear default | `{intent: setDefault, model: ""}` (or omitted) | `default_model: null` |
| SD4 | Setting a new default replaces the old (only one star) | Set sonnet, then opus | `default_model: opus` after second call |

**Action — `setUseOrgDefaults`:**

| # | Setup | Form data | Expected |
|---|---|---|---|
| UO1 | Workspace has custom override | scope=ws + `{intent: setUseOrgDefaults, useOrgDefaults: true}` | Workspace flag flipped; loader now returns org config |
| UO2 | Toggling back off restores previous workspace models (per W3) | scope=ws + `{intent: setUseOrgDefaults, useOrgDefaults: false}` after UO1 | Workspace's previously-stored `models` returned, not empty |
| UO3 | Org scope rejects this intent | scope=org + `{intent: setUseOrgDefaults, useOrgDefaults: false}` | 400 — invalid intent for org scope |

### 11.9 Welcome route loader integration tests

**File:** `workers/main/tests/welcome-route-default-model.test.ts` or extend existing welcome-route tests if they live in `src/routes/`.

| # | Setup | Expected `threadModel` returned |
|---|---|---|
| WR1 | Default org, no BYOK | `sonnet` (org default) |
| WR2 | Org with `default_model: opus` | `opus` |
| WR3 | Org with default `sonnet`, BYOK = `openai` | `gpt-5.4` (sonnet filtered out, falls to step 3) |
| WR4 | Org with default `sonnet`, workspace with custom override `default_model: kimi-k2.6` | `kimi-k2.6` |
| WR5 | Org with default `sonnet`, workspace with override flag on, no override default | `sonnet` (org wins via inheritance) |
| WR6 | Empty picker (admin nuked it) | `null` (welcome screen surfaces the disabled-composer state) |
| WR7 | The loader's `allowedThreadModels` reflects the picker config × BYOK intersection (used by Chat.tsx to build the dropdown) — for openai BYOK + default catalog, expect `[gpt-5.4, gpt-5.4-mini]` |
| WR8 | Create-thread POST submits a valid BYOK model that is hidden by picker config | 400 `{ error: "Invalid thread model" }`; no thread created |
| WR9 | Direct `chatDO.createThread(..., model)` is called with a hidden model | Throws `Invalid thread model`; this protects lightweight API callers too |

### 11.10 ModelPicker component tests

**File:** `src/components/model-picker.test.tsx` (new — use `@testing-library/react` + `vitest`)

| # | Assertion |
|---|---|
| MP1 | Renders one row per `options` entry |
| MP2 | The row matching `value` shows the check icon; others don't |
| MP3 | Clicking a row calls `onValueChange` with that row's id |
| MP4 | Clicking a row also calls `setRecentModel(scope, id)` when `recentModelScope` is provided (mock the localStorage helper and assert it was called with org/workspace ids) |
| MP5 | "Manage models" footer link is rendered when `isOrgAdmin === true` |
| MP6 | "Manage models" footer link is NOT rendered when `isOrgAdmin === false` (assert `queryByText("Manage models") === null`) |
| MP7 | `disabled={true}` makes the trigger unfocusable / aria-disabled, and clicking the trigger does not open the menu |
| MP8 | Hovering a row triggers the HoverCard with the right metadata (cost/intelligence/speed for that model) — use `hover()` from testing-library |
| MP9 | The provider logo is rendered with the correct `type` attribute (use a test ID or query the `<img alt>`) |
| MP10 | Rows render in the order passed by the caller; sorting belongs in `resolveModelPickerCatalog`, not in the component |

### 11.11 Settings → Models page component tests

**File:** `src/routes/_app.settings.organization.models.test.tsx` (new)

Use the route's loader/action contract — mock the loader return.

| # | Assertion |
|---|---|
| MS1 | `In your picker` section renders rows for every model in `inPicker` |
| MS2 | `Additional models` section renders rows for every model in `additional` |
| MS3 | The 4-of-10 capacity badge renders correctly; at 10/10 the Add buttons are disabled and tooltip text is present |
| MS4 | Star + Remove are right-aligned (assert via class names: parent has `flex items-center`, controls in a `ml-auto` group — class assertion is fragile but worth one snapshot) |
| MS5 | A `<Separator>` element exists between the two sections — `screen.getByRole("separator")` |
| MS6 | No outer Card wrapper around either section — assert the section header `<h*>` has no parent with `role="region"` from a Card |
| MS7 | Workspace selector is hidden when `workspaces.length === 1`; visible when `> 1` |
| MS8 | Selecting a workspace pill updates `?scope=ws&workspaceId=...` in the URL |
| MS9 | When `useOrgDefaults: true`, both sections render with disabled controls (no buttons clickable) and an inline note "Inheriting from org defaults — turn off the toggle to customize" |
| MS10 | Toggling the override checkbox submits `setUseOrgDefaults` with the right value |
| MS11 | Workspaces with `hasCustomConfig: true` show the `CUSTOM` badge on their pill |
| MS12 | Star toggle: clicking an empty star submits `setDefault(model)`; clicking a filled star submits `setDefault(null)` |
| MS13 | Add button submits `addModel(model)` and Remove button submits `removeModel(model)` |
| MS14 | Empty picker state (`inPicker.length === 0`) shows the empty-state copy and does not crash |

### 11.12 Regression tests for thread switchability + lock removal

**File:** extend or add to `workers/main/tests/admin-api-thread-update.test.ts` and any existing tests for `_app.chat.$id.tsx`'s `updateThreadModel` action.

| # | Assertion |
|---|---|
| RG1 | User-facing `updateThreadModel` action allows switching from `sonnet` → `opus` mid-thread (no `THREAD_MODEL_LOCK_MESSAGE` returned). This is a regression guard against re-introducing the lock. |
| RG2 | User-facing path allows switching across providers (e.g. `sonnet` → `gpt-5.4`) on an active thread (no harness error) |
| RG3 | Admin API still blocks model edits on existing threads (`THREAD_MODEL_LOCK_MESSAGE` returned) — confirm we didn't accidentally also remove it from admin |
| RG4 | A grep-style test or lint rule: no file under `src/components/` or `src/routes/_app.*` imports `THREAD_MODEL_LOCK_MESSAGE` (admin paths under `_admin.*` are allowed). Cheapest implementation: a vitest test that uses `fs.readFileSync` to scan the disallowed dirs. |
| RG5 | User-facing `updateThreadModel` rejects a model that passes `isLlmModelAllowedForNewThread` but is hidden by the effective picker config |
| RG6 | Existing-thread loader returns `allowedThreadModels`; when the persisted thread model is no longer visible, the client reconciliation picks the fallback and submits one model update while idle |

### 11.13 Logo registry + file existence

**File:** `src/lib/integration-logo-registry.test.ts` (extend or create)

| # | Assertion |
|---|---|
| LG1 | `claude`, `grok`, `kimi` are present in `logoRegistry` with the expected variants (`single`, `themed`, `single`) |
| LG2 | For each registered key, the corresponding file(s) exist under `public/logos/` (`fs.existsSync` on `public/logos/{key}.svg` or `_light/_dark` pair). This catches "registered but file missing" — a real failure mode |
| LG3 | `MODEL_CATALOG`'s `providerLogo` values are a subset of `logoRegistry` keys (already covered by C2 but worth keeping close to logos) |

### 11.14 Pricing-coverage cross-language test

**File:** `src/lib/model-pricing-coverage.test.ts` (new)

This test reads the Go file at `services/sandbox-host/internal/app/usage_pricing.go` as text and asserts every `LlmModel` ID appears as a key in the `modelPricingTable` map. Catches the failure mode: someone adds a model to the TS catalog but forgets to add Go pricing, so usage events fall back to the Sonnet default and we silently mis-bill.

Implementation sketch:

```ts
const goSrc = fs.readFileSync(path.join(__dirname, "../../services/sandbox-host/internal/app/usage_pricing.go"), "utf8");
for (const model of ALL_LLM_MODELS) {
  // pricing keys can be exact (`"opus": 0,` is unlikely; in Go the TS id like "gpt-5.4" appears verbatim as a map key)
  expect(goSrc).toMatch(new RegExp(`"${escapeRegex(model)}"\\s*:\\s*{`));
}
```

(For `opus` / `sonnet` / `haiku` — the TS IDs differ from the Go pricing keys (`claude-opus-4-6` etc.) — make a small `LLM_MODEL_TO_PRICING_KEY` map in `model-catalog.ts` and assert that mapping resolves to a real Go key.)

### 11.15 Test execution

| Command | Coverage |
|---|---|
| `bun run test:run`    | §11.1, §11.2, §11.3, §11.4, §11.5, §11.10, §11.11, §11.13, §11.14 |
| `bun run test:workers` | §11.6, §11.7, §11.8, §11.9, §11.12 |
| `bun run typecheck`    | LlmModel union completeness across new files |
| `bun run lint`         | Catalog file comment block, etc. |

CI must run all of `bun run test:all` (defined in CLAUDE.md as `Unit + worker tests`) plus `bun run test:sandbox-host` if Go pricing is touched. No e2e suite added — Playwright is overkill for this surface.

### 11.16 Coverage summary

| Subsystem                              | Where covered                                       |
|----------------------------------------|------------------------------------------------------|
| `MODEL_CATALOG` shape + completeness   | §11.1                                                |
| Picker config validation               | §11.2                                                |
| Org/Workspace inheritance              | §11.3, §11.6, §11.7, §11.8 (UO1, UO2)                |
| `localStorage` recent-model            | §11.4, §11.10 (MP4)                                  |
| Default-model resolution chain         | §11.5, §11.9                                         |
| OrgDO storage                          | §11.6                                                |
| WorkspaceDO storage                    | §11.7                                                |
| Settings page loader/action            | §11.8                                                |
| Welcome route default + create validation | §11.9                                             |
| Picker UI behavior                     | §11.10                                               |
| Settings UI behavior                   | §11.11                                               |
| Thread-switch regression + hidden-model rejection | §11.12                                  |
| Logo file existence                    | §11.13                                               |
| Cross-language pricing coverage        | §11.14                                               |

If any of these tests is left unimplemented, the corresponding subsystem can regress silently — the user has explicitly asked for a hefty suite specifically to prevent that.

---

## 12. Out of Scope (per spec + my judgment)

- "NEW" tag for newly released models — explicit non-goal in the prompt.
- Reordering models in the picker (drag handles, custom order) — explicit non-goal in the prompt.
- Per-user picker overrides (only org and workspace levels are configurable; users get the picker their admin gives them).
- Adding `gemini-3-flash-preview` to the picker — it's used internally for virtual AI / auto-titling, not a user-facing chat model.
- Migrating Go pricing to TypeScript — out of scope; cost buckets are derived once and hard-coded in `MODEL_CATALOG`.
- Changing BYOK provider policy — `getVisibleLlmModelOptions` remains the harness/provider source of truth, but this feature must call it from the new picker-config resolvers and server validations.
- Unifying the Anthropic vs Claude logo distinction across the rest of the app — this plan adds the Claude logo only for the picker.
- Removing `THREAD_MODEL_LOCK_MESSAGE` from admin paths — those paths intentionally still block model edits on existing threads via the admin backdoor.

---

## 13. Resolved Decisions (record of choices baked into the plan)

For the next iteration of the plan or a future refresh:

| Decision | Choice |
|---|---|
| Intelligence + speed values per model | User-set; baked into §4 `MODEL_CATALOG` (Opus high/slow, Sonnet medium/balanced, Haiku low/fast, GPT-5.4 high/balanced, GPT-5.4 Mini low/fast, Kimi K2.6 medium/balanced, Grok 4.3 medium/fast) |
| "Manage models" visibility for non-admins | Hide the link entirely |
| Workspace-level admin scope | Org admins only — same as AI Provider |
| Default model for fresh orgs | `default_model: "sonnet"` with first-visible-model fallback when BYOK filters Claude out (§6.1, §8.4) |
| Recent-model storage | Scoped by org + workspace in `localStorage`, and only written after an explicit picker row selection |
| Model removal mid-thread | Picker reflects the new effective catalog; if the user's current selection was removed, `Chat` reconciles to the fallback and persists it once idle. If no visible model remains, sending is disabled. Threads continue any already-running send to completion. |
| Thread model lock for normal users | Removed from user-facing path (already done in code); admin paths keep `THREAD_MODEL_LOCK_MESSAGE` (§3.5) |
