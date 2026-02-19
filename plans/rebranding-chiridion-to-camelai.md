# Rebranding Plan: Chiridion → camelAI

## Scope

**Change** anything a human end-user or the sandbox agent will see.
**Do NOT change** internal infrastructure, code identifiers, configs, Go code, or anything invisible to both audiences.

- Logo font: **Plus Jakarta Sans, semi-bold (600)**
- New assets: `/Users/illiana/Desktop/camelAI-new-branding/`
- Slack integration: **out of scope** (separate engineer)
- `docs/` and `plans/`: **out of scope** (old documents)

---

## Complete File-by-File Decision Table

153 files contain "chiridion". Every file is listed below with a verdict.

### Legend

- **CHANGE** = file will be modified in this rebrand
- **NO CHANGE** = file will NOT be modified
- **NEW/REPLACE** = file will be replaced with a new asset

---

### Category 1: Logo & Favicon Assets (7 files to replace + 3 starter template files)

These image files don't contain the text "chiridion" but contain the old Chiridion logo and must be replaced.

| File | Verdict | What changes |
|------|---------|-------------|
| `public/favicon.svg` | **REPLACE** | Copy new `favicon.svg` from Desktop |
| `public/favicon.ico` | **REPLACE** | Regenerate from new favicon SVG (16+32 multi-res) |
| `public/favicon-16x16.png` | **REPLACE** | Generate from new favicon SVG at 16x16 |
| `public/favicon-32x32.png` | **REPLACE** | Generate from new favicon SVG at 32x32 |
| `public/apple-touch-icon.png` | **REPLACE** | Generate from `qwaml-in-square-lightmode.svg` at 180x180 |
| `public/android-chrome-192x192.png` | **REPLACE** | Generate from `qwaml-in-square-lightmode.svg` at 192x192 |
| `public/android-chrome-512x512.png` | **REPLACE** | Generate from `qwaml-in-square-lightmode.svg` at 512x512 |
| `sandbox/create-worker/templates/starter/public/favicon.ico` | **REPLACE** | Copy newly generated favicon.ico |
| `sandbox/create-worker/templates/starter/app/welcome/logo-dark.svg` | **REPLACE** | Replace with `camelAI-fullname-logo-darkmode.svg` |
| `sandbox/create-worker/templates/starter/app/welcome/logo-light.svg` | **REPLACE** | Replace with `camelAI-fullname-logo-lightmode.svg` |

**Generation approach:** Use `sharp` (already a bun dependency) or `rsvg-convert` to convert SVG → PNG at each size. Combine 16+32 PNGs into `.ico` using `png-to-ico` or similar. Use `qwaml-in-square-lightmode.svg` (square with background) for the larger app icons since they need a solid background.

---

### Category 2: UI Components & SVG (2 files)

| File | Verdict | What changes |
|------|---------|-------------|
| `src/components/ui/logo.tsx` | **CHANGE** | Replace old house/columns SVG path data with Qwaml camel paths from `qwaml.svg`. Update `viewBox` to `0 0 147 215`. Extract paths with `fill="currentColor"` for theme support. |
| `public/site.webmanifest` | **CHANGE** | `"name": "Chiridion"` → `"name": "camelAI"`, `"short_name": "Chiridion"` → `"short_name": "camelAI"` |

---

### Category 3: User-Facing Page Titles & Meta (42 files)

Every route `meta()` function with `"- Chiridion"` in the title. All are the same pattern: replace `Chiridion` → `camelAI` in the title string.

| File | Verdict | What changes |
|------|---------|-------------|
| `src/root.tsx` | **CHANGE** | `{ title: 'Chiridion' }` → `{ title: 'camelAI' }` |
| `src/routes/_app.chat._index.tsx` | **CHANGE** | `'New Chat - Chiridion'` → `'New Chat - camelAI'` |
| `src/routes/_app.chat.$id.tsx` | **CHANGE** | `` `${title} - Chiridion` `` → `` `${title} - camelAI` `` |
| `src/routes/_app.apps.tsx` | **CHANGE** | `'Apps - Chiridion'` → `'Apps - camelAI'` |
| `src/routes/_app.connections.tsx` | **CHANGE** | `'Connections - Chiridion'` → `'Connections - camelAI'` |
| `src/routes/_app.computer.$workspaceId.tsx` | **CHANGE** | `'Computer - Chiridion'` → `'Computer - camelAI'` |
| `src/routes/_app.history.tsx` | **CHANGE** | `'History - Chiridion'` → `'History - camelAI'` |
| `src/routes/_app.settings.profile.tsx` | **CHANGE** | `'Profile - Settings - Chiridion'` → `'... - camelAI'` |
| `src/routes/_app.settings.organizations.tsx` | **CHANGE** | `'Organizations - Settings - Chiridion'` → `'... - camelAI'` |
| `src/routes/_app.settings.organization.general.tsx` | **CHANGE** | `'Organization General - Settings - Chiridion'` → `'... - camelAI'` |
| `src/routes/_app.settings.organization.team.tsx` | **CHANGE** | `'Team - Settings - Chiridion'` → `'... - camelAI'` |
| `src/routes/_app.settings.organization.billing.tsx` | **CHANGE** | `'Billing - Settings - Chiridion'` → `'... - camelAI'` |
| `src/routes/_app.settings.organization.workspaces.tsx` | **CHANGE** | `'Workspaces - Settings - Chiridion'` → `'... - camelAI'` |
| `src/routes/_app.settings.organization.domains.tsx` | **CHANGE** | `'Domains - Settings - Chiridion'` → `'... - camelAI'` |
| `src/routes/_app.settings.workspace.general.tsx` | **CHANGE** | `'Workspace General - Settings - Chiridion'` → `'... - camelAI'` |
| `src/routes/_app.settings.workspace.connections.tsx` | **CHANGE** | `'Connections - Workspace Settings - Chiridion'` → `'... - camelAI'` |
| `src/routes/_app.settings.workspace.apps.tsx` | **CHANGE** | `'Apps - Workspace Settings - Chiridion'` → `'... - camelAI'` |
| `src/routes/_app.settings.workspace.chats.tsx` | **CHANGE** | `'Chats - Workspace Settings - Chiridion'` → `'... - camelAI'` |
| `src/routes/_auth.login.tsx` | **CHANGE** | `'Sign In - Chiridion'`, `'Sign in to your Chiridion account'` → camelAI |
| `src/routes/_auth.signup.tsx` | **CHANGE** | `'Sign Up - Chiridion'`, `'Create your Chiridion account'` → camelAI |
| `src/routes/_onboarding.welcome.tsx` | **CHANGE** | Title, description, `orgName: 'Chiridion'`, `'Welcome to Chiridion'`, product description prose → camelAI |
| `src/routes/_onboarding.q1.tsx` | **CHANGE** | `'AI Familiarity - Chiridion'` → `'... - camelAI'` |
| `src/routes/_onboarding.q2.tsx` | **CHANGE** | `'Iteration Style - Chiridion'` → `'... - camelAI'` |
| `src/routes/_onboarding.q3.tsx` | **CHANGE** | `'Project Stakes - Chiridion'` → `'... - camelAI'` |
| `src/routes/_onboarding.q4.tsx` | **CHANGE** | `'Design Style - Chiridion'` → `'... - camelAI'` |
| `src/routes/_onboarding.q5.tsx` | **CHANGE** | `'Starter Project - Chiridion'` → `'... - camelAI'` |
| `src/routes/_onboarding.q6.tsx` | **CHANGE** | `'Data Interests - Chiridion'` → `'... - camelAI'` |
| `src/routes/_onboarding.org-slug.tsx` | **CHANGE** | `'Organization URL - Chiridion'` → `'... - camelAI'` |
| `src/routes/invitations.$orgId.$invitationId.tsx` | **CHANGE** | `'Accept Invitation - Chiridion'` and brand name in body text → camelAI |
| `src/routes/_admin._index.tsx` | **CHANGE** | `'Admin Dashboard - Chiridion'` → `'... - camelAI'` |
| `src/routes/_admin.users.tsx` | **CHANGE** | `'Users - Admin - Chiridion'` → `'... - camelAI'` |
| `src/routes/_admin.users.$id.tsx` | **CHANGE** | `'... - Admin - Chiridion'` → `'... - camelAI'` |
| `src/routes/_admin.orgs.tsx` | **CHANGE** | `'Organizations - Admin - Chiridion'` → `'... - camelAI'` |
| `src/routes/_admin.orgs.$id.tsx` | **CHANGE** | `'... - Admin - Chiridion'` → `'... - camelAI'` |
| `src/routes/_admin.orgs.$id.audit-log.tsx` | **CHANGE** | `'Audit Log - ... - Chiridion'` → `'... - camelAI'` |
| `src/routes/_admin.threads.tsx` | **CHANGE** | `'Threads - Admin - Chiridion'` → `'... - camelAI'` |
| `src/routes/_admin.threads.$id.tsx` | **CHANGE** | `'... - Admin - Chiridion'` → `'... - camelAI'` |
| `src/routes/_admin.workspaces.tsx` | **CHANGE** | `'Workspaces - Admin - Chiridion'` → `'... - camelAI'` |
| `src/routes/_admin.workspaces.$id.tsx` | **CHANGE** | `'... - Admin - Chiridion'` → `'... - camelAI'` |
| `src/routes/_admin.workspaces.$id.audit-log.tsx` | **CHANGE** | `'Audit Log - ... - Chiridion'` → `'... - camelAI'` |
| `src/routes/_admin.apps.tsx` | **CHANGE** | `'Apps - Admin - Chiridion'` → `'... - camelAI'` |
| `src/routes/_admin.apps.$scriptName.tsx` | **CHANGE** | `'... - Admin - Chiridion'` → `'... - camelAI'` |
| `src/routes/_admin.invitations.tsx` | **CHANGE** | `'Invitations - Admin - Chiridion'` → `'... - camelAI'` |

---

### Category 4: User-Facing Body Text & UI Strings (10 files)

| File | Verdict | What changes |
|------|---------|-------------|
| `src/components/auth/login-form.tsx` | **CHANGE** | Brand name `Chiridion` in login form heading → `camelAI` |
| `src/components/auth/signup-form.tsx` | **CHANGE** | `Chiridion` heading + `'Get started with Chiridion'` → camelAI |
| `src/components/onboarding/onboarding-layout.tsx` | **CHANGE** | `<span>Chiridion</span>` → `<span>camelAI</span>` |
| `src/components/settings/workspaces-list.tsx` | **CHANGE** | `'A workspace is required to use Chiridion...'` → camelAI |
| `src/components/admin/admin-dashboard.tsx` | **CHANGE** | `'Superuser-only admin surface for Chiridion.'` → camelAI |
| `src/components/chat-file-preview/notebook-preview/report-footer.tsx` | **CHANGE** | `'Rendered by Chiridion'` → `'Rendered by camelAI'` |
| `src/lib/email.server.ts` | **CHANGE** | Email sender name `From: Chiridion`, subject lines `'... on Chiridion'`, `'Verify your email for Chiridion'` → camelAI |
| `src/lib/gmail.server.ts` | **CHANGE** | Email sender name `From: Chiridion` → `From: camelAI` |
| `src/lib/email/templates/email-verification-email.tsx` | **CHANGE** | `'Verify your Chiridion email address'`, `'... in Chiridion.'` → camelAI |
| `src/lib/email/templates/org-invitation-email.tsx` | **CHANGE** | `'... on Chiridion'` in preview and body text → camelAI |
| `workers/dispatcher/src/error-pages.ts` | **CHANGE** | `'... | Chiridion'` in error page `<title>` tag → `'... | camelAI'` |

---

### Category 5: System Message XML Tags (10 files)

The `<chiridion system message>` tag is seen by the sandbox agent. Change to `<camelai system message>` everywhere — all producers, consumers, and regex must update together.

| File | Verdict | What changes |
|------|---------|-------------|
| `src/routes/_onboarding.tsx` | **CHANGE** | `<chiridion system message>` → `<camelai system message>` (tag wrapper around onboarding message) |
| `src/components/Chat.tsx` | **CHANGE** | `<chiridion system message>` → `<camelai system message>` (2 constructions), comment `// Build the chiridion system message` → update |
| `src/components/pages/apps/apps-client.tsx` | **CHANGE** | `<chiridion system message>` → `<camelai system message>`, comment |
| `src/components/pages/connections/connections-client.tsx` | **CHANGE** | `<chiridion system message>` → `<camelai system message>` |
| `src/components/message-bubble.tsx` | **CHANGE** | Regex and comment: `<chiridion system message>` → `<camelai system message>` |
| `src/lib/task-notification.ts` | **CHANGE** | `SYSTEM_MESSAGE_TAG_REGEX`: `<chiridion system message>` → `<camelai system message>` |
| `src/lib/thread-preview.ts` | **CHANGE** | `SYSTEM_MESSAGE_TAG_REGEX`: `<chiridion system message>` → `<camelai system message>` |
| `src/lib/teammate-message.ts` | **CHANGE** | Regex and comment: `<chiridion system message>` → `<camelai system message>` |
| `workers/main/src/durable-objects.ts` | **CHANGE** | `CHIRIDION_SYSTEM_MESSAGE_REGEX` → `CAMELAI_SYSTEM_MESSAGE_REGEX`, regex pattern, and `.map()` wrapper |

**Tests that will break** (must update to match):

| File | Verdict | What changes |
|------|---------|-------------|
| `tests/message-bubble-parsers.test.ts` | **CHANGE** | `<chiridion system message>` in test fixtures → `<camelai system message>` |
| `tests/message-bubble-content-to-string.test.ts` | **CHANGE** | Same |
| `tests/task-notification-parser.test.ts` | **CHANGE** | Same |
| `tests/thread-preview.test.ts` | **CHANGE** | Same, plus test description string |

---

### Category 6: System Prompts & Skills — Agent-Visible (3 files)

| File | Verdict | What changes |
|------|---------|-------------|
| `sandbox/control-plane.mjs` | **CHANGE** | **Product name prose**: "Chiridion" → "camelAI" in all descriptive text (e.g. "You are running inside **Chiridion**", "Chiridion supports 40+ data sources", etc.). **XML tags**: `<chiridion_behavior>` → `<camelai_behavior>`, `<chiridion_context_blocks>` → `<camelai_context_blocks>`. **MCP server name**: `mcpServers.chiridion` → `mcpServers.camelai` (line 950) — agent sees this as `mcp__chiridion__*` tool names. **allowedTools**: `['mcp__chiridion__*']` → `['mcp__camelai__*']` (line 970) — must match MCP server key. **Remove `CHIRIDION_THREAD_ID`**: delete the env var lookup (lines 935-937) and replace with `const proxyThreadId = this.threadId;` — `THREAD_ID` is already set in `mergedEnv` (line 932) with the same value, and the fallback was already `this.threadId`. **Do NOT change**: file paths (`~/.chiridion/`), dispatch namespace (`chiridion`) — these are actual infrastructure references that must match reality. |
| `sandbox/skills/data-analysis/SKILL.md` | **CHANGE** | 4 occurrences of "Chiridion" in prose → "camelAI" (notebook preview, rendering, BigQuery note, MS SQL proxy) |
| `sandbox/skills/file-sharing/SKILL.md` | **CHANGE** | 2 occurrences: `'Chiridion chat interface'`, `'Chiridion's chat interface'` → "camelAI" |

---

### Category 7: Starter Template Text — User-Visible (2 files)

| File | Verdict | What changes |
|------|---------|-------------|
| `sandbox/create-worker/templates/starter/README.md` | **CHANGE** | `'# Chiridion Starter Template'` → `'# camelAI Starter Template'` |
| `sandbox/create-worker/templates/starter/app/routes/home.tsx` | **CHANGE** | `'New Chiridion App'` → `'New camelAI App'`, `'Welcome to your Chiridion app!'` → `'Welcome to your camelAI app!'` |

---

### Category 8: Documentation — Agent-Visible (2 files)

| File | Verdict | What changes |
|------|---------|-------------|
| `AGENTS.md` | **CHANGE** | Rename product name prose "Chiridion" → "camelAI" throughout (title, overview, descriptions). Update `<chiridion system message>` references to `<camelai system message>`. **Keep** infrastructure references that match actual values: `~/.chiridion/`, `x-chiridion-*` headers, `chiridion-{workspaceId}` sandbox names, `chiridion-vm`, `chiridion_errors` dataset — these describe actual current infrastructure. |
| `README.md` | **CHANGE** | `'# Chiridion App'` → `'# camelAI'`, description text |

---

### Category 9: NO CHANGE — Internal Code Identifiers (19 files)

These contain "chiridion" in code identifiers (cookie names, headers, env vars, data attributes, etc.) that no user or agent sees directly.

| File | Reason for NO CHANGE |
|------|---------------------|
| `src/lib/cookies.server.ts` | Cookie name `'chiridion_session_v3'` — internal, browser sends automatically |
| `src/lib/integration-crypto.ts` | Crypto salt `'chiridion-integrations-v1'` — **MUST NOT change** (breaks encrypted data) |
| `src/lib/onboarding.ts` | localStorage key `'chiridion:onboarding:progress'` — internal |
| `src/lib/oauth-config.ts` | User-Agent header `'Chiridion'` — sent to OAuth providers, not seen by end users |
| `src/lib/auth-do.server.ts` | R2 prefix `'chiridion-${orgSafe}-${wsSafe}/'` — internal storage path |
| `src/components/chat-file-preview/notebook-preview/plotly-chart.tsx` | Data attribute `dataset.chiridionNotebookScript` — internal DOM attribute |
| `src/components/chat-file-preview/notebook-preview/vega-lite-chart.tsx` | Data attribute `dataset.chiridionNotebookScript` — internal DOM attribute |
| `src/components/Chat.tsx` *(partial)* | postMessage types `'chiridion:bug-report-request'`/`'chiridion:bug-report-response'` — internal IPC. **Note:** this file also has CHANGE items (system message tags, listed in Category 5) |
| `workers/main/src/cookies.ts` | Cookie names `'chiridion_session_*'` — internal |
| `workers/main/src/mcp-handler.ts` | Header constants `'x-chiridion-*'`, server name `'chiridion-mcp'` — internal |
| `workers/main/src/screenshot-queue.ts` | Data attributes `dataset.chiridionReady`, header `'x-chiridion-screenshot-token'` — internal |
| `workers/main/src/workspace-container.ts` *(partial)* | File path `'/home/claude/.chiridion/integration.env'` — internal infrastructure, stays. **Note:** this file also has a CHANGE item: delete `CHIRIDION_THREAD_ID: options.threadId` (line 287) — paired with the `control-plane.mjs` simplification. See Category 6. |
| `workers/main/src/sandbox-auth.ts` | Domain pattern `*.chiridion.run`, cookie names — internal |
| `workers/main/src/worker-auth.ts` | Cookie names, auth callback path `'/__chiridion_auth/callback'`, screenshot header — internal |
| `workers/main/src/routes/worker-auth.ts` | Auth callback path `'/__chiridion_auth/callback'` — internal |
| `workers/main/src/routes/integrations.ts` | Header reads `'x-chiridion-org-id'`, `'x-chiridion-workspace-id'` — internal |
| `workers/main/src/cf-api-proxy.ts` | Error message mentioning dispatch-namespace — internal developer error |
| `workers/dispatcher/src/error-pages.ts` *(partial)* | `_chiridionMethod`, `_chiridionUrl`, `__chiridionDebugBridge`, old domain patterns, postMessage types — all internal. **Note:** this file also has a CHANGE item (the `<title>` tag, listed in Category 4) |
| `workers/dispatcher/src/index.ts` | Cookie names, auth callback path, file comment, screenshot header — all internal |

---

### Category 10: NO CHANGE — Configuration Files (17 files)

Infrastructure config. Renaming requires creating new Cloudflare/Azure resources. Out of scope.

| File | Reason for NO CHANGE |
|------|---------------------|
| `wrangler.jsonc` | Worker names, R2 buckets, dispatch namespaces, queues, analytics datasets — Cloudflare resources |
| `wrangler.prod.jsonc` | Same |
| `wrangler.staging.jsonc` | Same |
| `wrangler.dev-illiana.jsonc` | Same |
| `wrangler.dev-miguel.jsonc` | Same |
| `wrangler.test.jsonc` | Same |
| `workers/dispatcher/wrangler.jsonc` | Same |
| `workers/dispatcher/wrangler.prod.jsonc` | Same |
| `workers/dispatcher/wrangler.staging.jsonc` | Same |
| `workers/dispatcher/wrangler.dev-illiana.jsonc` | Same |
| `workers/dispatcher/wrangler.dev-miguel.jsonc` | Same |
| `workers/admin-cli/wrangler.jsonc` | Same |
| `workers/user-logs-tail/wrangler.jsonc` | Same |
| `package.json` | npm package name `'chiridion-app'` — internal |
| `workers/dispatcher/package.json` | npm package name — internal |
| `workers/user-logs-tail/package.json` | npm package name — internal |
| `cloudflare-env.d.ts` | Comment `/* chiridion-app */` — internal |

---

### Category 11: NO CHANGE — Go Sandbox-Host (10 files)

Infrastructure code. Requires coordinated deployment with VM. Out of scope.

| File | Reason for NO CHANGE |
|------|---------------------|
| `services/sandbox-host/go.mod` | Go module path — infrastructure |
| `services/sandbox-host/cmd/sandbox-host/main.go` | Go imports — infrastructure |
| `services/sandbox-host/internal/app/server.go` | Go imports, header stripping, container name prefix — infrastructure |
| `services/sandbox-host/internal/app/server_test.go` | Go test fixtures — infrastructure |
| `services/sandbox-host/internal/app/config.go` | Header name constants — infrastructure |
| `services/sandbox-host/internal/container/manager.go` | Docker image name, env file path, imports — infrastructure |
| `services/sandbox-host/internal/workspace/workspace.go` | XFS project quota manager — infrastructure |
| `services/sandbox-host/Dockerfile.sandbox` | Container paths `/opt/chiridion/` — infrastructure |
| `services/sandbox-host/README.md` | Internal dev documentation — infrastructure |
| `services/sandbox-host/scripts/setup-host.sh` | systemd services, binary paths, firewall scripts — infrastructure |
| `services/sandbox-host/scripts/migrate-to-overlay.sh` | systemd service name — infrastructure |

---

### Category 12: NO CHANGE — Infrastructure & DevOps (7 files)

| File | Reason for NO CHANGE |
|------|---------------------|
| `infra/main.tf` | Azure resource names, PostgreSQL username — infrastructure |
| `infra/variables.tf` | Terraform defaults — infrastructure |
| `infra/terraform.tfvars.example` | Terraform example values — infrastructure |
| `infra/cloud-init.yaml.tpl` | VM setup paths — infrastructure |
| `scripts/dev-sandbox-host.mjs` | Docker image name default — infrastructure |
| `.codex/environments/environment.toml` | Codex environment name — internal tooling |
| `playwright.config.ts` | Default base URL with old worker domain — internal test config |

---

### Category 13: NO CHANGE — Sandbox Internals (4 files)

File paths and code in the sandbox that reference actual `~/.chiridion/` directory. Changing these would require migration logic (symlinks, Dockerfile changes). Out of scope since we're not changing the Go sandbox-host or Dockerfile.

| File | Reason for NO CHANGE |
|------|---------------------|
| `sandbox/memory-logger.mjs` | File path constants `~/.chiridion/memory/`, `~/.chiridion/profile.md` — actual paths |
| `sandbox/entrypoint.sh` | Container path `/opt/chiridion/control-plane.mjs` — actual Docker path |
| `sandbox/session-search/src/db.mjs` | Directory path `homedir()/.chiridion` — actual path |
| `sandbox/create-worker/templates/starter/package.json` | Deploy command `--dispatch-namespace chiridion` — actual Cloudflare resource |
| `src/routes/api/onboarding.complete.ts` | File path `'/home/claude/.chiridion/profile.md'` — actual path written to sandbox |

---

### Category 14: NO CHANGE — Lockfiles (2 files)

| File | Reason for NO CHANGE |
|------|---------------------|
| `bun.lock` | Auto-generated from package.json — will update when package.json changes |
| `workers/user-logs-tail/bun.lock` | Same |

---

### Category 15: NO CHANGE — Old Docs & Plans (6 files)

| File | Reason for NO CHANGE |
|------|---------------------|
| `docs/notebook-export-downloads.md` | Old document — out of scope |
| `docs/notebook-renderer-restyle.md` | Old document — out of scope |
| `docs/notebook-renderer-feedback.md` | Old document — out of scope |
| `docs/recent-chats-welcome-screen.md` | Old document — out of scope |
| `plans/PLAN-task-notification-styling.md` | Old plan — out of scope |
| `plans/mcp-tool-call-styling.md` | Old plan — out of scope |
| `plans/rebranding-chiridion-to-camelai.md` | This plan itself. No change |

---

### Category 16: NO CHANGE — Slack (out of scope) (2 files)

| File | Reason for NO CHANGE |
|------|---------------------|
| `slack-app-manifest.json` | Slack integration handled by separate engineer |
| `slack-app-manifest.yaml` | Same |

---

### Category 17: NO CHANGE — Tests for Unchanged Code (5 files)

Tests that reference "chiridion" in contexts we are NOT changing (cookie names, data attributes, headers).

| File | Reason for NO CHANGE |
|------|---------------------|
| `tests/plotly-chart-loader.test.tsx` | Tests `data-chiridion-notebook-script` selector — data attribute not changing |
| `tests/vega-lite-chart-loader.test.tsx` | Same |
| `workers/main/tests/websocket-access.test.ts` | Tests `'X-Chiridion-Session-Id'` header — headers not changing |
| `e2e/invitation.spec.ts` | Tests `'chiridion_session_v2'` cookie — cookies not changing |
| `workers/admin-cli/cli.mjs` | Internal admin CLI text — internal tooling |

---

### Category 18: NO CHANGE — Mock files (1 file)

| File | Reason for NO CHANGE |
|------|---------------------|
| `workers/main/src/__mocks__/mcp-handler.ts` | Mock for tests — no "chiridion" found in grep |
| `workers/main/src/index.ts` | Comment `Main Chiridion Worker` + export `ChiridionMcp` — internal code identifier |
| `workers/admin-cli/src/index.ts` | No chiridion matches in actual code |
| `workers/dispatcher/src/debug-bridge.txt` | Covered by error-pages.ts — internal |

---

## Summary Counts

| Category | Files | Verdict |
|----------|-------|---------|
| Logo & favicon assets | 10 | **REPLACE** |
| UI components & SVG | 2 | **CHANGE** |
| Page titles & meta | 42 | **CHANGE** |
| Body text & UI strings | 10 | **CHANGE** |
| System message XML tags | 9 source + 4 tests = 13 | **CHANGE** |
| System prompts & skills | 3 | **CHANGE** |
| Starter template text | 2 | **CHANGE** |
| Documentation | 2 | **CHANGE** |
| **Total CHANGE** | **~84** | |
| Internal code identifiers | 19 | NO CHANGE |
| Configuration files | 17 | NO CHANGE |
| Go sandbox-host | 11 | NO CHANGE |
| Infrastructure & DevOps | 7 | NO CHANGE |
| Sandbox internal paths | 5 | NO CHANGE |
| Lockfiles | 2 | NO CHANGE |
| Old docs & plans | 7 | NO CHANGE |
| Slack | 2 | NO CHANGE |
| Tests for unchanged code | 5 | NO CHANGE |
| Misc internal | 4 | NO CHANGE |
| **Total NO CHANGE** | **~79** | |

---

## Execution Order

### Phase 1: Asset Generation
1. Copy `favicon.svg` from Desktop to `public/favicon.svg`
2. Generate PNGs from SVGs at required sizes (16, 32, 180, 192, 512)
3. Generate `favicon.ico` from 16+32 PNGs
4. Replace starter template logos (`logo-dark.svg`, `logo-light.svg`, `favicon.ico`)

### Phase 2: Logo Component & Manifest
5. Update `src/components/ui/logo.tsx` — replace SVG path data with Qwaml camel
6. Update `public/site.webmanifest` — name and short_name

### Phase 3: System Message Tag Rename (coordinated — all at once)
7. Rename `<chiridion system message>` → `<camelai system message>` in all 9 source files + 4 test files simultaneously:
   - Producers: `Chat.tsx`, `apps-client.tsx`, `connections-client.tsx`, `_onboarding.tsx`, `durable-objects.ts`
   - Consumers: `task-notification.ts`, `thread-preview.ts`, `teammate-message.ts`, `message-bubble.tsx`
   - Tests: `message-bubble-parsers.test.ts`, `message-bubble-content-to-string.test.ts`, `task-notification-parser.test.ts`, `thread-preview.test.ts`

### Phase 4: System Prompts, Skills & Agent-Visible Config
8. Update `sandbox/control-plane.mjs`:
   - Product name prose: "Chiridion" → "camelAI"
   - XML tag names: `<chiridion_behavior>` → `<camelai_behavior>`, `<chiridion_context_blocks>` → `<camelai_context_blocks>`
   - MCP server name: `mcpServers.chiridion` → `mcpServers.camelai`
   - allowedTools: `['mcp__chiridion__*']` → `['mcp__camelai__*']`
   - Remove `CHIRIDION_THREAD_ID` lookup (lines 935-937), replace with `const proxyThreadId = this.threadId;`
   - Keep infrastructure refs as-is (`~/.chiridion/`, dispatch namespace)
9. Update `workers/main/src/workspace-container.ts` — delete `CHIRIDION_THREAD_ID: options.threadId` (line 287)
10. Update `sandbox/skills/data-analysis/SKILL.md` — 4 prose replacements
11. Update `sandbox/skills/file-sharing/SKILL.md` — 2 prose replacements

### Phase 5: All Page Titles (bulk find-and-replace)
12. Replace `Chiridion` → `camelAI` in `meta()` title strings across all 42 route files
    - This is a simple find-and-replace: `- Chiridion` → `- camelAI` in meta title strings

### Phase 6: UI Text & Email Templates
13. Update login/signup forms (`login-form.tsx`, `signup-form.tsx`)
14. Update onboarding (`onboarding-layout.tsx`, `_onboarding.welcome.tsx`)
15. Update email templates (`email.server.ts`, `gmail.server.ts`, `email-verification-email.tsx`, `org-invitation-email.tsx`)
16. Update misc UI text (`workspaces-list.tsx`, `admin-dashboard.tsx`, `report-footer.tsx`)
17. Update invitation page (`invitations.$orgId.$invitationId.tsx`)
18. Update dispatcher error page title (`error-pages.ts`)

### Phase 7: Starter Template Text
19. Update `sandbox/create-worker/templates/starter/README.md`
20. Update `sandbox/create-worker/templates/starter/app/routes/home.tsx`

### Phase 8: Documentation
21. Update `AGENTS.md` — product name prose (keep infrastructure refs accurate)
22. Update `README.md`

### Phase 9: Verification
23. Run `bun run test` — verify system message tag tests pass
24. Run `bun run build` — verify clean build
25. Grep for remaining user-facing "Chiridion" to catch any stragglers

---

## Key Decisions Embedded in This Plan

1. **File paths stay as `~/.chiridion/`** — changing requires Dockerfile + Go + migration. The system prompt will keep referencing the actual paths.
2. **Dispatch namespace stays as `chiridion`** — actual Cloudflare resource. Deploy commands reference the real namespace.
3. **Crypto salt MUST NOT change** — would break all existing encrypted integration credentials.
4. **No cookie migration** — users see the app name, not cookie names.
5. **System message tags DO change** — the agent receives these, so they're agent-facing.
6. **Tests updated only where our changes break them** — system message tag tests. All other test files left alone.
7. **MCP server name + allowedTools DO change** — the agent sees MCP tools as `mcp__chiridion__*`; both the key in `mcpServers` and the `allowedTools` pattern are local to `control-plane.mjs`.
8. **`CHIRIDION_THREAD_ID` env var removed entirely** — rather than renaming to `CAMELAI_THREAD_ID`, we simplify: `THREAD_ID` (already in `mergedEnv`) carries the same value, and the fallback was already `this.threadId`. The setter in `workspace-container.ts` and the reader in `control-plane.mjs` are the only two references. Both deploy together with the rest of the sandbox changes.
