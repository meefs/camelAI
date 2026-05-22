# Surfacing the HTML Renderer to the Agent

## Context

The renderer expansion branch added preview support for HTML, SVG, JSON/JSONL,
and CSV/TSV source mode. Of those, only HTML changes what the agent can
*offer* the user — the rest are quality-of-life improvements for the human
reading a file. The agent doesn't need to be told it can pretty-print JSON or
view CSV source; the user does.

The HTML renderer is different. Today the agent only knows two visual output
modes: notebook (data analysis) and a deployed Worker (live/interactive app).
A standalone single-file HTML doc — a static report, a mockup, a one-pager,
a printable summary — falls between those, and the agent currently has no
permission to use it.

## Audit

### `services/sandbox-host/internal/app/pi_system_prompt.md` — the blocker

The `<chat_preview_pane>` section at [pi_system_prompt.md:97-113](../services/sandbox-host/internal/app/pi_system_prompt.md#L97-L113)
contains an output rule that is now actively wrong:

```
- Never paste raw HTML in chat. HTML does not render in the preview pane; deploy it as a Worker instead.
```

The first clause ("never paste raw HTML in chat") is still correct — the chat
markdown renderer does not execute HTML. The second clause is now false: the
preview pane *does* render `.html` files via a sandboxed iframe. As written,
this rule tells the agent the lightweight HTML path doesn't exist.

The same section also says "Deploy for live or interactive apps", which is
fine, but combined with the line above, the agent reads "any HTML = deploy."

### `sandbox/skills/file-sharing/SKILL.md`

Describes `/mnt/user-outputs/` patterns for images (inline) and other files
(download links). No mention of HTML preview. Not a blocker — the agent
already knows it can write files there — but it's the natural place to
mention that an `.html` file is also previewable.

### `sandbox/skills/developing-software/SKILL.md`

This is the "deploy a Cloudflare Worker" skill. Nothing in it should change;
the HTML-doc path is intentionally not a deploy.

### `sandbox/skills/data-analysis/SKILL.md`

Already pushes notebooks-not-HTML for analysis output
([data-analysis/SKILL.md:148](../sandbox/skills/data-analysis/SKILL.md#L148)
forbids raw HTML tables in notebooks). No conflict; we want analysis to keep
flowing through notebooks.

### Other skills

`sending-emails`, `testing-debugging`,
`custom-domain-troubleshooting` — no relevant mentions.

## Proposal

Two edits, both minimal. Goal: unlock the HTML-doc path without recasting
it as a default.

### Edit 1 — Replace the wrong rule in `<chat_preview_pane>`

Change the bullet at line 109 from:

```
- Never paste raw HTML in chat. HTML does not render in the preview pane; deploy it as a Worker instead.
```

to:

```
- Never paste raw HTML in chat. To show an HTML page, write the file and pull it up with set_preview().
```

Keep the rest of the section as-is. The existing "Deploy for live or
interactive apps" bullet right below it continues to steer multi-page or
interactive work toward the Worker path, so we don't need to repeat that
distinction in the HTML line.

**Optional stronger variant** (if we want the deploy distinction in writing):

```
- Never paste raw HTML in chat. To show an HTML page, write the file and pull it up with set_preview(). For anything that needs a public URL, deploy instead.
```

I lean toward the minimal version: the "Deploy for live or interactive apps"
line already covers the case, and the agent can connect "preview = thread-only,
deploy = public URL" without us spelling it out. We can add the second
sentence later if real-world behavior shows drift.

### Edit 2 — One line in the file-sharing skill (optional)

In `sandbox/skills/file-sharing/SKILL.md`, alongside the image-inline and
download-link patterns, add a single line that an `.html` file in
`/mnt/user-outputs/` can be previewed via `set_preview()`. This is a small
nudge and is genuinely optional — the system prompt change above is the
load-bearing one.

### What I'm not proposing

- No mention of SVG source / JSON pretty-print / CSV source in the prompt or
  skills. These help the *human* skim a file; the agent doesn't choose them
  and doesn't need to know they exist. Telling the agent will only make it
  narrate the toolbar.
- No new skill file. A whole "static-html" skill would over-index on this
  path — the goal is to make HTML a quiet third option, not a featured one.
- No edits to `developing-software/SKILL.md`. The deploy path stays the deploy
  path.

## Expected behavioral impact

What I expect to change:

- For "make me a one-page summary / printable report / quick mockup" style
  asks, the agent will sometimes write a single `.html` file and preview it
  instead of either (a) refusing to produce HTML, (b) producing markdown that
  loses styling, or (c) scaffolding a full Worker.
- Slight reduction in "deploy a Worker for a static page" turns.

What I expect *not* to change much:

- Data analysis still flows to notebooks — the data-analysis skill is
  explicit, and the system prompt still says "prefer notebooks for data
  analysis."
- Multi-page / interactive work still flows to deploys.

Risks / things to watch:

- **Drift into using HTML for analysis output.** Likely if the prompt frames
  HTML too positively. Mitigation: the proposed wording is plain ("to show
  an HTML page, write the file and set_preview it") with no encouragement
  language ("lightweight", "great for", etc.). The pre-existing notebook
  preference stays in place.
- **Drift into building multi-file static sites.** Less likely — `.html`
  preview only handles one file at a time, and the deploy path is still the
  obvious answer for anything non-trivial. We can add a guardrail later if
  it happens; pre-emptively writing one will probably just confuse the model.
- **Agent narrating the renderer ("you can toggle to source view").** The
  proposed wording doesn't mention source mode, and skills don't either, so
  this should stay invisible to the agent.

## Open questions for you

1. Wording of the replacement bullet — happy to iterate. I deliberately
   avoided words like "lightweight" or "simple HTML doc" because they tend
   to read as marketing and the agent picks up on tone.
2. Edit 2 (file-sharing skill): worth it, or skip? I lean skip on a first
   pass and only add it if real-world behavior shows the agent isn't picking
   up the HTML path from the system prompt change alone.
3. Anything you want to *add* to the bullet — e.g., an explicit note that
   the iframe is sandboxed, so the agent doesn't try to do `localStorage` /
   parent-window tricks expecting them to work? I'd default to not adding
   this until we see it cause a problem.
