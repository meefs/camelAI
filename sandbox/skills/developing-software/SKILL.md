---
name: developing-software
description: Build and deploy software with camelAI projects on Cloudflare Workers. Use whenever creating, scaffolding, modifying, building, testing, or deploying an API, website, browser game, fullstack application, internal tool, dashboard, or AI-powered app. Covers create_project template selection, scaffold adaptation, vanilla web apps, React Router, Durable Objects, workspace connections, AI bindings, validation, and deployment.
---

# Developing Software

Read this file completely once per task before the first `create_project` call. Do not reread it during the same task unless the instructions change. Read a reference below with `read_skill({ skill: "developing-software", file: "<filename>" })`; do not use the generic project/workspace file tools for skill files.

## Workflow

1. Choose the template for the dominant user experience.
2. Create the project with a concise description and an explicit `template`.
3. Inspect the seeded files before editing. Treat the scaffold as working architecture, not disposable sample code.
4. Reshape the starter into the requested product. Rename the example entity, schema, routes, actions, validation, and UI copy consistently instead of adding a second implementation beside the demo.
5. In React Router projects, add standard UI through `add_shadcn_component`; do not hand-write components or page shells that the bundled registry provides. In `vanilla` projects, work directly in `public/`.
6. Validate with `build_project` when only a build is requested. Use `deploy_project` directly when publishing because it already builds first.
7. After a successful deployment, call `set_preview`, exercise important flows with `env.BROWSER`, and inspect `logs.pageErrors`. Use a screenshot for visual verification.

Use camelAI project tools for scaffolding, dependencies, builds, and deploys. Do not run `create-worker`, `wrangler init`, `npm create cloudflare`, package-manager deploy commands, or shell-based scaffolding.

## Template Selection

| Template | Choose when |
| --- | --- |
| `crud` | The product is primarily a stateful app, admin tool, tracker, portal, or workflow. This is the default and includes React Router loaders/actions plus Durable Object SQLite CRUD. |
| `vanilla` | The experience is client-only plain HTML/CSS/JavaScript: a small site, landing page, calculator, quiz, interactive demo, or simple DOM/canvas game. Prefer `crud` when it needs accounts, durable server records, a shared leaderboard, or multiplayer state. |
| `ai-chat` | Conversation or direct model interaction is the primary experience. An otherwise stateful app with one AI-assisted feature should normally remain `crud` and add the `AI` binding. |
| `integration-dashboard` | Discovering, monitoring, or operating workspace-connected SaaS/database services is central. If connections only provide business metrics, prefer `data-dashboard`. |
| `data-dashboard` | Users interact with KPIs, filters, charts, tables, exports, or drill-downs. |
| `data-analysis` | The deliverable is a notebook-first, read-only analytical report. Use the `data-analysis` skill and `run_notebook`; do not treat it like a React app. |

For mixed requests, choose the dominant experience and add secondary capabilities. Templates are starting architectures, not feature restrictions: CRUD apps can call AI, AI chats can persist conversations, and data dashboards can query connections. Ask one brief question only when the dominant experience is genuinely unclear and the choice would cause substantial rework.

```ts
await tools.create_project({
  name: "my-app",
  description: "Stateful operations portal for ...",
  template: "crud",
});
```

The React Router templates include SSR, Tailwind v4, Cloudflare deployment metadata, `components.json`, `~/lib/utils`, and common shadcn primitives. Import seeded components from `~/components/ui/*`. The `vanilla` template deliberately has no React, router, Tailwind, or shadcn layer.

## Platform Invariants

- In React Router projects, use framework mode: route `loader`/`action`, `<Form>`, and `useFetcher` instead of client-only fetching in `useEffect`.
- Durable Object SQL is not D1. Use `ctx.storage.sql.exec(sql, ...params)` and cursor methods; never use `.prepare()`, `.bind()`, `.all()`, `.first()`, or `.run()`.
- Keep Durable Object exports, `durable_objects.bindings`, and `migrations.new_sqlite_classes` aligned.
- Use virtual `AI`, `CONNECTIONS`, and R2 bindings; never place connection credentials in source or environment variables.
- Declare every package and build CLI in `package.json`. Add packages with `add_dependency`.
- Preserve the scaffold's build script, deploy-manifest writer, TypeScript strictness, and binding metadata unless the architecture requires a deliberate change.
- Fail loudly on unexpected persistence, binding, or runtime errors. Do not turn failures into empty data.

## Read Only the Relevant Reference

- Call `read_skill({ skill: "developing-software", file: "VANILLA-APPS.md" })` when using the `vanilla` template or building a client-only browser game.
- Call `read_skill({ skill: "developing-software", file: "REACT-ROUTER.md" })` when adding routes, forms, APIs, or UI behavior.
- Call `read_skill({ skill: "developing-software", file: "DURABLE-OBJECTS.md" })` when changing persistence, migrations, instance identity, transactions, or WebSockets.
- Call `read_skill({ skill: "developing-software", file: "AI-APPS.md" })` when adding model calls, chat persistence, agents, tool orchestration, or image generation.
- Call `read_skill({ skill: "developing-software", file: "CONNECTIONS-AND-STORAGE.md" })` when using workspace connections, databases, external providers, uploads, or R2.

Do not load references unrelated to the requested feature.

## Build and Deploy

```ts
// Validation only
await tools.build_project({ project: "my-app" });

// Publishing: deploy_project builds first
await tools.deploy_project({ project: "my-app", script_name: "my-app" });
await tools.set_preview({ app_name: "my-app" });
```

If a build or deploy fails, read the returned error and log excerpt, fix the source, and retry. Never preview or report success for a failed deploy.

For an interactive deployed app:

```ts
const browser = await env.BROWSER.launch({ scriptName: "my-app" });
await browser.click("button");
await browser.waitForText("Saved");
const logs = await browser.logs();
await browser.close();
```

Check the primary flow, persistence across a reload when applicable, empty/error states, and `logs.pageErrors`.
