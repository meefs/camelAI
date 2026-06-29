# Serverless Projects — DO+R2 File Store, Per‑Org Container Builds, Direct‑API Deploys, Git‑Backed History

> Goal: retire the per‑project VM entirely. Move project files to Durable Objects + R2,
> run builds in a shared, warm, per‑org sandbox container, deploy by uploading the built
> bundle straight to the Workers‑for‑Platforms dispatch namespace via the Cloudflare API
> (no `wrangler` CLI, no in‑VM bash), and make version history / rollback a first‑class
> platform capability backed by Cloudflare Artifacts.
>
> All performance numbers below are **measured** on the camelAI account, not estimated.

---

## 0. TL;DR

| Concern | Today | New model |
|---|---|---|
| Project files | Per‑project VM disk (`project-runtime-service` containers) | **Durable Object + R2** (`WorkspaceFilesystemDO`, source‑only) |
| Compute / build | Per‑project Docker VM, always‑on, agent `bash` | **One warm sandbox container per org** (5‑min idle, lambda‑like), server‑issued build pipeline |
| Deploy | Agent runs `wrangler deploy` in VM → docker deploy‑proxy injects creds | **chiridion assembles the upload from build output → direct CF API upload** to the dispatch namespace |
| Agent shell | Open `bash`/`vm.exec` against a per‑project VM | **No agent bash.** Build/deploy/add‑dep are first‑class platform actions |
| History / rollback | Agent must remember `git commit && git push` | **Auto‑commit on deploy**, first‑class `listCommits` / `revertToCommit` / `rollbackDeploy` |

**Measured end‑to‑end (warm):** build ≈ 2.9s + deploy upload ≈ 0.4s ≈ **~3.3s**. Cold ≈ ~14.5s (install‑dominated, amortizable).

**What gets deleted:** the per‑project VM, `project-runtime-service` as the per‑project runtime, the docker deploy‑proxy (`/deploy/client/v4`, source‑IP identity dance, dummy‑token), and `wrangler`‑the‑CLI.

### Architecture at a glance

```
   user / agent            ┌──────────────────────────────────────────────────┐
   (chat — no bash)  ─────► │                 chiridion (Workers)               │
                           │  platform actions:                                │
                           │   deploy()  addDependency()                       │
                           │   listCommits()  revertToCommit()  rollbackDeploy │
                           └──┬──────────────┬───────────────────┬─────────────┘
                  materialize │        build │      upload (direct CF API)
                     ▲ revert │              │                   │
                     │        ▼              ▼                   ▼
              ┌──────┴───────┐   ┌──────────────────────┐   ┌──────────────────────┐
              │  Project FS  │   │  Per‑ORG sandbox      │   │ Workers‑for‑Platforms │
              │  DO + R2     │──►│  container (warm,      │   │ dispatch namespace    │
              │ (source only)│   │  5‑min idle, gVisor,  │   │ chiridion-platform    │
              └──────┬───────┘   │  standard‑4)          │   └──────────┬───────────┘
                     │           │  bun install + build  │              │ serve
       auto‑commit   │           └──────────┬───────────┘              ▼
       on deploy     │                      │ build output      ┌────────────────┐
                     ▼                      └──────────────────►│  dispatcher    │
              ┌──────────────┐   read tree@sha (revert)         │ DISPATCHER.get │
              │  Cloudflare  │◄────────────────────────────────►│ (script--org)  │
              │  Artifacts   │   commit/push (history)          └────────────────┘
              │ (git history)│
              └──────────────┘
```

*Storage (DO+R2), compute (per‑org container), deploy (direct API), and history (Artifacts)
are decoupled. The container is the only place untrusted code executes; chiridion holds the
deploy credential and the container never sees it.*

---

## 1. Goals & non‑goals

**Goals**
- No per‑project VM. Files in DO+R2; compute only when building.
- One build tier that handles **both** the new lean (Hono + Svelte/esbuild) projects **and** legacy React‑Router 7 + Vite projects.
- Block agent `bash`; builds/deploys become mediated platform actions.
- Automatic, deploy‑linked version history with easy rollback.

**Non‑goals**
- Eliminating *all* containers. The build inherently executes untrusted code; the goal is to move build compute to a **managed, pooled, isolated** container tier, not to pretend it disappears.
- Replacing the dispatcher / serving path. `DISPATCHER.get(script--orgSlug)` is unchanged.

---

## 2. Why change

The per‑project VM couples four unrelated things — file storage, build compute, an exec surface, and a credential‑injecting deploy proxy — into one always‑on, self‑managed Docker host. That's expensive, hard to isolate, and forces the agent to drive builds/commits/deploys through `bash`.

Two early ideas were tested and **rejected as the primary path** (evidence in §3):
- **DO+R2 alone** can't replace the VM because the VM also executes code (build, deploy).
- **In‑worker bundling** (`@cloudflare/worker-bundler`) works for small apps but hits a hard ceiling on real projects.

The surviving design splits the VM's responsibilities cleanly: **storage → DO+R2**, **compute → per‑org container**, **deploy → direct API**, **history → Artifacts**.

---

## 3. Spikes & evidence (why the container tier won)

### 3a. In‑worker bundler (`@cloudflare/worker-bundler@0.2.1`)
- Deploys at **3.74 MB gzip** (esbuild‑wasm + typescript + sucrase), no bindings required.
- Bundled a **moderate** Hono + React app (real npm tree) in **~3.5s cold** (server 114 KB / client 203 KB). ✅
- **Deterministically failed (3/3)** on a **heavy** real tree (recharts + @tanstack/react‑query + lucide + react‑hook‑form): `TypeError: Cannot perform DataView.prototype.setUint32 on a detached or out-of-bounds ArrayBuffer` in esbuild‑wasm's Go runtime — the **128 MB isolate memory ceiling** / esbuild‑wasm growth fragility. ❌

### 3b. Tailwind v4 / oxide in workerd
- Tailwind v4 splits into **extraction** (native Rust `@tailwindcss/oxide`) and **compilation** (`compile()`/`compileAst()`, pure JS).
- `compile()` runs in workerd; **oxide does not** (native NAPI). The `cn()`/`tv()` concern was a red herring — oxide extracts classes from inside wrappers fine; the real risk is reproducing oxide's v4 candidate tokenizer (a naive regex drops 11/40 shadcn‑critical bracket/variant classes).
- A **wasm** oxide build exists (`@tailwindcss/oxide-wasm32-wasi`) and **compiles in workerd** (67 imports; `SharedArrayBuffer` present; even a 1 GiB shared memory allocates). **But** it's a `wasm32-wasip1-threads` build whose loader requires `new Worker()` for its threadpool, and **workerd has no `Worker` constructor** → not a drop‑in. Mitigations exist (offline class safelist for the owned shadcn components) but it's friction.

**Takeaway:** in‑worker bundling is viable only for small/simple apps and needs Tailwind workarounds. It cannot be the only path. → Use a **native‑toolchain container** as the default; keep in‑worker as an optional fast lane for trivial previews only.

### 3c. Maxed sandbox container (`@cloudflare/sandbox@0.12.0`, instance `standard-4`)
Built the **real RR7 + Vite 8 starter** (`create-worker` template) end‑to‑end:

| Phase | Time |
|---|---|
| Cold container provision (image pre‑pushed, in‑region) | **~3.0s** |
| Warm exec round‑trip | ~125 ms |
| `bun install` — 544 pkgs incl. workerd/miniflare/wrangler (cold, empty cache) | ~8.6s |
| Full RR7 + Vite 8/rolldown build — 117 modules → 1.2 MB output | ~2.9s |
| **Cold total** (provision + install + build) | **~14.5s** |
| **Warm rebuild** (deps cached, container hot) | **~2.9s** |

Cold provision is **~3s, not the 2–3 min** folklore (the image is pre‑built and pushed to CF's registry). The heavy tree that *crashed* the in‑worker bundler builds fine here with native Vite/rolldown. Every failure encountered was a template‑scaffolding placeholder, never the container/toolchain.

### 3d. Direct‑API deploy (no wrangler)
Assembled a worker's multipart upload by hand and `PUT` it to a dispatch‑namespace script via the raw CF API:
- Upload + verify + delete: **~413 ms**, no `wrangler` involved.

**Combined warm deploy ≈ build (2.9s) + upload (0.4s) ≈ 3.3s.**

---

## 4. Project file store — DO + R2

The project filesystem becomes a **per‑project `WorkspaceFilesystemDO`** (`workers/main/src/workspace-filesystem-do.ts`), the same engine already used for the workspace FS:
- Backed by `@cloudflare/shell`'s `Workspace` — SQLite metadata in the DO, blobs in R2 (`R2_BUCKET` → `chiridion-sandbox`), inline under ~1.5 MB / R2 above. Content‑addressed.
- Per‑project instance via `idFromName(projectId)`, `r2Prefix = project-fs/<id>`.
- Full write API already present: `writeFile` / `writeBinaryFile` / `deleteFile` / `mkdir` / `listFiles` (`:112–119`).
- The project FS stores **source only** — never `node_modules` or build output. Those are derived and live only in the build container. This makes "which files to copy for a build" trivially "the whole tree."

Migration source: projects already git‑push to Cloudflare Artifacts, so existing projects can be **hydrated into the new DO from their Artifacts repo** rather than scraped off live VM disks.

The existing `grep`/`find` in the project bridge shell out to the VM; in the new model they become JS implementations over the DO file table (the only net‑new FS code).

---

## 5. Build tier — per‑org warm sandbox containers

### 5a. Sharding model
- **One warm sandbox container per org**, addressed `getSandbox(env.Sandbox, orgId)`, **~5‑min idle TTL**, scale‑to‑zero. "Lambda‑like": warm per active tenant, free otherwise.
- **Cross‑org isolation is hard** (separate DO → separate container). The org is the tenant boundary.
- **Intra‑org sharing is a deliberate trade.** An org's projects share its container, so a malicious npm dep in project P could touch project Q *within the same org* during a build. Acceptable (same trust domain) but state it explicitly and keep hygiene: per‑build workspace dirs, fresh checkout, gVisor/microVM, and an **egress allowlist** (npm registry + nothing else) so a poisoned build can't exfiltrate the org's other source or phone home.
- **Capacity:** size for *peak concurrent active orgs*, not total orgs. `standard-4` (≈4 vCPU / 12 GiB) is heavy to keep warm; if cost bites, warm‑idle on a small instance and burst to `standard-4` only during a build.

### 5b. The build pipeline (server‑issued, not agent bash)
"Block bash" removes the **agent's** open shell — not the build's install step. The build still executes (`bun install`, Vite config, plugins are arbitrary code); it just runs as a **fixed, server‑issued command in an isolated per‑org container**, not an agent‑driven shell against a per‑project VM.

1. Materialize the project's files from DO+R2 → container `/workspace/<projectId>` (reuse existing transfer helpers, `project-runtime-service-vm.ts:285–342`).
2. Exec the fixed pipeline: `bun install && bun run build`.
3. Read the build output back.

The pipeline is **framework‑agnostic** because the project's own `package.json` declares the build: `scripts.build` is `react-router build` for RR7 or esbuild for the lean tier. Same pipeline, different declaration.

### 5c. Dependency management (no agent `bun install`)
- **`node_modules` is never stored** — the project FS holds only `package.json` + `bun.lock`. Install reconstitutes `node_modules` in the container each build (or from the warm container / a shared cache).
- Adding a dep = either (a) the agent edits `package.json` (a DO+R2 file write) and the build's `bun install` reconciles + updates `bun.lock`, or (b) a mediated `addDependency(projectId, pkg)` action runs `bun add` in the warm container and persists `package.json` + `bun.lock` back. Ship (b) as primary, (a) as fallback.
- **Egress allowlist must permit the npm registry** — the one place the isolated container needs outbound network. Install runs arbitrary postinstall, so keep it in the gVisor container with `--ignore-scripts`/`trustedDependencies` policy and registry‑only egress.
- Install errors surface back to the agent as structured output. Within the 5‑min warm window the bun cache makes "add dep + rebuild" closer to the ~2.9s warm rebuild than the ~8.6s cold install.

### 5d. Which files / build scope
- **Project = build root.** A `package.json` with `build` + `deploy` scripts at the project root is the contract; validate it at deploy time and fail fast otherwise.
- **What to copy:** the whole project tree (source‑only by construction), with an ignore set as a safety net (`node_modules`, `build`/`dist`, caches, `.git`, secrets).
- **Finding the deployable output:** the build emits a manifest you read — for RR7, `build/server/wrangler.json` (names `main_module`, bindings, compat date, assets dir) alongside `build/server/index.js` + assets. The lean tier emits the same shape. (`worker-bundler`'s `parseWranglerConfig`/`detectEntryPoint` is the precedent.)
- **Non‑standard layouts:** optional `buildRoot` / `buildCommand` / `outputDir` fields on the project record; 95% use convention.

---

## 6. Deploy — direct dispatch‑namespace API upload

**Key realization:** chiridion is *already* the deploy engine. Today `wrangler` in the VM only (a) runs the build and (b) assembles the multipart upload; chiridion's `cf-api-proxy.ts` then parses it, virtualizes bindings, rewrites the namespace/script name, injects the real token, forwards to `api.cloudflare.com`, and registers it. So "deploy without wrangler" is mostly **chiridion assembling the upload itself from the container's build output**, reusing machinery it already has.

### 6a. Current flow
1. Agent runs `bun run deploy` via `vm.exec` in the per‑project container.
2. `bun run build` (Vite) in the container.
3. `wrangler deploy` → assembles multipart, hits `host.docker.internal:8081/deploy/client/v4` with a **dummy** token.
4. `project-runtime-service` resolves the container by **source IP**, strips `/deploy`, forwards to chiridion with injected identity headers + shared secret.
5. chiridion `cf-api-proxy.ts` (`proxyCloudflareApi`) parses the multipart, **virtualizes bindings** (KV/R2/Assets/AI/DATA_PROXY/CONNECTIONS → service bindings to the main worker), rewrites namespace → `CF_DISPATCH_NAMESPACE` (`chiridion-platform`) and script → `{name}--{orgSlug}`, injects real `Bearer CF_API_TOKEN`, forwards to `api.cloudflare.com`. Assets via Workers Assets (`assets-upload-session` + `/workers/assets/upload`).
6. Post‑deploy (`services/deploy.ts`): `registerWorkerScript`, `APP_KV` access record, tail attach, **screenshot**, preview.
7. Served via dispatcher `DISPATCHER.get(script--orgSlug)`.

### 6b. New flow (no VM, no agent bash, no wrangler CLI)
1. **Trigger** = a chiridion `deploy(projectId)` platform action — *not* a shell command.
2. chiridion materializes project files from DO+R2 into the per‑org warm container.
3. Orchestrator execs the fixed `bun install && bun run build`. *(~2.9s warm, measured)*
4. chiridion reads the build output (`build/server/index.js` + modules + assets, located via the emitted `wrangler.json`).
5. chiridion **assembles the multipart upload itself** and runs the **same** validate/virtualize/rewrite/register pipeline it already has, then `PUT`s directly to the dispatch namespace. *(~0.4s, measured)*
6. Served via dispatcher — **unchanged**.

### 6c. What's deleted vs reused
- **Deleted:** per‑project VM, docker deploy‑proxy (`/deploy/client/v4`, source‑IP resolution, secret/header injection), dummy‑token dance, `wrangler` CLI. That whole credential‑injection apparatus exists *only* because an untrusted CLI needed to deploy without seeing creds; once chiridion builds the upload, it holds the token and never exposes it.
- **Reused (called in‑process, not via HTTP proxy hop):** `cf-api-proxy.ts` binding validation + virtualization + namespace/script rewrite, and `services/deploy.ts` registration. The fiddliest port is **Workers Assets** (`assets-upload-session` + `/workers/assets/upload`) since chiridion currently passes those through rather than originating them — but it already inspects them, so the shape is known.

---

## 7. Security model

| Layer | Property |
|---|---|
| Cross‑org | Hard boundary — separate DO → separate container. |
| Intra‑org | Best‑effort — shared container, per‑build dirs + fresh checkout. Stated trade. |
| Execution | All builds run under **gVisor/microVM**, per‑build CPU/mem/disk caps even when "maxed." |
| Network | **Egress allowlist**: npm registry only. No arbitrary outbound from a build. |
| Credentials | chiridion holds `CF_API_TOKEN`; the container never sees deploy creds. `addDependency`/build get registry access only. |
| Supply chain | `--ignore-scripts` + curated `trustedDependencies`; content‑addressed dep cache shared **read‑only** + integrity‑verified. |

Tool‑level flags (Bun `--ignore-scripts`, per‑build cache/HOME) are **defense‑in‑depth, not a boundary** — `bun run build` is arbitrary code no flag neutralizes, so the OS/container isolation does the real work.

---

## 8. Version history, rollback & git

### 8a. Two stores (not redundant)
- **Working tree** = DO+R2 (`WorkspaceFilesystemDO`) — current mutable files.
- **History** = **Cloudflare Artifacts** (a real git host; smart‑HTTP proxied via `routes/project-runtime-artifacts.ts`; `ARTIFACTS` binding `create`/`get`/`push`; per‑project `artifactRepoName` + `mintProjectArtifactToken()`).

No `.git` is stored inside the project FS. Reasons: a `.git` is thousands of tiny objects (chatty per commit, needs gc/packing), it pollutes the source tree, and the `@cloudflare/shell` store is already a *better* content‑addressed object store. A "commit" is a tiny manifest `{ parent, message, tree: [path → blobHash] }`; because blobs already dedup by hash, a snapshot is near‑free.

### 8b. Auto‑commit — the agent never commits
- **Deploy implies commit — created *after* a successful build.** `deploy()` builds first → persists the updated `bun.lock` back to the FS → commits the *verified* tree → pushes to Artifacts → uploads. Committing after the build (not before) guarantees the SHA points at a tree that reproduces the uploaded bundle; a failed build produces no commit, so `listCommits`/rollback never reference a tree that won't build or won't match its artifact. The SHA is created by the platform — delete the "remember to git commit" instruction (`pi-system-prompt.ts:47`).
- **The commit SHA is the universal version key**, threaded through `registerWorkerScript` (store `commit_sha`), the cached build artifact, and the screenshot. `{commit ↔ artifact ↔ Workers version ↔ screenshot}` all pivot on one ID.
- **Cache the built artifact per SHA** in R2 → **sub‑second rollback** by re‑uploading via the ~0.4s API push (no rebuild). Own this history; don't rely on CF version retention.

### 8c. Where commits happen, by frequency
- **Deploy → always.** The build container is populated by *copying* the source‑only DO tree (§5b) and §8a keeps `.git` out of it, so the container has **no Artifacts remote yet**. The pipeline first gives it a git context — shallow‑clone (or `git init` + wire) the project's Artifacts repo and overlay the materialized tree — then `git add -A && git commit && git push`. (Alternative: skip container git entirely and commit from the DO snapshot layer via isomorphic‑git, §8e.) Either way it's a free ride on the build that just ran.
- **Turn → optional.** Either (simple, one store) push to Artifacts each turn via **isomorphic‑git** in workerd, or (optimized) cheap DO/R2 content‑addressed snapshots per turn, flushed/squashed to Artifacts on deploy. Start simple; add the snapshot layer only if per‑turn pushes get chatty.

### 8d. First‑class functions (not agent tools)
- `listCommits(projectId)` → Artifacts git log + joined deploy/screenshot/version metadata.
- `revertToCommit(projectId, sha)` → read tree@sha → write into DO+R2 → append a "revert to sha" commit → rebuild/redeploy.
- `rollbackDeploy(projectId, sha)` → re‑upload the cached artifact for sha (~0.4s); **site** rolls back, **source and git history untouched** — a hotfix, not a commit.

Keep the two flavors distinct: **roll back the live site** (`rollbackDeploy` — re‑upload the cached artifact; touches neither source nor git history) vs **revert the project** (`revertToCommit` — restore source + redeploy, rewind working state). Only `revertToCommit` is **append‑only**: it writes a new "revert to sha" commit instead of moving HEAD, so you never lose the ability to roll forward. `rollbackDeploy` writes no commit at all.

### 8e. Writing back from Artifacts → DO+R2 (the revert path)
The write‑back is the **easy** half — full Workspace write API + existing transfer helpers (`collectFilesForTransfer`, `writeFileBytesForTransfer`, `deletePathForTransfer`) + `cloneProject` precedent. Two read paths:
- **Container (trivial, for revert‑that‑rebuilds):** `git fetch && git checkout <sha>` in the build container, then reuse transfer helpers to sync `/workspace` → DO+R2. This is today's clone‑from‑Artifacts flow pinned to a SHA.
- **Workerd (no container, for revert‑source‑only):** isomorphic‑git shallow `fetch` + `readTree`/`readBlob` against the Artifacts smart‑HTTP remote, write via `writeBinaryFile`.

**It's a diff, not a dump:** write changed/added, **delete removed** (or stale files linger). Cheap and correct because both sides are content‑addressed — only changed files are touched. Run it inside the project DO so it serializes against concurrent agent edits.

**isomorphic‑git's role** is exactly two spots: container‑less turn‑push and container‑less revert‑read. Container‑git handles deploy commits. It is *not* the per‑commit storage engine (memory‑heavy / chatty for that).

---

## 9. Measured numbers (one table)

| Operation | Measured | Notes |
|---|---|---|
| In‑worker bundle, moderate app | ~3.5s cold | crashes on heavy trees (128 MB ceiling) |
| Container cold provision (`standard-4`, pre‑pushed image) | ~3.0s | warm pool → ~0 |
| Container warm exec round‑trip | ~125 ms | |
| `bun install`, 544 pkgs (cold cache) | ~8.6s | amortizable via baked/shared cache |
| RR7 + Vite 8 build, 117 modules | ~2.9s | native rolldown |
| Direct CF API dispatch‑namespace upload | ~413 ms | no wrangler |
| **Warm deploy total** | **~3.3s** | build + upload |
| **Cold deploy total** | **~14.5s** | install‑dominated |

---

## 10. What changes in the code (seams)

- `workers/main/src/workspace-filesystem-do.ts` — instantiate per **project** (`idFromName(projectId)`, `r2Prefix=project-fs/<id>`); add `grep`/`find` JS impls; add tree‑snapshot/manifest helpers.
- `workers/main/src/project-runtime-service-vm.ts` — replace `ProjectRuntimeServiceVmBridge` with a DO‑FS + per‑org sandbox orchestrator; **keep** the transfer helpers (`:285–342`).
- `workers/main/src/cf-api-proxy.ts` — extract `proxyCloudflareApi`'s virtualize/rewrite into a direct `deployFromBuildOutput(orgId, projectId, modules, assets)`; originate the Workers Assets upload session.
- `workers/main/src/services/deploy.ts` — add `commit_sha` + artifact‑cache key to the deploy record (already the screenshot/registration hook).
- `workers/dispatcher/src/index.ts` — **unchanged** (serving path).
- New platform actions: `deploy`, `addDependency`, `listCommits`, `revertToCommit`, `rollbackDeploy`.
- `pi-system-prompt.ts:47` — remove the manual git/commit instructions and the `vm.exec`/`bash` surface.
- **Retire:** `project-runtime-service` as the per‑project runtime + the docker deploy‑proxy (`/deploy/client/v4`).
- Deps: `@cloudflare/sandbox@0.12.0` (present), instance `standard-4`; `isomorphic-git` (interop edge); `@cloudflare/worker-bundler` only if keeping an in‑worker fast lane.

---

## 11. Migration phases

1. **Project FS → DO+R2.** Per‑project `WorkspaceFilesystemDO`; `grep`/`find` in JS; backfill existing projects from their Artifacts repos. (Independent of build changes.)
2. **Per‑org container build tier.** `@cloudflare/sandbox`, `standard-4`, warm‑per‑org + 5‑min idle, gVisor + egress allowlist + per‑build caps. Materialize from DO+R2, run `bun install && bun run build`.
3. **Direct‑API deploy.** Extract `deployFromBuildOutput`; originate Workers Assets upload; retire the docker deploy‑proxy + in‑VM wrangler.
4. **History & rollback.** Auto‑commit on deploy (container git → Artifacts); `commit_sha` on deploy records; per‑SHA artifact cache; `listCommits`/`revertToCommit`/`rollbackDeploy`; screenshot timeline UI.
5. **Block agent bash.** Remove `vm.exec`/bash tools; ship `deploy`/`addDependency` actions; decommission `project-runtime-service` per‑project containers.
6. **(Optional) in‑worker fast lane** for trivial previews, behind a flag, with the Tailwind class safelist.

---

## 12. Open items & risks

- **Workers Assets origination** without wrangler is the fiddliest deploy piece — prototype first.
- **Capacity/cost** of warm `standard-4` per active org — validate against peak concurrency; consider small‑warm / burst‑build.
- **Cold install (8.6s)** dominates cold deploys — design the baked/shared, read‑only, integrity‑verified dep cache early.
- **Intra‑org build sharing** is an explicit trust decision — document it; keep per‑build isolation + egress allowlist.
- **Vite 8 / rolldown is beta** — the spike hit beta resolution quirks (and template‑placeholder noise); pin versions, watch for fragility on the legacy path.
- **isomorphic‑git** memory/perf on large repos — keep it to shallow fetch / single‑SHA reads; never the hot path.
- **Per‑turn history granularity** — start deploy‑only + optional per‑turn Artifacts; add the DO snapshot layer only if chatty.

---

## 13. Decision matrix

| Situation | Path |
|---|---|
| Any real build (lean Svelte **or** legacy RR7/Vite, native deps) | **Per‑org `standard-4` sandbox container**, native toolchain |
| Trivial preview, want zero container latency | *Optional* in‑worker `worker-bundler` fast lane (flagged) — never for heavy trees |
| Tailwind in‑worker | Avoid; native oxide in the container. If ever needed in‑worker: offline shadcn class safelist |
| Deploy | Build output → `deployFromBuildOutput` → direct CF API dispatch‑namespace upload |
| Roll back the live site (hotfix) | `rollbackDeploy(sha)` — re‑upload cached artifact (~0.4s) |
| Rewind the project to a prior state | `revertToCommit(sha)` — restore source from Artifacts → rebuild → redeploy |
| Add a dependency | `addDependency(pkg)` (mediated `bun add`) or edit `package.json`; container `bun install` reconciles |

---

## 14. Migration (pragmatic) — existing VMs → DO+R2

> Startup reality: quick and dirty. No per‑project state machine, no dual‑read, no
> verification job. Lean on Artifacts as the source of truth and migrate lazily.
> (This is the *data* migration. §11 is the *feature* rollout — complementary.)

The whole thing rests on one cheap move; everything downstream is dumb.

### 14a. One force‑commit sweep (the de‑risker)
A single loop over the runtime service's exec endpoint: for every project with a reachable VM, `git add -A && git commit -m "pre-migration snapshot" && git push`. After this, **Artifacts ≈ truth for the whole fleet**, so you never track per‑project "dirty" state again. Skip VMs that error (archived/abandoned) — they were already pushed or don't matter. Run it with a sane default `.gitignore` so it doesn't capture `node_modules`/build junk.

### 14b. Then it's boring
1. **New projects → DO+R2 once the build tier is live.** Gate the default flip on the per‑org build + direct‑deploy path (§11 Phases 2–3) being shipped — otherwise the legacy `ProjectRuntimeServiceVmBridge` path (VM `/workspace`, `code-mode-tools.ts:2093-2127, 2214-2230`) would see an empty/stale checkout for a DO‑backed project. Until that ships, keep new projects on `vm` or add an interim DO→VM materialization. Once gated, zero migration for anything new.
2. **Existing → lazy hydrate on first open.** When project X is next opened and still `backend: "vm"`: clone its Artifacts repo → write into the per‑project `WorkspaceFilesystemDO` → flip `backend = "do-r2"` → proceed. No background job; projects nobody reopens never get touched.
3. **Pre‑warm top accounts (the human budget).** Proactively hydrate + eyeball your best / most‑active users so they never hit a first‑load edge case. Ignore the long tail.

### 14c. Safety net = one flag
Keep `backend: "vm" | "do-r2"` per project and leave VMs running for a few weeks. If a migrated project looks wrong, flip it back to `vm`. That's the entire rollback story — no dual‑read, no reconcile phase.

### 14d. Kill the tail
After a soak, bulk‑hydrate any remaining projects straight from Artifacts (don't touch VMs), then shut the VM fleet off.

### 14e. Accepted losses (be honest)
- A project **dirtied after the sweep, never pushed, and never reopened** before VM shutdown loses that uncommitted work — abandoned‑and‑unsaved residue, acceptable at startup speed.
- Projects with no/errored Artifacts repo won't lazy‑hydrate — flag them for a manual one‑off pull from the runtime service rather than silently creating a blank project.

**Net:** force‑commit sweep → lazy hydrate‑on‑open from Artifacts → manually warm top users → flag‑flip rollback → bulk‑hydrate stragglers → kill VMs. No new infra beyond the hydrate function + the `backend` flag.

---

*Evidence: all numbers in §3 and §9 measured on the camelAI Cloudflare account (`standard-4` sandbox, `worker-bundler@0.2.1`, `oxide 4.3.0`, RR7+Vite8 `create-worker` starter). Throwaway workers/containers were deployed, measured, and deleted.*
