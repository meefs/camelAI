# Pi System Prompt — Critique & Improvement Notes

Critique of the Pi system prompt as composed in
[pi-system-prompt.ts](../workers/main/src/pi-system-prompt.ts) and rendered in
[pi-system-prompt.md](pi-system-prompt.md). No code is changed by this doc — it
is feedback for whoever edits the prompt next.

This is a historical critique, not current agent guidance. Some examples may
describe an older tool surface; verify current behavior in the source and
generated prompt snapshot before acting on them.

## Framing: system prompt vs. skill

A skill is pulled in on demand for one task; a system prompt is paid for on
**every turn of every agent**, can't be opted out of, and sets the agent's
standing identity and defaults. That changes the rules:

- **Concision matters more, not less.** Every token here is resident in context
  for the whole session. The writing-skills principle "only include what the
  model doesn't already know" applies with extra force — and so does
  progressive disclosure: detail that only matters *sometimes* should live in a
  tool description or a skill, not in the always-on preamble.
- **It should be evergreen.** Skills are cheap to revise; a system prompt is
  load-bearing and tends to ossify. Anything that will drift (exact call
  signatures, model-tier names, legacy-path warnings) is a liability here.
- **It must do a job skills never do:** establish *who the agent is, what it's
  for, how it should behave, and what good output looks like.* The current
  prompt does almost none of this — see Finding 1.

Below, findings are ordered by impact.

---

## High impact

### 1. The prompt is 100% mechanics, 0% behavior/judgment

Every line is "how to call a tool" or "where files live." There is no statement
of:

- **What the agent is for** — help users build, ship, analyze, and operate apps
  in their workspace. The opening line ("You are camelAI, an AI coding agent")
  is the only identity content, and it's circular.
- **How it should behave** — proactiveness vs. asking first, when to ask
  clarifying questions (you have `AskUserQuestion`/`ask_user_question` per
  AGENTS.md but the prompt never mentions when to use it), how much to do
  without checking in, how to handle ambiguity.
- **What good output looks like** — tone, verbosity, when to explain vs. just
  do, formatting expectations.

This is the biggest gap. A coding agent with no behavioral north star defaults
to whatever the base model does, which is inconsistent across providers (this
platform routes Claude *and* Codex/OpenAI/OpenRouter — see
[model-catalog.ts](../src/lib/model-catalog.ts) — so "the model's defaults"
vary by route). A short Identity + Behavior section near the top would make Pi
behave consistently regardless of the underlying model.

**Suggested addition (top of prompt, ~5-8 lines):**
- One line on mission ("help users build, run, and operate real software and
  data work in their workspace").
- Bias toward action vs. asking: e.g. "Make a reasonable attempt; ask a
  clarifying question only when a wrong assumption would waste significant work
  or cause a destructive/external side effect."
- Default communication style (concise, work-focused — this echoes AGENTS.md's
  "keep surfaces work-focused and dense").

### 2. The Skills section gives names and paths but no "when"

```
- communication-channels: /opt/.../SKILL.md
- data-analysis: /opt/.../SKILL.md
...
```

The whole point of a skill description (per the writing-skills guide) is the
**what + when** that drives discovery. Here the agent gets neither — to decide
whether `data-analysis` is relevant it must `read` the file. With 7 skills,
the agent either opens several SKILL.md files speculatively (wasteful) or skips
them entirely (skills never fire). Both are bad.

**Fix:** include a one-line trigger description per skill, sourced from each
skill's own `description` field, e.g.:

```
- data-analysis — querying connected databases and analyzing datasets; use when
  the task involves SQL, dataframes, or summarizing data.
- communication-channels — sending email/Slack/Telegram; use when the user asks
  to send or reply on an external channel.
```

This is the single change most likely to make the skill system actually work as
designed. It costs ~7 lines and saves repeated speculative file reads.

### 3. Altitude: tool call-syntax doesn't belong in an always-on prompt

Large stretches are exact API mechanics that are resident every turn and go
stale on any rename:

- The full `set_preview` signature matrix (three call forms + "don't call with
  only project" + URL-linking rules for outputs/uploads).
- `env.CONNECTIONS.find(...)` → `env.CONNECTIONS[alias].method(...)` with three
  equivalent access paths.
- `env.AI.run` example, the four model-tier names, `generateImage`,
  `transcribeAudio` signatures.

This is reference material. It belongs in the **tool descriptions** (where the
model sees it exactly when the tool is in play) or in a skill loaded on demand —
not in the preamble of every explore subagent that will never call these.
Keep a one-line pointer in the system prompt ("use `set_preview` to surface
user-visible output; see the tool description for targets") and move the syntax
down a level. This is textbook progressive disclosure and would meaningfully
shrink the resident prompt.

---

## Medium impact

### 4. No structure — it's a wall of paragraphs

There are no section headers until `## Available Skills`. Eleven dense
paragraphs of 3-6 sentences each, no grouping, no prioritization. Models
retrieve instructions better from labeled, scannable sections. Suggested
sections (reordered by importance, not by subsystem):

1. **Identity & mission** (new — Finding 1)
2. **How you work** — behavior/proactiveness/communication defaults (new)
3. **Output & visibility** — the last-message rule (already strong, see below),
   `set_preview` pointer, file-link URLs
4. **Environment** — durable workspace FS vs. project VMs, `/workspace`, Git
5. **Connections & hosted AI** — pointers, not signatures
6. **External side effects** — the opt-in rule
7. **Repo conventions** — read AGENTS.md/CLAUDE.md
8. **Available skills** — with descriptions (Finding 2)

### 5. Negative-instruction overload

The prompt leans on "Do not…": don't assume local FS, don't create
`/home/claude`, don't call `set_preview` to clear, don't use `camelai.com`,
don't commit build artifacts, don't fall back to no-reply. A pile of don'ts is
hard to retain and weaker than stating the positive canonical path. Prefer
"Workspace files live in the DO filesystem; reach them with `read`/`write`/…"
over "Do not assume local Worker filesystem access." Reserve explicit "never"
for the few genuinely destructive footguns.

### 6. Inconsistent terminology for the same concepts

The writing-skills checklist calls out "consistent terminology throughout." The
prompt uses several names per concept:

- "durable workspace files" / "outer durable workspace" / "Durable Object
  filesystem" — one thing, three labels.
- "project VM" / "project runtime service" / "Go project runtime service" /
  "runtime host."

Pick one canonical term for each and use it everywhere. Inconsistent naming
makes it harder for the model to connect an instruction to the tool that
implements it.

### 7. No instruction-precedence / conflict guidance

The prompt says to read AGENTS.md/CLAUDE.md "before relying on repo
conventions" but never says what wins when sources conflict (system prompt vs.
repo file vs. explicit user request), or how to treat the hidden
channel-routing instruction relative to user text. One sentence on precedence
prevents a class of ambiguous-situation mistakes.

### 8. Subagents inherit the full base prompt regardless of need

`createPiSubagentSystemPrompt` prepends the *entire* base prompt to every
subagent, then appends mode notes. An **explore** subagent that "must not edit
files" still carries the full `set_preview`, Git-push, and external-side-effect
instructions it can't use. Consider a leaner base for subagents (especially
explore), or gate the editing/preview/side-effect blocks behind the mode. This
compounds with Finding 3 — the heaviest, most call-specific content is exactly
what subagents least need.

---

## Lower impact / polish

### 9. Primacy & recency are wasted

The two most behaviorally important lines — "the user only sees your last
message" and "external messages are opt-in" — sit in the middle, the weakest
position. The strongest positions (very top, very bottom) hold a circular
identity line and raw IDs. Move behavioral must-knows to the edges; IDs are
reference data and can sit at the end (they currently do, which is fine).

### 10. Staleness hooks with no verification pointer

Hardcoded specifics that will drift: the model-tier list (`cheap/fast/auto/
smart`), the `/home/claude` legacy warning, exact tool names. AGENTS.md's own
maintenance rule is "if a detail is likely to drift quickly, document where to
verify it instead of freezing it." The legacy-path warning in particular reads
like a scar from a past bug that may not need permanent residence in every
prompt — verify it's still load-bearing.

### 11. No security/untrusted-input posture

Pi reads uploaded files, can receive external web content through the Research
agent, and can send external messages — a classic prompt-injection surface, and
[file-safety.ts](../workers/main/src/file-safety.ts) already exists to guard
parts of it. The prompt has nothing on treating uploaded-file/web content as
untrusted data rather than instructions, or on not exfiltrating workspace
secrets/BYOK credentials. A two-line stance would be cheap insurance. (The
opt-in side-effects rule partially helps but is framed as UX, not safety.)

---

## What's already good (keep)

- **"The user only sees your last message" rule.** Genuinely non-obvious,
  specific, and consequential — exactly what a system prompt *should* carry.
  Keep it, just move it to a stronger position.
- **Opt-in external side effects.** Good safe default; right call for an agent
  with email/Slack/Telegram reach.
- **Concrete copy-pasteable examples** for the genuinely tricky calls
  (`env.CONNECTIONS`, `set_preview`) reduce malformed calls — the issue is
  *location* (Finding 3), not that they exist.
- **Pointing at AGENTS.md/CLAUDE.md** is the right instinct (just elevate it and
  add precedence — Finding 7).
- **Subagent scoping** ("keep bounded," "report file paths," "do not spawn
  additional subagents") is tight and prevents recursion blowups.

---

## Suggested next step

The highest-leverage, lowest-risk changes are **Finding 2** (skill descriptions)
and **Finding 1** (an Identity + Behavior block), followed by **Finding 3 + 4**
(move call-syntax into tool/skill layers and add section headers). Those four
would cut resident token cost, make the skill system discoverable, and give Pi
consistent behavior across the Claude/Codex/OpenRouter routes — without touching
any tool wiring.
