# Pi System Prompt — Proposed Edits (git-diff style)

A concrete, minimal-but-high-leverage proposal for updating the Pi system
prompt. Diffs are against the source of truth,
[pi-system-prompt.ts](../workers/main/src/pi-system-prompt.ts) (the `.md` is
generated from it).

## Implementation status (shipped)

Implemented per the agreed scope:

- **Edits 1–4 — shipped** in [pi-system-prompt.ts](../workers/main/src/pi-system-prompt.ts);
  `docs/pi-system-prompt.md` regenerated from source.
- **Edit 5 (set_preview) — reverted/not done.** Per review: less capable models
  already struggle with preview targeting, so the example call-shapes stay in the
  prompt until there's evidence the tool description alone suffices. Trimming
  other duplicated runtime syntax (connections, hosted AI) remains a possible
  later pass.
- **Both correctness fixes — shipped now, not deferred:**
  - [file-safety.ts](../workers/main/src/file-safety.ts): the dangling
    "(see your system prompt)" reference is gone. Git history confirmed a
    prohibited-activities section *never* existed in any real prompt source, so
    the line was made self-contained (it now names the prohibited activities
    already listed in the same message) rather than "restored."
  - [Chat.tsx](../src/components/Chat.tsx): the "search for it in the home folder"
    fallback now says to use `list_projects` and the `/workspace` VM checkout,
    matching the legacy-`/home/claude` guidance.
- Verified: `bun run typecheck` clean; `chat-thread-codex-external-turn` (145)
  and `file-safety` (19) worker tests pass.

The original proposal text below is kept for the rationale.

## Starting point: what the Codex audit actually found

The headline from [the codex audit](pi-system-prompt-codex-audit-2026-06-08.md)
is worth stating plainly because it reframes the work:

> "The Pi prompt is **mechanically accurate** for the current tool stack… The
> largest issues are not basic factual drift."

Nearly every line is marked **Current** (accurate). So this is **not** an
error-hunt — it's a *sharpen and unify* pass. The goal, per the directive
driving this work, is to **maximize the model's performance** by (a) making the
highest-impact information salient, (b) using one consistent name for each
concept, and (c) generalizing the few statements that are accurate-but-too-narrow
or high-drift. The big speculative "safety section" is **deferred** — it's real,
but it is not the highest-leverage lever for model performance right now.

I independently verified the load-bearing facts before proposing changes — see
[Verification](#verification) at the bottom.

## Canonical terminology decisions

The prompt currently uses several names for two core concepts. Confirmed against
code, the canonical choices are:

| Concept | Use everywhere | Stop using |
| --- | --- | --- |
| The DO-backed workspace filesystem (`WorkspaceFilesystemDO`) | **durable workspace filesystem** (files: "durable workspace files") | "Durable Object filesystem", "outer durable workspace" |
| The per-project compute checkout (`project-runtime-service`) | **project VM** | "Go project runtime service", "project runtime service", "runtime host" |

The "Go … service" phrasing leaks an internal implementation detail the agent
never needs and that will drift if the service is ever rewritten. "project VM"
matches the tool surface the agent actually uses (`location: "vm"`, `project`).

---

## The edits

Ordered by leverage. Edits 1–3 are the core ask (mission + accuracy +
terminology). Edit 4 is high-value and cheap. Edit 5 is an optional follow-up.

### Edit 1 — Add a mission sentence (HIGH; explicitly requested)

The opening line only names the agent. One sentence of mission gives the model a
north star and makes behavior consistent across the Claude / Codex / OpenRouter
routes this platform serves.

```diff
- You are camelAI, an AI coding agent running inside the user's camelAI workspace.
+ You are camelAI, an AI coding agent running inside the user's camelAI workspace.
+ You help users build, ship, analyze, and operate apps in their workspace. Act on
+ clear requests; ask a brief clarifying question only when an assumption could
+ waste significant work or cause an irreversible or external side effect.
```

The second sentence is optional but cheap, and it closes the audit's "autonomy
and clarification" gap without a whole behavior section. If you want the
absolute minimum, ship only the mission sentence.

### Edit 2 — Unify terminology (HIGH; requested)

Two one-word-ish swaps, no meaning change, pure consistency.

```diff
- Workspace files live in a Durable Object filesystem. Do not assume local Worker
- filesystem access. The top-level file tools (`read`, `write`, `edit`, `ls`)
- default to these durable workspace files.
+ Workspace files live in the durable workspace filesystem (a Durable Object); they
+ are not on a local Worker disk. The top-level file tools (`read`, `write`,
+ `edit`, `ls`) default to these durable workspace files.
```

```diff
- The active checkout in the Go project runtime service is `/workspace`; do not
- create or use `/home/claude`, which is a legacy path and may not be writable in
- the current runtime image.
+ Each project VM is checked out at `/workspace`; do not use `/home/claude`, a
+ legacy path that may not be writable.
```

> Note on `/home/claude`: confirmed still a real legacy alias
> (`WORKSPACE_ROOT_ALIASES` in
> [workspace-filesystem-do.ts](../workers/main/src/workspace-filesystem-do.ts)),
> so the warning is accurate. The audit flags it as "high-drift — keep only if
> incidents still show agents using it." If you have no recent incidents of
> agents touching `/home/claude`, **delete the clause entirely** rather than
> carry a permanent scar in every turn. Left in above, shortened.

### Edit 3 — Generalize the output-link rule (MEDIUM accuracy)

The current rule forbids one specific host. That's accurate but too narrow — it
silently fails to cover staging, local dev, and custom domains, and a model can
read "don't use camelai.com" as "any other absolute host is fine." State the
positive invariant instead.

```diff
- When linking to files in `/mnt/user-outputs/<path>`, use a relative URL of
- `/api/workspaces/{{WORKSPACE_ID}}/outputs/<path>`; uploaded files use
- `/api/workspaces/{{WORKSPACE_ID}}/uploads/<path>`. Do not use `camelai.com` or
- legacy `/files/output/...` URLs for workspace file links.
+ Link to workspace files with relative URLs only — never an absolute host.
+ Outputs in `/mnt/user-outputs/<path>` link as
+ `/api/workspaces/{{WORKSPACE_ID}}/outputs/<path>`; uploads as
+ `/api/workspaces/{{WORKSPACE_ID}}/uploads/<path>`. Do not use legacy
+ `/files/output/...` URLs.
```

### Edit 4 — Give each skill a one-line trigger (HIGH; cheap)

Today the prompt lists skill *paths* with no "when," so the model must open each
`SKILL.md` to learn if it's relevant, or skip them. The audit calls this "the
biggest skill-discovery gap." Add a trigger phrase per skill, sourced verbatim-
ish from each skill's own `description:` frontmatter (so it can't drift from the
skill's stated purpose).

Implementation: replace the bare `skillLines` map in `createPiSystemPrompt()`
with a `name → trigger` table. Proposed copy (each ≤ ~1 line):

```diff
  ## Available Skills
- When a task matches a skill, read that skill file with the read tool and follow it.
- Built-in skills are available at:
- - communication-channels: /opt/chiridion-host-pi/skills/communication-channels/SKILL.md
- - custom-domain-troubleshooting: /opt/chiridion-host-pi/skills/custom-domain-troubleshooting/SKILL.md
- - data-analysis: /opt/chiridion-host-pi/skills/data-analysis/SKILL.md
- - deterministic-automations: /opt/chiridion-host-pi/skills/deterministic-automations/SKILL.md
- - developing-software: /opt/chiridion-host-pi/skills/developing-software/SKILL.md
- - file-sharing: /opt/chiridion-host-pi/skills/file-sharing/SKILL.md
- - testing-debugging: /opt/chiridion-host-pi/skills/testing-debugging/SKILL.md
+ When a task matches a skill, read that skill file with the read tool and follow it.
+ Built-in skills (path: /opt/chiridion-host-pi/skills/<name>/SKILL.md):
+ - communication-channels — send email, Slack, or Telegram from js_exec; use when asked to send or reply on an external channel.
+ - custom-domain-troubleshooting — diagnose custom-domain SSL/DNS/522/activation issues; use when an app won't load on its custom domain.
+ - data-analysis — Python + SQL over CSV/Excel/Parquet/PDF/Office files and databases, plus charts; use for any data analysis.
+ - deterministic-automations — durable scheduled workflows (Cloudflare Dynamic Workflows); use when the user wants code that runs on a schedule without a model turn.
+ - developing-software — deploy APIs, web, fullstack, or AI apps to Cloudflare Workers; use when asked to build or deploy an app.
+ - file-sharing — read uploaded files and produce downloadable/previewable files in chat.
+ - testing-debugging — debug deployed apps and write tests; use when the user reports a bug or wants tests.
```

(Triggers above are condensed from the live `description:` fields in
`sandbox/skills/*/SKILL.md`. To keep them from drifting, prefer parsing
`description:` at build time over hand-maintaining a second copy — see audit
"Concrete Next Edits" #3.)

### Edit 5 — Trim duplicated call-syntax (OPTIONAL follow-up)

The audit's #5: `set_preview`'s full three-form signature matrix, the three
equivalent `env.CONNECTIONS[...]` access paths, and the hosted-AI method
signatures are **already present** in the `js_exec` help and the tool
descriptions. Carrying them in the always-on prompt costs tokens every turn and
is a second copy that can drift out of sync. Keep the *canonical rule*, move the
*syntax* down a level. Example for `set_preview`:

```diff
- When you create or edit a user-visible file or app, call the `set_preview` tool
- with exactly one real preview target so the user can inspect it in the preview
- pane. Use `set_preview({ app_name: "poll-maker" })` for deployed apps,
- `set_preview({ path: "/notes.md" })` for durable workspace files, and
- `set_preview({ location: "vm", project: "menu-app", path: "index.html" })` for
- files in a project VM. Do not call `set_preview` with only `project` or
- `location`; VM file previews require `path`, `project`, and `location: "vm"`. Do
- not call `set_preview` to clear the preview.
+ After producing user-visible output (a file or deployed app), call `set_preview`
+ with exactly one real target so the user can inspect it. See the tool
+ description for the per-target argument shapes.
```

I've marked this **optional** because it's the only edit that depends on a claim
about *other* surfaces (that the tool descriptions fully carry the syntax). The
audit asserts they do; confirm the `set_preview` / connections / `env.AI` tool
descriptions are complete before pulling syntax out of the prompt, so you don't
trade duplication for a gap. Same pattern applies to the connections paragraph
(line 34) and the hosted-AI paragraph (line 35).

---

## Deferred / out of scope

- **Dedicated safety + prompt-injection section.** Real (the audit's #1 and #3),
  but deliberately deferred per the current directive: it's not the top
  performance lever. Revisit as its own change.
- **Instruction-precedence block, verification/testing rule, destructive-action
  policy.** Worthwhile (audit "Missing Standing Instructions") but broader than
  this minimal pass.
- **Subagent base-prompt slimming** (explore subagents inherit write/preview
  guidance they can't use). Token win, but a structural change; separate pass.

## Two small correctness items worth a separate tiny fix

Not part of the system prompt text, but they directly contradict it and the
directive is "remove incorrect information the model is given," so flagging:

1. **Dangling reference.**
   [file-safety.ts](../workers/main/src/file-safety.ts) tells the agent to refuse
   prohibited activity "(see your system prompt)", but the prompt has **no**
   prohibited-activities section. Either add one line or drop the parenthetical so
   the model isn't pointed at content that doesn't exist.
2. **Contradictory fallback.** The app "work on this app" fallback in
   [Chat.tsx](../src/components/Chat.tsx) says to "search for it in the home
   folder" — i.e. `/home/claude`, which the prompt (correctly) calls legacy.
   Replace with project-discovery guidance (`list_projects`) or drop the fallback.

---

## Verification

Confirmed directly in code before proposing (so the diffs don't introduce new
inaccuracy):

- `WorkspaceFilesystemDO` is the DO-backed filesystem class; `/workspace` is the
  VM checkout (`PROJECT_VM_CHECKOUT_PATH`); `/home/claude` is a live legacy alias
  (`WORKSPACE_ROOT_ALIASES`) — so the legacy warning is accurate, not stale.
- Output/upload routes exist:
  `src/routes/api/workspaces.$id.outputs.$.ts` and `…uploads.$.ts`.
- Hosted-AI tiers `cheap | fast | auto | smart` are the real `TierName` union in
  [ai-virtual-binding.ts](../workers/main/src/ai-virtual-binding.ts).
- Skill triggers in Edit 4 are condensed from the actual `description:`
  frontmatter in `sandbox/skills/*/SKILL.md`.

## Suggested ship order

1. Edits 1–4 together — one focused commit; no behavior wiring, low risk, covers
   the mission + accuracy + terminology + skill-discovery asks.
2. Regenerate `docs/pi-system-prompt.md` from source and eyeball the diff.
3. Edit 5 and the two correctness items as a separate follow-up once the tool
   descriptions are confirmed complete.
