# Project VM Tooling Ideas

## 1. Progressive Tool Disclosure

The agent tool surface is getting large. Instead of exposing every tool/function at once, expose a small set of discovery tools first:

- `list_tool_categories()` returns broad groups such as files, VMs, projects, deploys, integrations, browser, scheduling, and admin.
- `list_tools({ category })` returns tools in one category with schemas and short examples.
- `describe_tool({ name })` returns the full schema, behavior notes, and common examples.

This keeps the model focused while still allowing it to expand the tool surface when needed. It also gives us a natural place to hide advanced or risky tools behind intentional discovery.

## 2. Legacy Go Sandboxes As Projects

Treat existing Go sandbox workspaces as project backends so old users can still access their files without an immediate migration.

Potential model:

- A project can have a `backend` such as `cloudflare_vm`, `durable_workspace`, or `legacy_go_sandbox`.
- Legacy projects expose the same file/project interface, but route reads, writes, listings, search, and migration helpers to the Go host.
- Users see their old work as a normal project, not as a special migration mode.
- We can later offer “move to Cloudflare VM project” as an explicit project migration action.

This reduces migration pressure and gives us a compatibility bridge while the new Cloudflare Sandbox path stabilizes.

## 3. Descriptive Project Names

Projects should have both stable ids and human-friendly names.

Suggested fields:

- `id`: stable slug used in tool calls and storage keys.
- `name`: descriptive display name, editable by the user or agent.
- `description`: optional short context about what the project is for.
- `defaultVmId`: usually `main`.
- `backend`: where the project files/compute live.

This lets the model and UI show useful names like “Marketing site redesign” while keeping deterministic ids such as `marketing-site`.

## 4. Cloudflare Artifacts For Project Version Control

Use Cloudflare Artifacts as the version-control layer for projects.

Possible direction:

- Each project maps to an Artifact-backed repository/history.
- VM sessions operate on a checkout/worktree.
- The agent can create commits/checkpoints from meaningful milestones.
- Durable workspace files remain useful for notes, uploads, and metadata, while project source history lives in Artifacts.
- A project can restore, branch, diff, or roll back through Artifact history instead of relying only on VM snapshots.

This would separate two concerns cleanly:

- Sandbox backups preserve VM runtime state across sleep/cold start.
- Artifacts preserve project source history and user-visible version control.

## 5. Install Heavy Tooling On Demand

The Cloudflare Sandbox VM image should stay small by default. The first trimmed
image removed Python/uv caches, Jupyter/data-science packages, and
Playwright/Chromium, dropping the image from roughly 4.7 GB to roughly 1.0 GB.
Deploy verification and private-app UI checks now run through js_exec
`env.SCREENSHOT.capture()` on the main worker (Browser Rendering + dispatch
binding), not container Playwright.

Instead of baking heavyweight tooling into every VM:

- Keep the base VM focused on the common app-building path: Node, Bun, git,
  shell utilities, Wrangler, and camelAI helpers.
- Let the agent install Python/data-analysis/browser tooling only when a project
  actually needs it.
- Update skill prompts that currently assume Python, uv, Playwright, or browser
  dependencies are preinstalled in the VM. Prefer js_exec screenshot capture for
  post-deploy visual checks.
- Prefer per-project setup scripts or cached project-level installs over a
  large global image layer.

This keeps VM startup, image push, and cold deploy times reasonable without
blocking heavier workflows.

## 6. Async Recent Activity Per Project

Track project activity asynchronously so project metadata stays useful without
making file tools, VM exec, or agent turns wait on bookkeeping writes.

Potential model:

- Record activity events for project file edits, VM execs, deploys, commits,
  previews, and explicit user/project switches.
- Store compact rollups on the project record: `lastActivityAt`,
  `lastActivityType`, `lastActor`, `lastVmId`, and a short human-readable
  summary.
- Use background writes through `waitUntil` or an internal queue so tool calls
  can return as soon as the user-visible work is done.
- Keep raw event history bounded or sampled; the main goal is recency,
  dashboard ordering, and helping the agent choose relevant projects.
- Make activity updates best-effort but observable, so failed tracking never
  blocks real workspace work and still leaves diagnostics.

This would let the UI show "recent projects" and give the agent better project
context without turning every filesystem operation into a synchronous metadata
transaction.

## 7. Artifacts-Backed Project Git

Implemented direction:

- `create_project` creates or returns one project record, one Cloudflare
  Artifacts repo, and one default `main` VM record.
- The VM bridge prepares `/workspace/projects/{projectId}` as a normal Git
  checkout before project VM commands run.
- The checkout remote is tokenless and uses the sandbox-only vanity host
  `https://artifacts.camelai.internal/git/{projectId}.git`; the Sandbox Durable
  Object rewrites that to the real Artifacts remote and injects short-lived
  repo-scoped tokens outside the VM.
- The sandbox can only access the Artifacts repo attached to its project
  identity.
- The agent should use normal Git commands inside the VM for selective staging,
  committing, and pushing. This avoids shoving dependency folders, build output,
  caches, or secrets into Git history.

Current invariant: one writable VM checkout per Artifacts repo. Keep `vmId` for
compatibility, but project-backed work should default to the `main` VM.
