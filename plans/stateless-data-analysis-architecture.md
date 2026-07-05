# Stateless Data Analysis — Notebook Compute over the Project Filesystem

> Goal: give the data-analysis workflow (Python notebooks, charts, ad-hoc SQL/file
> wrangling) a home that does not depend on a persistent VM. Files stay in the
> stateful project filesystem (`WorkspaceFilesystemDO`, DO + R2); compute becomes a
> warm, disposable, per-workspace Cloudflare Container in the mold of the build tier
> (`plans/no-vm-build-deploy-architecture.md`).
>
> This is the companion to the no-VM build/deploy plan: that plan retires the VM for
> the **app** path (files → DO+R2, builds → `ProjectBuildSandbox`, deploys → direct
> CF API) and deliberately blocks agent bash. Data analysis is the **remaining
> consumer** of the stateful VM — `uv`/Jupyter/`usql` driven through `bash` against
> a VM `/workspace` — and has no do-r2 equivalent yet. This plan supplies it.
>
> **It also absorbs the warehouse tier.** The existing `WarehouseSandbox`
> (`docs/warehouse-binding-design.md`) is a sealed (`enableInternet = false`),
> stdout-only DuckDB-over-R2 container — one warm container per workspace, session
> per call. That seal was an implementation simplification, not a requirement: with
> no credentials ever in the container (they stay server-side in the connections
> `export` path) and an egress allowlist, a non-sealed container is no less safe.
> So this plan **replaces `WarehouseSandbox` with one unified analysis container**.
> DuckDB cross-source reduction becomes ordinary Python in the same tier that runs
> notebooks; the server-side `export → R2` linchpin is unchanged. One Python
> compute tier, two entrypoints (agent + deployed apps), no sealed twin to maintain.

---

## 0. TL;DR

| Concern | Today (VM) | New model |
|---|---|---|
| Notebook + data files | VM disk (`/workspace`), git-pushed to Artifacts if remembered | **Project FS (DO + R2)** — already the do-r2 store; source of truth |
| Python environment | `.venv` + `pyproject.toml` persist on VM disk across sessions | **Derived state.** `pyproject.toml` + `uv.lock` in the project FS; venv reconstituted in the container; default data stack **baked into the image → zero setup** |
| Execution | Agent `bash` → VM `/exec` (`uv run jupyter nbconvert …`) | **`AnalysisSandbox`** — warm container per workspace, session per run, materialize-in / persist-out (the `ProjectBuildService` pattern) |
| Big data in | Rows pulled into pandas over connections RPC, or files copied to VM disk | **Read-only R2 mounts**: workspace uploads + connection exports mounted s3fs, reusing `WarehouseSandbox.ensureExportsMounted` |
| Live DB queries | `CAMELAI_CONNECTIONS_RPC_URL` injected into VM exec env | Same env var, pointing at the intercepted `connections.internal` host — served by a Worker-side outbound handler with DO-attached scope; no token, creds never enter the container |
| Preview | `set_preview(source:"vm")` → bridge `readFileStream` | **Unchanged do-r2 path**: executed `.ipynb` lands in the project FS, `source:"project"` preview already renders it |
| Heavy cross-source reduction | `warehouse_run_code` (separate sealed DuckDB container) | **Same unified container.** `export → R2` unchanged; DuckDB runs as Python here alongside notebooks — no sealed twin |

The agent-facing loop becomes: edit notebook (DO file write, no container) →
`run_notebook` (warm container, seconds) → structured validation report back →
preview from the project FS. Every run is reproducible from FS + mounts; there is no
"works on my VM" drift to debug, because there is no VM.

### Architecture at a glance

```
   agent (chat tools)          ┌────────────────────────────────────────────┐
   run_notebook ──────────────►│            chiridion (Workers)             │
   analysis_exec               │  AnalysisService (WorkerEntrypoint, props) │
   add_python_dependency       └───┬───────────────┬────────────────────────┘
                        materialize│               │ persist changed files
                        (content-  │               │ (hash diff, size-guarded)
                         addressed ▼               │
        ┌──────────────┐  sync) ┌──────────────────┴──────────┐   ro s3fs   ┌─────────────┐
        │  Project FS  │◄──────►│   AnalysisSandbox container │◄────mount───│     R2      │
        │  DO + R2     │        │  (warm per workspace,       │             │ uploads/    │
        │ (notebooks,  │        │   session per run, gVisor)  │             │ warehouse/  │
        │  pyproject,  │        │  baked python data stack,   │             │  exports    │
        │  uv.lock)    │        │  uv, jupyter, usql          │             └─────────────┘
        └──────┬───────┘        │  egress: PyPI allowlist +   │
               │                │  connections.internal ONLY  │
               ▼                └─────────────────────────────┘
        preview (existing                 ▲
        source:"project" path,            │ CAMELAI_CONNECTIONS_RPC_URL → connections.internal
        .ipynb report renderer)           ▼
                            connections outbound handler (Worker; creds server-side,
                            workspace scope attached DO-side — no token)
```

---

## 1. What the VM actually provided (and what replaces it)

The data-analysis skill (`sandbox/skills/data-analysis/SKILL.md`) leans on exactly
four pieces of VM statefulness:

1. **Files** — notebooks, CSVs, intermediate outputs on `/workspace`.
   → Project FS. Already shipped as the do-r2 backend (`workspace-filesystem-do.ts`);
   nothing new.
2. **The Python environment** — "`pyproject.toml` and `.venv` persist across
   sessions." → `.venv` becomes derived state that is never stored (the exact
   `node_modules` rule from the build plan §5c). The FS stores `pyproject.toml` +
   `uv.lock`; the container reconstitutes the venv. Crucially, the **default data
   stack is baked into the image**, so most analyses need no env step at all (§4).
3. **Execution surface** — `bash` → VM `/exec` for `uv run jupyter nbconvert`,
   `validate-notebook`, `usql`, format conversions. → Mediated platform tools
   running in the container session (§5).
4. **The preview + connections plumbing** — `set_preview(source:"vm")` and
   `CAMELAI_CONNECTIONS_RPC_URL` in the exec env. → Preview needs *nothing*: the
   executed notebook persists into the project FS and the existing
   `source:"project"` path serves it. Connections RPC keeps the same env-var
   contract, re-scoped per session (§3c).

Notably, the current workflow is **already stateless in spirit**: the skill mandates
whole-notebook re-execution (`nbconvert --execute --inplace`) rather than a
long-lived kernel, and Report mode requires a fully executed notebook anyway. The VM
was persisting far more than the workflow needed. We keep full re-execution as the
correctness baseline and treat a live kernel as a later fast-path (§10).

---

## 2. Design principles

- **Truth lives in the project FS; compute is disposable.** The warm container is a
  cache, never a store. Killing any container at any time loses nothing but warmth.
- **One Python compute tier.** Notebooks, ad-hoc shell, and DuckDB cross-source
  reduction (the old warehouse job) all run in the same container. Keep the
  warehouse's shape — warm container per workspace, session per call, R2 in via
  platform-mediated mounts, no credentials inside — but open exactly two
  SDK-enforced exceptions to its seal: PyPI via `allowedHosts` and live connection
  queries via the intercepted `connections.internal` host (§3c). The blanket seal
  never bought safety these two carve-outs don't preserve; it only bought a
  container that couldn't install a package or run a live query.
- **Big data is mounted, not copied.** The project FS holds code, notebooks, and
  small derived data. Bulk inputs (uploads, connection exports) are read in place
  from read-only R2 mounts.
- **Structured results over shell archaeology.** `run_notebook` returns the
  `validate-notebook` report as data; the agent should almost never parse a
  traceback out of raw stdout.

---

## 3. The `AnalysisSandbox` container

### 3a. Class, keying, lifecycle

- `AnalysisSandbox extends Sandbox<Env>` (the successor to `WarehouseSandbox`,
  sibling of `ProjectBuildSandbox`), binding `ANALYSIS_SANDBOX`.
- **One warm container per workspace**: `getSandbox(ANALYSIS_SANDBOX, workspaceId)`.
  Analysis is workspace-scoped — connections, uploads, and export prefixes all key
  on the workspace, and projects are workspace-owned (`ca-<workspaceId>-…`). This
  matches the warehouse (workspace) rather than the build tier (org + project).
- **Session per run** (`createSession({ id, cwd })`, deleted in `finally`) exactly
  like `warehouse-service.ts`. Container-lifetime caches (venvs, project trees,
  uv cache) live outside session dirs.
- `standard-4`, scale-to-zero, `sleepAfter` on the order of 10 minutes — analysis
  is an iterative loop (edit → run → look), so a slightly longer warm tail than the
  build tier's 5 minutes pays for itself in warm reruns.
- Disk is ephemeral; a fatter pre-pushed image (Python data stack, ~2–3 GB) means
  cold provision lands somewhere above the build tier's measured ~3 s — measure it,
  but even ~10 s cold is fine when warm reruns are ~seconds.

### 3b. Image contents

Bake what the skill currently `uv add`s on every fresh VM:

- Python 3.13 + a **preinstalled default venv** (`/opt/analysis-venv`, on `PATH`):
  pandas, numpy, polars, duckdb, pyarrow, altair, plotly, matplotlib, seaborn,
  scipy, scikit-learn, statsmodels, openpyxl, xlsxwriter, pdfplumber, python-docx,
  python-pptx, jupyter/nbconvert, sqlalchemy + drivers.
- `uv` with a **seeded `UV_CACHE_DIR`** covering that same set, so projects that do
  declare a `pyproject.toml` sync in seconds even on a cold container.
- `validate-notebook` (from `sandbox/validate-notebook.py` — pure `.ipynb` JSON
  inspection, trivially portable) on `PATH`.
- CLIs the skill documents: `usql`, `sqlite3`.

### 3c. Network posture

`enableInternet = false` with **SDK-enforced exceptions** — both are first-class
Sandbox SDK features, so nothing is deferred to host-level infra and no token is
ever minted:

1. **PyPI via `allowedHosts`** (`pypi.org` / `files.pythonhosted.org`) — the SDK's
   egress proxy grants listed hosts internet access even with the internet off,
   for `uv` when a project needs packages beyond the baked stack.
2. **Connections via an intercepted internal host.** Container code POSTs to
   `http://connections.internal/` — the same `CAMELAI_CONNECTIONS_RPC_URL`
   protocol and variable the VMs exposed, so notebook helper code carries over
   unchanged. The sandbox egress layer intercepts the host and dispatches a
   registered **outbound handler** in Worker context (the identical mechanism the
   SDK itself uses for credential-less `r2.internal` mounts). The workspace/org
   scope arrives as handler params that `AnalysisService` attached **DO-side** via
   `setOutboundByHost` — container code cannot forge them, and there is no
   session token to leak because there is no token at all.

No other egress. Customer-DB credentials never enter the container — same invariant
as the old warehouse and the data-proxy paths, and the reason an open
`analysis_exec` here is not the old VM-bash risk (§7).

**On dropping the seal:** the warehouse was sealed for implementation simplicity,
not because the threat model demanded it — with creds resolved server-side in the
`export` path, a sealed container and an allowlisted one are equally free of
secrets. The only real residual the allowlist adds is that PyPI egress is a
theoretical exfiltration channel for mounted export data (exactly as npm egress is
for org source in the build tier — an accepted trade there). We accept it the same
way and ship **one allowlisted tier, no sealed variant** — consistent with the
build tier and a strictly simpler surface than maintaining two network postures.

### 3d. R2 mounts (data in)

Reuse the `ensureExportsMounted` machinery (single-flight gate, already-mounted
tolerance, `stat_cache_expire=1` — `warehouse-sandbox.ts`):

- `/<warehouse-prefix>` → the workspace's `warehouse/<workspaceSlug>/` prefix (the existing
  export staging location — keys unchanged), read-only. A staged export can be
  reduced with DuckDB *or* charted from a notebook in the same container, so the
  old export→reduce→export→chart round-trip between two tiers collapses to one.
  Export keys are deterministic per (connection, query), so the skill's
  export→analyze handoff works verbatim.
- `/uploads` → the workspace uploads prefix, read-only, at a stable alias matching
  the agent's `uploads/<name>` R2 reference (the raw org/workspace-prefixed key is
  never shown to the agent and can't be derived in the container). A 500 MB
  uploaded CSV is `pd.read_csv("/uploads/…")` or DuckDB-scanned in place — never copied
  into the project FS or materialized per run.

Outputs do **not** get a writable mount (s3fs writes are the flaky half); results
flow out through the persist-back path (§6) and the existing `write`/`move`
tools for user-visible R2 outputs.

---

## 4. The Python environment model

- **No `pyproject.toml` in the project → the baked default venv.** Zero setup, zero
  install, first run is immediately warm. This deletes the skill's entire
  `uv init && uv add <ten packages>` preamble — the single biggest agent-UX win.
- **`pyproject.toml` present → `uv sync`** (`--frozen` when `uv.lock` exists) into a
  **container-local venv cache keyed by lock-file hash** (`/venvs/<lockHash>`),
  shared across sessions, rebuilt from the seeded uv cache on a cold container.
  Warm rerun with an unchanged lock: venv reuse, ~0 cost.
- **`add_python_dependency({ project, packages })`** — the mediated mirror of the
  build tier's `add_dependency`: `uv add` in the warm container, persist
  `pyproject.toml` + `uv.lock` back to the project FS, return structured
  success/failure. The agent can also just edit `pyproject.toml` (a DO file write)
  and let the next run's sync reconcile — same primary/fallback split as the build
  plan §5c.
- `.venv`, `__pycache__`, `.ipynb_checkpoints` are never persisted (ignore set, §6).

---

## 5. Surface — four methods, two entrypoints, no bash-to-VM

All served by one `AnalysisService` (`WorkerEntrypoint` with `{ workspaceId, orgId }`
props), replacing `WarehouseService`. Two call sites, same service, same container —
the two-entrypoint pattern the warehouse already established:

- **Agent / chat (`js_exec` + tools):** `run_notebook`, `analysis_exec`,
  `add_python_dependency`, and `run_code` (below), wired into code-mode tools like
  `WarehouseService` → `warehouse_run_code` is today.
- **Deployed user apps:** the virtualized `env.ANALYSIS` binding rewrites to the
  **narrowed `AnalysisAppService` entrypoint**, which exposes exactly
  `runCode({ code, params })` + `listConnections()` — the code-string +
  export-mounts capability only. App runs execute in a **separate warm container**
  (`app-<workspaceId>`) from the agent's: mounts and the connections interception
  are container-level state, so sharing the agent's container would leak the
  uploads mount and `connections.internal` access that agent runs legitimately
  establish there. The app container only ever gets the export-prefix mount, no
  connections RPC URL is injected, and its **egress is sealed outright** before
  every run (empty allowlist override — app code has no PyPI use case, so the
  agent tier's allowlist would only be an exfiltration channel; this restores
  the pre-merge WarehouseSandbox posture for app code). No project materialize,
  no notebook, no persist-back. Defense in depth: the full `AnalysisService` additionally
  validates every `projectId` against the bound workspace's project registry
  before opening its file store.

The old `env.WAREHOUSE` binding and `warehouse_run_code` tool are retained purely
as **source-compatibility aliases** onto the above — enough that shipped apps and
existing agent transcripts keep resolving — and are otherwise invisible: the alias
tools are flagged `hidden`, which keeps them callable on the js_exec `tools` object
but drops them from every discovery surface (tools.help/search/describe, the
js_exec prompt inventory, and Pi top-level registration). `WarehouseService` is a
thin entrypoint shim that delegates to `AnalysisService`. New code uses
`ANALYSIS` / `run_code`.

### 5a. `run_notebook` — the primary path

```
run_notebook({ project, path, timeoutMs? }) → {
  ok,                    // executed AND validated clean
  validation,            // structured validate-notebook report (per-cell issues)
  stdout, stderr,        // capped tails
  changedFiles,          // what was persisted back
  durationMs
}
```

Pipeline inside one session: sync project into the container (§6) → ensure env (§4)
→ `jupyter nbconvert --to notebook --execute --inplace <path>` → run
`validate-notebook` → persist changed files back to the project FS → return the
report. The executed `.ipynb` (outputs embedded) is now in the project FS, so
`set_preview(source:"project")` and the Report-mode renderer work with no new code.

One tool call replaces today's execute-bash / validate-bash / move-file /
set-preview dance, and the validation contract ("fix failing cells and re-execute,
never `--allow-errors`") becomes enforceable: `ok: false` with per-cell findings
instead of prose in a skill.

Default timeout ~300 s, cap ~900 s. Longer pipelines belong in deterministic
workflows (the `deterministic-automations` skill already points there), which can
call the same service as a step.

### 5b. `analysis_exec` — the escape hatch

```
analysis_exec({ project?, command, cwd?, env?, timeoutMs? }) → { stdout, stderr, exitCode, changedFiles }
```

`bash -lc` in a session with the project materialized at the cwd. Covers everything
`run_notebook` doesn't: `usql` schema poking, `sqlite3`, pdfplumber one-offs,
Excel→CSV conversions, quick `python -c` probes against a mounted upload. Same
materialize/persist semantics; `project` optional (omit for pure scratch work over
mounts).

This deliberately diverges from the app path's "no agent bash": that ban exists
because VM bash sat next to a credential-injecting deploy proxy and the org's app
source. Here the container holds no credentials, reaches two allowlisted hosts, and
its writes are size-guarded diffs into one project's FS. The flexibility is worth
it — data analysis is long-tail-of-shell-tools work in a way app deploys are not.

### 5c. `run_code` — the DuckDB / warehouse successor

```
run_code({ code, params?, project? }) → { ok, stdout, stderr, result, error }
```

The direct heir of `warehouse_run_code`: run a Python string in a fresh session,
`params` passed as a JSON dict (no string interpolation — the existing
`withWarehouseParams` convention), results back via stdout. The sealed-DuckDB job is
now just this method in the unified container, with the export prefix mounted at
`'/' + r2_key`. `project`
is optional: omit it for pure reduction over mounts (the classic warehouse case);
pass it to read/write small project files inline. This is also the deployed-app
entrypoint's method (§5, minus `project`).

(`warehouse_run_code` resolves here too — the source-compat alias from §5.)

### 5d. `add_python_dependency` — §4.

`bash`/`vm_exec` continue to reject do-r2 projects (already enforced in
`code-mode-tools.ts`); their legacy-VM path dies with the VM fleet.

---

## 6. The sync model (materialize in, persist out)

The crux of stateless compute over a stateful FS. Both sides are content-addressed
(`@cloudflare/shell` blobs by hash), which makes this cheap:

- **Materialize (cold):** walk the project manifest, write files into the
  container's project cache dir (`/projects/<projectId>`) — the
  `materializeProjectSourceFiles` pattern from `project-build-service.ts`.
- **Materialize (warm):** diff the DO manifest's hashes against a stamp file from
  the last sync; write only changed/added, delete removed. A one-file notebook edit
  syncs one file.
- **Persist:** after the run, hash-diff the tree the other way; write
  changed/added back through the project FS client, delete removed. Runs against
  the project DO, which serializes with concurrent agent edits.
- **Ignore set:** `.venv`, `__pycache__`, `.ipynb_checkpoints`, `.cache`, plus the
  build tier's usual suspects. **Size guard:** files over a threshold (~25 MB) are
  not auto-persisted — the run reports them and the agent explicitly `move`s the
  ones that matter to R2 outputs. Prevents a casual `df.to_parquet()` of an
  intermediate from bloating the FS.
- **Scratch:** every run gets a per-run `$SCRATCH` directory (created by the
  service, removed with the workdir, never persisted); the skill teaches:
  intermediates go to `$SCRATCH`, results go in the project or to outputs.
- **Concurrency:** every run gets its own **per-invocation workdir**
  (`/projects/<id>/runs/<runId>`, deleted after the run), so overlapping runs on
  the same project can never clobber each other's trees — each persists a diff
  against its own start manifest. The project venv stays shared across runs via
  `UV_PROJECT_ENVIRONMENT` (uv locks the env during sync), so isolation doesn't
  cost env warmth. Concurrent writes to the same file resolve last-write-wins at
  the project FS.

Future optimization, not v1: the project blobs already sit content-addressed in R2
(`project-fs/<doId>`), so materialization could become an R2 CAS mount + manifest
hardlinker instead of per-file RPC writes. The hash-diff warm path makes this
mostly moot for the iterative loop.

---

## 7. Security posture

| Layer | Property |
|---|---|
| Tenancy | One container per **workspace** (`sandboxId = workspaceId`); cross-workspace is a hard DO/container boundary. |
| Execution | gVisor microVM, per-run session dirs, per-call timeouts, ephemeral disk. |
| Network | `enableInternet = false` + SDK `allowedHosts` (PyPI) + intercepted `connections.internal`. Nothing else (§3c). |
| Credentials | None in the container, ever — and no tokens either. Connections via the outbound handler with DO-attached workspace scope; R2 via platform-mediated read-only mounts; no CF API access of any kind. |
| Blast radius of `analysis_exec` | One project's FS (size-guarded diff writes), one workspace's read-only data. No deploy surface. |
| Deployed-app entrypoint | `run_code` only — no project tree, no persist-back; same workspace-scoped props + mounts as the agent path. |

---

## 8. Absorbing the warehouse

The warehouse is **not a separate tier** in this design — it's a use-case of the
unified container. `WarehouseSandbox` (sealed) is deleted; `WarehouseService` folds
into `AnalysisService`. What's kept vs replaced:

| Warehouse piece | Fate |
|---|---|
| Server-side `export({ query })` connection method (SQL/ClickHouse/BigQuery → R2) | **Kept unchanged** — the linchpin; creds stay server-side, static egress IP preserved. |
| Deterministic export key `warehouse/<ws>/<conn>/<hash>.{parquet,ndjson}` | **Kept** — same staging location, readable at `'/' + r2_key` exactly as before. |
| `WarehouseSandbox` class, `enableInternet = false`, s3fs mount helper | Mount helper **kept** (moves to `AnalysisSandbox`); the sealed class, its image, container config, and DO binding **deleted** (`deleted_classes` migration). |
| `WarehouseService` entrypoint | **Kept as a delegating shim** — already-deployed apps' baked `WAREHOUSE` bindings resolve to it; it forwards `runCode`/`listConnections` to `AnalysisService`. |
| `warehouse_run_code` tool / `env.WAREHOUSE` binding | **Retained as source-compat aliases, hidden from all discovery** (callable, never advertised). |
| Two containers to keep warm per workspace | **Collapses to one.** |

The big-data flow keeps its shape, minus a tier hop: export → `run_code` reduces to
a small result → the result lands in the project → `run_notebook` charts and
narrates it — all in one container, so a reduced result can be charted without a
round-trip. Medium exports skip the reduce step entirely and get read straight into
a notebook straight off the export mount.

**Backwards compatibility is total for callers.** Everything a warehouse caller
touches — the `export` method, the export keys, `WAREHOUSE_EXPORT_BUCKET`, and the
`warehouse_run_code` / `env.WAREHOUSE` source-compat aliases — keeps resolving. Only
the compute *container* changes, and that's invisible across those interfaces: same
code-string-plus-`params` contract, same stdout results, same mounted export at
`'/' + r2_key`. No agent transcript, skill example, or shipped
`freight-analyzer`-style app has to change to keep working.

The one property genuinely lost is the hard `enableInternet = false` seal. §3c
argues it bought no real safety over the allowlist (creds were already server-side),
so we drop it outright — there is no sealed variant and no zero-egress mode in this
design. That's a runtime posture change, not a caller-visible API change.

---

## 9. Skill changes

`sandbox/skills/data-analysis/SKILL.md` gets meaningfully **shorter**:

- Delete the `uv init` / `uv add` preamble → "the default stack is preinstalled;
  use `add_python_dependency` for anything else."
- Replace the nbconvert/validate bash choreography with `run_notebook` and its
  structured report.
- Add the data-placement rule: big inputs from `/uploads` and the export mounts,
  intermediates in `/scratch`, notebooks + small results in the project.
- Connections section survives nearly verbatim (`CAMELAI_CONNECTIONS_RPC_URL`
  contract unchanged).
- Warehouse section is **merged in, not kept separate**: the "sealed tier / no
  charts / no internet / use it to *reduce* then hand off to a notebook" framing
  goes away. New framing: "for bulk/cross-source, `export` to R2 then `run_code`
  (DuckDB) over the export mounts — in the *same* container, so you can chart the
  reduced result in a notebook right after." Drop the two-tiers-with-different-
  capabilities table.
- Rendering constraints (Altair/Plotly/DataFrame rules, Report-mode structure)
  unchanged — the renderer never knew about the VM.

---

## 10. Rollout & migration

1. **Container + service.** `AnalysisSandbox` image (Dockerfile replacing
   `warehouse-sandbox.Dockerfile`), `ANALYSIS_SANDBOX` container binding,
   `AnalysisService` with `run_notebook` / `analysis_exec` / `run_code` /
   `add_python_dependency`, sync layer (reuse the build tier's materialize +
   transfer helpers). Carry over the s3fs mount helper from `warehouse-sandbox.ts`.
   Wire code-mode tools.
2. **Fold in the warehouse.** `AnalysisService` becomes the one compute service;
   the `export` connection method, export keys, and `WAREHOUSE_EXPORT_BUCKET` are
   untouched — only the compute container changes. `WarehouseSandbox` + the sealed
   image are deleted in the same change (`deleted_classes` migration);
   `WarehouseService` stays as a delegating entrypoint shim and
   `warehouse_run_code` / `warehouse_list_connections` stay as hidden,
   callable-only aliases (§5). (The `warehouse-service.ts` tests shrink to the
   surviving pure helpers.)
3. **Skill rewrite** behind tool availability; preview path needs nothing.
4. **Migration rides the no-VM plan §14** — analysis projects *are* projects: the
   force-commit sweep captures notebooks + `pyproject.toml`/`uv.lock` (with a
   `.gitignore` covering `.venv`), lazy hydration flips them to do-r2, and the
   `backend` flag is the rollback. `.venv` is rebuilt, by design. Accepted loss:
   data files that lived only on VM disk and were gitignored/never pushed —
   same abandoned-residue category the no-VM plan already accepts; pre-warm top
   analysis users the same way.
5. **Later, if earned:** live-kernel fast path (a Jupyter kernel pinned in the warm
   container for cell-level iteration, with full re-execution still the source of
   truth for the delivered notebook); CAS-mount materialization.

## 11. Open questions

- **Cold-provision time for the fat image** — measure; if it's ugly, split a slim
  default-venv layer from CLI extras, or trim the baked stack.
- **Egress allowlist mechanics** — the build tier is establishing the pattern
  (registry-only); reuse whatever lands there rather than inventing a second one.
- **Uploads mount vs copy for small files** — s3fs read of many tiny objects can be
  slower than one DO read; likely fine, verify.
- **Per-workspace warm cost** at `standard-4` — same validate-against-peak exercise
  as the build tier; analysis containers can probably idle on a smaller instance if
  cost bites.
- **`analysis_exec` inclusion** — the design argues for it (§5b); if the posture
  review disagrees, `run_notebook` + `add_python_dependency` + `run_code`
  (code-string, warehouse-style, §5c) cover ~90% with no shell.
- **Deployed-app egress after un-sealing** — deployed apps previously ran in the
  *sealed* warehouse container; the merged container allows PyPI + `connections.internal`.
  Confirm no shipped app relied on the seal as a guarantee (none should — they only
  ever got `runCode` over export mounts), and that the deployed-app entrypoint
  denies project materialize as intended.
