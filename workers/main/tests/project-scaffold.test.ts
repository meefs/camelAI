import { describe, expect, it } from "vitest";

import { defaultProjectScaffoldFiles, normalizeProjectScaffoldTemplate } from "../src/project-scaffold";

function scaffoldFile(files: Array<{ path: string; content: string }>, path: string): string {
  const file = files.find((candidate) => candidate.path === path);
  if (!file) throw new Error(`Missing scaffold file ${path}`);
  return file.content;
}

describe("normalizeProjectScaffoldTemplate", () => {
  it("defaults to CRUD while preserving explicit templates", () => {
    expect(normalizeProjectScaffoldTemplate(undefined)).toBe("crud");
    expect(normalizeProjectScaffoldTemplate(null)).toBe("crud");
    expect(normalizeProjectScaffoldTemplate("")).toBe("crud");
    expect(normalizeProjectScaffoldTemplate("crud")).toBe("crud");
    expect(normalizeProjectScaffoldTemplate("vanilla")).toBe("vanilla");
    expect(normalizeProjectScaffoldTemplate("ai-chat")).toBe("ai-chat");
    expect(normalizeProjectScaffoldTemplate("integration-dashboard")).toBe("integration-dashboard");
    expect(normalizeProjectScaffoldTemplate("data-dashboard")).toBe("data-dashboard");
    expect(normalizeProjectScaffoldTemplate("data-analysis")).toBe("data-analysis");
  });

  it("rejects removed and unknown templates", () => {
    expect(() => normalizeProjectScaffoldTemplate("react-router")).toThrow(/crud.*vanilla.*ai-chat.*integration-dashboard.*data-dashboard.*data-analysis/);
    expect(() => normalizeProjectScaffoldTemplate("worker")).toThrow(/crud.*vanilla.*ai-chat.*integration-dashboard.*data-dashboard.*data-analysis/);
    expect(() => normalizeProjectScaffoldTemplate("api")).toThrow(/crud.*data-analysis/);
  });
});

describe("defaultProjectScaffoldFiles", () => {
  it("generates the default stateful CRUD scaffold", () => {
    const files = defaultProjectScaffoldFiles("Demo App", "crud", "demo-app");
    const wrangler = JSON.parse(scaffoldFile(files, "/wrangler.jsonc"));
    const readme = scaffoldFile(files, "/README.md");

    expect(wrangler.durable_objects.bindings).toContainEqual({ name: "ITEMS", class_name: "ItemStore" });
    expect(wrangler.migrations).toContainEqual({ tag: "v1", new_sqlite_classes: ["ItemStore"] });
    expect(scaffoldFile(files, "/workers/item-store.ts")).toContain("CREATE TABLE IF NOT EXISTS items");
    expect(scaffoldFile(files, "/workers/item-store.ts")).toContain("this.ctx.storage.sql.exec");
    expect(scaffoldFile(files, "/workers/app.ts")).toContain('export { ItemStore }');
    expect(scaffoldFile(files, "/app/routes/home.tsx")).toContain("export async function loader");
    expect(scaffoldFile(files, "/app/routes/home.tsx")).toContain("export async function action");
    expect(scaffoldFile(files, "/app/routes/home.tsx")).toContain("Durable CRUD starter");
    expect(readme).toContain('deploy_project({ project: "<project>" })');
    expect(readme).toContain("return the live URL, and open the app in preview");
    expect(readme).toContain("dry_run: true");
    expect(readme).toContain("hidden `build_project` name is compatibility-only");
    expect(readme).toContain("`set_preview` remains available for an explicit preview switch");
  });

  it("generates the specialized web scaffolds", () => {
    const vanilla = defaultProjectScaffoldFiles("Tiny Game", "vanilla", "tiny-game");
    expect(JSON.parse(scaffoldFile(vanilla, "/package.json"))).toMatchObject({
      scripts: { build: "node ./scripts/build.mjs" },
      devDependencies: { wrangler: expect.any(String) },
    });
    expect(JSON.parse(scaffoldFile(vanilla, "/package.json"))).not.toHaveProperty("dependencies");
    expect(scaffoldFile(vanilla, "/public/index.html")).toContain("Vanilla web starter");
    expect(scaffoldFile(vanilla, "/public/index.html")).toContain('src="/main.js"');
    expect(scaffoldFile(vanilla, "/worker.js")).toContain("env.ASSETS.fetch");
    expect(scaffoldFile(vanilla, "/scripts/build.mjs")).toContain('cpSync("public", "build/client"');
    expect(vanilla.map((file) => file.path)).not.toContain("/app/root.tsx");
    expect(vanilla.map((file) => file.path)).not.toContain("/components.json");

    const ai = defaultProjectScaffoldFiles("AI App", "ai-chat", "ai-app");
    expect(JSON.parse(scaffoldFile(ai, "/wrangler.jsonc")).ai).toEqual({ binding: "AI" });
    expect(scaffoldFile(ai, "/app/routes/home.tsx")).toContain('AI.run("auto"');

    const integrations = defaultProjectScaffoldFiles("Connected App", "integration-dashboard", "connected-app");
    expect(scaffoldFile(integrations, "/workers/app.ts")).toContain("CONNECTIONS: ConnectionsBinding");
    expect(scaffoldFile(integrations, "/app/routes/home.tsx")).toContain("env.CONNECTIONS.methods()");

    const dashboard = defaultProjectScaffoldFiles("Metrics", "data-dashboard", "metrics");
    expect(JSON.parse(scaffoldFile(dashboard, "/package.json")).dependencies.recharts).toBeDefined();
    expect(scaffoldFile(dashboard, "/app/components/ui/chart.tsx")).toContain("ChartContainer");
    expect(scaffoldFile(dashboard, "/app/routes/home.tsx")).toContain("<BarChart");
  });

  it("generates the shared React Router Tailwind/shadcn foundation", () => {
    const files = defaultProjectScaffoldFiles("Demo App", "crud", "demo-app");

    expect(files.map((file) => file.path)).toEqual(expect.arrayContaining([
      "/package.json",
      "/wrangler.jsonc",
      "/vite.config.ts",
      "/react-router.config.ts",
      "/components.json",
      "/app/app.css",
      "/app/lib/utils.ts",
      "/app/components/ui/button.tsx",
      "/app/components/ui/card.tsx",
      "/app/components/ui/badge.tsx",
      "/app/components/ui/checkbox.tsx",
      "/app/components/ui/dialog.tsx",
      "/app/components/ui/dropdown-menu.tsx",
      "/app/components/ui/input.tsx",
      "/app/components/ui/label.tsx",
      "/app/components/ui/select.tsx",
      "/app/components/ui/separator.tsx",
      "/app/components/ui/skeleton.tsx",
      "/app/components/ui/table.tsx",
      "/app/components/ui/textarea.tsx",
      "/app/root.tsx",
      "/app/routes.ts",
      "/app/routes/home.tsx",
      "/app/entry.server.tsx",
      "/workers/app.ts",
      "/public/robots.txt",
      "/public/favicon.svg",
      "/public/og-image.svg",
      "/scripts/build-manifest.mjs",
      "/README.md",
    ]));

    const packageJson = JSON.parse(scaffoldFile(files, "/package.json"));
    expect(packageJson).toMatchObject({
      type: "module",
      scripts: {
        dev: "react-router dev",
        build: "react-router typegen && tsc --noEmit && react-router build && node ./scripts/build-manifest.mjs",
        typecheck: "react-router typegen && tsc --noEmit",
      },
      dependencies: {
        react: expect.any(String),
        "react-dom": expect.any(String),
        "react-router": expect.any(String),
        "class-variance-authority": expect.any(String),
        clsx: expect.any(String),
        "tailwind-merge": expect.any(String),
        "lucide-react": expect.any(String),
        "radix-ui": expect.any(String),
        "tw-animate-css": expect.any(String),
      },
      devDependencies: {
        "@react-router/dev": expect.any(String),
        "@tailwindcss/vite": expect.any(String),
        esbuild: expect.any(String),
        tailwindcss: expect.any(String),
        vite: expect.any(String),
        wrangler: expect.any(String),
      },
    });
    expect(packageJson.devDependencies).not.toHaveProperty("vite-tsconfig-paths");

    expect(scaffoldFile(files, "/wrangler.jsonc")).toContain('"main": "./workers/app.ts"');
    expect(scaffoldFile(files, "/react-router.config.ts")).toContain("v8_middleware: false");
    expect(scaffoldFile(files, "/react-router.config.ts")).not.toContain("v8_middleware: true");
    expect(scaffoldFile(files, "/vite.config.ts")).toContain("tailwindcss()");
    expect(scaffoldFile(files, "/vite.config.ts")).toContain('command === "serve"');
    expect(scaffoldFile(files, "/vite.config.ts")).not.toContain("vite-tsconfig-paths");
    expect(scaffoldFile(files, "/vite.config.ts")).not.toContain("tsconfigPaths()");
    expect(scaffoldFile(files, "/vite.config.ts")).toContain("noExternal: true");
    expect(scaffoldFile(files, "/components.json")).toContain('"ui": "~/components/ui"');
    expect(scaffoldFile(files, "/app/app.css")).toContain('@import "tailwindcss"');
    expect(scaffoldFile(files, "/app/app.css")).toContain('@source "./**/*.{ts,tsx}"');
    expect(scaffoldFile(files, "/app/app.css")).toContain("--color-background");
    expect(scaffoldFile(files, "/app/lib/utils.ts")).toContain("twMerge(clsx(inputs))");
    expect(scaffoldFile(files, "/app/components/ui/button.tsx")).toContain("buttonVariants");
    expect(scaffoldFile(files, "/app/components/ui/button.tsx")).toContain('from "radix-ui"');
    expect(scaffoldFile(files, "/app/components/ui/button.tsx")).toContain('from "~/lib/utils"');
    // Seeded components must not import npm packages outside the scaffold deps.
    const seededUiFiles = files.filter((file) => file.path.startsWith("/app/components/ui/"));
    expect(seededUiFiles.length).toBeGreaterThanOrEqual(13);
    const packageDeps = new Set([
      ...Object.keys(packageJson.dependencies),
      "react",
      "react-dom",
    ]);
    for (const file of seededUiFiles) {
      for (const match of file.content.matchAll(/from "([^".~][^"]*)"/g)) {
        const spec = match[1];
        const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
        expect(packageDeps.has(pkg), `${file.path} imports ${pkg} which is not a scaffold dependency`).toBe(true);
      }
    }
    expect(scaffoldFile(files, "/app/routes/home.tsx")).toContain("Durable CRUD starter");
    expect(scaffoldFile(files, "/app/root.tsx")).toContain('import "./app.css"');
    expect(scaffoldFile(files, "/app/entry.server.tsx")).toContain('from "react-dom/server.edge"');
    expect(scaffoldFile(files, "/app/entry.server.tsx")).not.toContain('from "react-dom/server";');
    // handleError surfaces loader/action/render errors to console.error so they
    // reach the worker log tail pipeline instead of being swallowed by ErrorBoundary.
    expect(scaffoldFile(files, "/app/entry.server.tsx")).toContain("export function handleError");
    expect(scaffoldFile(files, "/workers/app.ts")).toContain("createRequestHandler");
    expect(scaffoldFile(files, "/workers/app.ts")).toContain("env.ASSETS.fetch(request)");
    expect(scaffoldFile(files, "/workers/app.ts")).toContain('method !== "GET" && method !== "HEAD"');
    expect(scaffoldFile(files, "/scripts/build-manifest.mjs")).toContain('main: "worker.js"');
    expect(scaffoldFile(files, "/scripts/build-manifest.mjs")).toContain("node_modules/.bin/esbuild");
    expect(scaffoldFile(files, "/scripts/build-manifest.mjs")).toContain("env.ASSETS.fetch(request)");
    expect(scaffoldFile(files, "/scripts/build-manifest.mjs")).toContain('method !== "GET" && method !== "HEAD"');
    expect(scaffoldFile(files, "/README.md")).toContain("bunx --bun shadcn@latest add <component> --yes");
    expect(scaffoldFile(files, "/README.md")).toContain("add_shadcn_component");

    // When wrangler.jsonc sets main (the scaffold default), the build must bundle that
    // module as the worker entry so agent-added exports (Durable Object classes) survive.
    const buildManifest = scaffoldFile(files, "/scripts/build-manifest.mjs");
    expect(buildManifest).toContain("if (config.main) {");
    expect(buildManifest).toContain("config.main,");
    expect(buildManifest).toContain("--alias:virtual:react-router/server-build=./build/server/index.js");
    expect(buildManifest).toContain('--define:import.meta.env.MODE="production"');

    // The manifest is a wrangler-valid config describing the FINAL build output:
    // no_bundle with an ESModule rule so the deploy pipeline selects modules by
    // rule globs, and vars/durable_objects/migrations/kv/r2/ai/bindings passed
    // through as-is (project-worker-bundle lifts them into API bindings server-side).
    expect(buildManifest).toContain("no_bundle: true");
    expect(buildManifest).toContain('rules: [{ type: "ESModule", globs: ["**/*.js", "**/*.mjs"] }]');
    expect(buildManifest).toContain("...(config.durable_objects ? { durable_objects: config.durable_objects } : {})");
    expect(buildManifest).toContain("...(config.migrations ? { migrations: config.migrations } : {})");
    expect(buildManifest).toContain("...(config.kv_namespaces ? { kv_namespaces: config.kv_namespaces } : {})");
    expect(buildManifest).toContain("...(config.r2_buckets ? { r2_buckets: config.r2_buckets } : {})");
    expect(buildManifest).toContain("...(config.ai ? { ai: config.ai } : {})");
    // vars and bindings are forwarded unchanged — the template no longer inline-lifts
    // vars into plain_text/json env-var bindings (that moved to project-worker-bundle).
    expect(buildManifest).toContain("...(config.vars ? { vars: config.vars } : {})");
    expect(buildManifest).toContain("...(config.bindings ? { bindings: config.bindings } : {})");
    expect(buildManifest).not.toContain('{ type: "plain_text", name, text: value }');
    expect(buildManifest).not.toContain("varBindings");

    // The generated build step should not infer Durable Object validity from
    // config history. Deploy-time validation checks actual current bindings
    // against the bundled module exports and produces the actionable error.
    expect(buildManifest).not.toContain("declares Durable Objects but no main worker module exports their classes");
    expect(buildManifest).not.toContain("process.exit(1)");
  });

  it("generates the notebook-first data-analysis scaffold", () => {
    const files = defaultProjectScaffoldFiles("Demo App", "data-analysis", "demo-app");

    expect(files.map((file) => file.path)).toEqual(["/analysis.ipynb", "/README.md"]);

    // Data-analysis projects are notebook deliverables, not deployable apps: no
    // package.json/wrangler config means build_project/deploy_project fail loudly.
    expect(files.map((file) => file.path)).not.toContain("/package.json");
    expect(files.map((file) => file.path)).not.toContain("/wrangler.jsonc");

    const notebook = JSON.parse(scaffoldFile(files, "/analysis.ipynb"));
    expect(notebook.nbformat).toBe(4);
    expect(notebook.metadata.kernelspec.language).toBe("python");
    for (const cell of notebook.cells) {
      expect(typeof cell.id).toBe("string");
      expect(["markdown", "code"]).toContain(cell.cell_type);
    }

    // Report-mode structure: a single `#` title with subtitle paragraph, `##`
    // sections, and a Key Findings section.
    const markdown = notebook.cells
      .filter((cell: { cell_type: string }) => cell.cell_type === "markdown")
      .map((cell: { source: string[] }) => cell.source.join(""))
      .join("\n");
    expect(markdown).toContain("# Demo App");
    expect(markdown).toContain("## Data");
    expect(markdown).toContain("## Key Findings");

    // The example chart carries a pre-rendered Vega-Lite output so the notebook
    // previews with a themed chart before any execution happens.
    const chartCell = notebook.cells.find((cell: { id: string }) => cell.id === "example-chart");
    expect(chartCell.source.join("")).toContain("alt.Chart(data)");
    const chartOutput = chartCell.outputs[0];
    expect(chartOutput.output_type).toBe("execute_result");
    const spec = chartOutput.data["application/vnd.vegalite.v5+json"];
    expect(spec.mark).toBe("bar");
    expect(spec.data.values.length).toBeGreaterThan(0);

    const readme = scaffoldFile(files, "/README.md");
    expect(readme).toContain("# Demo App");
    expect(readme).toContain("Report mode");
    expect(readme).toContain("set_preview");
    expect(readme).toContain('"application/x-ipynb+json"');
    expect(readme).toContain("no build step");
    expect(readme).toContain("deploy_project");
    expect(readme).toContain("opens it in preview automatically");
    expect(readme).toContain("No manual `set_preview` or `list_apps` call is needed");
    expect(readme).toContain("`set_preview` remains available for an explicit preview switch");
  });
});
