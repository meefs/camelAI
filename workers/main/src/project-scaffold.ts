import { SHADCN_NPM_PACKAGE_VERSIONS, SHADCN_REGISTRY } from "./shadcn-registry.generated";

export type ProjectScaffoldTemplate =
  | "crud"
  | "vanilla"
  | "ai-chat"
  | "integration-dashboard"
  | "data-dashboard"
  | "data-analysis";

export const PROJECT_SCAFFOLD_TEMPLATES: readonly ProjectScaffoldTemplate[] = [
  "crud",
  "vanilla",
  "ai-chat",
  "integration-dashboard",
  "data-dashboard",
  "data-analysis",
];

// UI primitives pre-seeded into every React Router scaffold, sourced from the
// generated shadcn registry so seeded files and add_shadcn_component output
// stay identical. Keep this to the high-frequency primitives; everything else
// is one add_shadcn_component call away.
export const SEEDED_SHADCN_COMPONENTS = [
  "badge",
  "button",
  "card",
  "checkbox",
  "dialog",
  "dropdown-menu",
  "input",
  "label",
  "select",
  "separator",
  "skeleton",
  "table",
  "textarea",
] as const;

function seededShadcnScaffoldFiles(): ProjectScaffoldFile[] {
  const files: ProjectScaffoldFile[] = [];
  const seen = new Set<string>();
  const queue: string[] = [...SEEDED_SHADCN_COMPONENTS];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const item = SHADCN_REGISTRY[name];
    if (!item) {
      throw new Error(`Seeded shadcn component "${name}" is missing from shadcn-registry.generated.ts`);
    }
    queue.push(...item.registryDependencies);
    for (const file of item.files) {
      files.push({ path: file.path, content: file.content });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export interface ProjectScaffoldFile {
  path: string;
  content: string;
}

export interface ProjectScaffoldResult {
  template: ProjectScaffoldTemplate;
  filesWritten: string[];
  filesSkipped: string[];
}

export function normalizeProjectScaffoldTemplate(value: unknown): ProjectScaffoldTemplate {
  if (value === undefined || value === null || value === "") return "crud";
  if (PROJECT_SCAFFOLD_TEMPLATES.includes(value as ProjectScaffoldTemplate)) {
    return value as ProjectScaffoldTemplate;
  }
  throw new Error(`template must be one of: ${PROJECT_SCAFFOLD_TEMPLATES.join(", ")}`);
}

function scaffoldPackageName(projectName: string): string {
  return projectName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "camelai-project";
}

function escapeXmlText(value: string): string {
  const escapes: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  };
  return value.replace(/[&<>"']/g, (char) => escapes[char] ?? char);
}

interface NotebookCodeCellOutput {
  output_type: "execute_result";
  execution_count: number;
  data: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

function markdownCell(id: string, lines: string[]): Record<string, unknown> {
  return {
    cell_type: "markdown",
    id,
    metadata: {},
    source: lines.map((line, index) => (index < lines.length - 1 ? `${line}\n` : line)),
  };
}

function codeCell(
  id: string,
  lines: string[],
  options: { executionCount?: number; outputs?: NotebookCodeCellOutput[] } = {},
): Record<string, unknown> {
  return {
    cell_type: "code",
    id,
    metadata: {},
    execution_count: options.executionCount ?? null,
    outputs: options.outputs ?? [],
    source: lines.map((line, index) => (index < lines.length - 1 ? `${line}\n` : line)),
  };
}

function defaultDataAnalysisScaffoldFiles(projectName: string): ProjectScaffoldFile[] {
  const exampleRows = [
    { category: "A", amount: 28 },
    { category: "B", amount: 55 },
    { category: "C", amount: 43 },
    { category: "D", amount: 91 },
  ];
  const exampleChartSpec = {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    data: { values: exampleRows },
    mark: "bar",
    encoding: {
      x: { field: "category", type: "nominal" },
      y: { field: "amount", type: "quantitative" },
    },
    title: { text: "Example chart", subtitle: "Replace with your analysis" },
    width: 500,
    height: 300,
  };
  const notebook = {
    cells: [
      markdownCell("report-header", [
        `# ${projectName}`,
        ``,
        `One-sentence summary of what this analysis covers. Report mode uses the \`#\` heading above as the report title and this paragraph as the subtitle.`,
      ]),
      codeCell("setup", [
        `# Setup: keep imports and configuration in a dedicated cell so Report mode hides it.`,
        `import pandas as pd`,
        `import altair as alt`,
      ], { executionCount: 1 }),
      markdownCell("data-section", [
        `## Data`,
        ``,
        `Describe where the data comes from (uploads, workspace connections, connection exports) and any cleaning applied.`,
      ]),
      codeCell("example-chart", [
        `data = pd.DataFrame({`,
        `    "category": ["A", "B", "C", "D"],`,
        `    "amount": [28, 55, 43, 91],`,
        `})`,
        `alt.Chart(data).mark_bar().encode(`,
        `    x="category:N",`,
        `    y="amount:Q",`,
        `).properties(`,
        `    title=alt.Title("Example chart", subtitle="Replace with your analysis"),`,
        `    width=500,`,
        `    height=300,`,
        `)`,
      ], {
        executionCount: 2,
        outputs: [
          {
            output_type: "execute_result",
            execution_count: 2,
            data: { "application/vnd.vegalite.v5+json": exampleChartSpec },
            metadata: {},
          },
        ],
      }),
      markdownCell("findings", [
        `## Key Findings`,
        ``,
        `- Replace these bullets with the takeaways a reader should remember.`,
        `- Keep each finding short and tie it to a chart or table above.`,
      ]),
    ],
    metadata: {
      kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
      language_info: { name: "python" },
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
  return [
    {
      path: "/analysis.ipynb",
      content: `${JSON.stringify(notebook, null, 1)}\n`,
    },
    {
      path: "/README.md",
      content: [
        `# ${projectName}`,
        ``,
        `Notebook-first data analysis project scaffolded by camelAI.`,
        ``,
        `\`analysis.ipynb\` is the main deliverable. camelAI renders notebooks in Report mode by default: code is hidden and the reader sees markdown prose plus cell outputs (charts, tables, text) as a polished article.`,
        ``,
        `## Workflow`,
        ``,
        `- Execute with \`run_notebook({ project: ${JSON.stringify(projectName)}, path: "analysis.ipynb" })\` — one call runs the notebook, validates the outputs, and persists results back to the project. If \`ok\` is false, fix the failing cells (see \`validation.issues\`/\`stderr\`) and re-run.`,
        `- The default Python data stack (pandas, numpy, polars, duckdb, pyarrow, altair, plotly, scipy, scikit-learn, and more) is preinstalled; use \`add_python_dependency\` for anything else.`,
        `- Read big inputs from the read-only mounts — uploads at \`/uploads/<name>\`, connection exports at \`'/' + r2_key\` — and keep large intermediates in \`$SCRATCH\`; only notebooks and small results belong in the project.`,
        `- After a clean run, preview it in chat: \`set_preview({ location: "project", project: ${JSON.stringify(projectName)}, path: "analysis.ipynb", content_type: "application/x-ipynb+json" })\`.`,
        `- To share the report outside chat, \`deploy_project({ project: ${JSON.stringify(projectName)} })\` publishes the executed notebook as a static read-only report app and opens it in preview automatically (the platform notebook renderer plus the .ipynb — no build step). Always run \`run_notebook\` first so the published outputs are fresh. No manual \`set_preview\` or \`list_apps\` call is needed after deploy, though \`set_preview\` remains available for an explicit preview switch.`,
        ``,
        `## Report conventions`,
        ``,
        `- Start the notebook with a single \`#\` title and a one-paragraph subtitle, use \`##\` headings for sections (they become the report's table of contents), and end with a \`## Key Findings\` section.`,
        `- Keep imports and configuration in dedicated setup cells; Report mode hides them automatically.`,
        `- Charts: prefer Altair — Vega-Lite outputs render natively with light/dark theme support (Plotly and PNG outputs also render). Do not set chart backgrounds or hardcode text colors.`,
        `- Tables: output plain pandas DataFrames, not \`df.style\` or hand-built HTML \`<table>\` markup, so they render with theme-aware styling, sorting, and CSV export.`,
        ``,
        `This project holds analysis deliverables; there is no build step (\`build_project\` does not apply — \`deploy_project\` publishes the notebook directly).`,
      ].join("\n") + "\n",
    },
  ];
}

function defaultReactRouterScaffoldFiles(projectName: string, scriptName: string): ProjectScaffoldFile[] {
  const packageName = scaffoldPackageName(projectName);
  const svgProjectName = escapeXmlText(projectName);
  const file = (lines: string[]) => `${lines.join("\n")}\n`;
  return [
    {
      path: "/package.json",
      content: `${JSON.stringify({
        name: packageName,
        private: true,
        type: "module",
        scripts: {
          dev: "react-router dev",
          build: "react-router typegen && tsc --noEmit && react-router build && node ./scripts/build-manifest.mjs",
          deploy: "wrangler deploy",
          typecheck: "react-router typegen && tsc --noEmit",
        },
        dependencies: {
          "@react-router/cloudflare": "^7.16.0",
          "class-variance-authority": "^0.7.1",
          clsx: "^2.1.1",
          "lucide-react": "^0.562.0",
          "radix-ui": SHADCN_NPM_PACKAGE_VERSIONS["radix-ui"] ?? "^1.6.2",
          react: "^19.2.0",
          "react-dom": "^19.2.0",
          "react-router": "^7.16.0",
          "tailwind-merge": "^3.4.0",
          "tw-animate-css": "^1.4.0",
        },
        devDependencies: {
          "@cloudflare/workers-types": "^4.20260629.1",
          "@react-router/dev": "^7.16.0",
          "@tailwindcss/vite": "^4.3.0",
          "@types/react": "^19.2.0",
          "@types/react-dom": "^19.2.0",
          esbuild: "^0.28.1",
          tailwindcss: "^4.1.13",
          typescript: "^7.0.2",
          vite: "^8.0.16",
          wrangler: "^4.97.0",
        },
      }, null, 2)}\n`,
    },
    {
      path: "/wrangler.jsonc",
      content: `${JSON.stringify({
        name: scriptName,
        main: "./workers/app.ts",
        compatibility_date: "2026-06-01",
        compatibility_flags: ["nodejs_compat"],
        assets: {
          directory: "./public/",
          binding: "ASSETS",
        },
      }, null, 2)}\n`,
    },
    {
      path: "/tsconfig.json",
      content: `${JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          jsx: "react-jsx",
          lib: ["ES2022", "DOM", "DOM.Iterable"],
          types: ["@cloudflare/workers-types", "vite/client"],
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          allowSyntheticDefaultImports: true,
          esModuleInterop: true,
          rootDirs: [".", "./.react-router/types"],
          paths: {
            "~/*": ["./app/*"],
          },
        },
        include: [".react-router/types/**/*", "app/**/*.ts", "app/**/*.tsx", "workers/**/*.ts", "scripts/**/*.mjs", "vite.config.ts", "react-router.config.ts"],
      }, null, 2)}\n`,
    },
    {
      path: "/vite.config.ts",
      content: file([
        `import { reactRouter } from "@react-router/dev/vite";`,
        `import { cloudflareDevProxy } from "@react-router/dev/vite/cloudflare";`,
        `import tailwindcss from "@tailwindcss/vite";`,
        `import { defineConfig } from "vite";`,
        ``,
        `export default defineConfig(({ command }) => ({`,
        `  plugins: [`,
        `    ...(command === "serve" ? [cloudflareDevProxy()] : []),`,
        `    tailwindcss(),`,
        `    reactRouter(),`,
        `  ],`,
        `  ssr: {`,
        `    noExternal: true,`,
        `    target: "webworker",`,
        `  },`,
        `}));`,
      ]),
    },
    {
      path: "/react-router.config.ts",
      content: file([
        `import type { Config } from "@react-router/dev/config";`,
        ``,
        `export default {`,
        `  ssr: true,`,
        `  future: {`,
        `    v8_middleware: false,`,
        `    v8_passThroughRequests: true,`,
        `    v8_splitRouteModules: true,`,
        `    v8_trailingSlashAwareDataRequests: true,`,
        `    v8_viteEnvironmentApi: true,`,
        `  },`,
        `} satisfies Config;`,
      ]),
    },
    {
      path: "/app/root.tsx",
      content: file([
        `import type { ReactNode } from "react";`,
        `import { isRouteErrorResponse, Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";`,
        `import type { Route } from "./+types/root";`,
        `import "./app.css";`,
        ``,
        `export const links: Route.LinksFunction = () => [`,
        `  { rel: "preconnect", href: "https://fonts.googleapis.com" },`,
        `  { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },`,
        `  { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },`,
        `];`,
        ``,
        `export function Layout({ children }: { children: ReactNode }) {`,
        `  return (`,
        `    <html lang="en">`,
        `      <head>`,
        `        <meta charSet="utf-8" />`,
        `        <meta name="viewport" content="width=device-width, initial-scale=1" />`,
        `        <Meta />`,
        `        <Links />`,
        `      </head>`,
        `      <body>`,
        `        {children}`,
        `        <ScrollRestoration />`,
        `        <Scripts />`,
        `      </body>`,
        `    </html>`,
        `  );`,
        `}`,
        ``,
        `export default function App() {`,
        `  return <Outlet />;`,
        `}`,
        ``,
        `export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {`,
        `  const status = isRouteErrorResponse(error) ? error.status : 500;`,
        `  const message = isRouteErrorResponse(error) ? error.statusText : error instanceof Error ? error.message : "Unexpected error";`,
        ``,
        `  return (`,
        `    <main className="mx-auto flex min-h-svh w-full max-w-3xl flex-col items-start justify-center gap-4 px-6 py-16">`,
        `      <p className="text-sm font-medium text-muted-foreground">{status}</p>`,
        `      <h1 className="font-display text-4xl font-semibold tracking-tight">Something went wrong</h1>`,
        `      <p className="text-muted-foreground">{message}</p>`,
        `    </main>`,
        `  );`,
        `}`,
      ]),
    },
    {
      path: "/components.json",
      content: `${JSON.stringify({
        "$schema": "https://ui.shadcn.com/schema.json",
        style: "new-york",
        rsc: false,
        tsx: true,
        tailwind: {
          config: "",
          css: "app/app.css",
          baseColor: "zinc",
          cssVariables: true,
          prefix: "",
        },
        aliases: {
          components: "~/components",
          utils: "~/lib/utils",
          ui: "~/components/ui",
          lib: "~/lib",
          hooks: "~/hooks",
        },
        iconLibrary: "lucide",
      }, null, 2)}\n`,
    },
    {
      path: "/app/app.css",
      content: file([
        `@import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Space+Grotesk:wght@500;600;700&display=swap");`,
        `@import "tailwindcss";`,
        `@import "tw-animate-css";`,
        `@source "./**/*.{ts,tsx}";`,
        `@source "../workers/**/*.{ts,tsx}";`,
        ``,
        `@custom-variant dark (&:is(.dark *));`,
        ``,
        `:root {`,
        `  --radius: 0.75rem;`,
        `  --background: oklch(1 0 0);`,
        `  --foreground: oklch(0.141 0.005 285.823);`,
        `  --card: oklch(1 0 0);`,
        `  --card-foreground: oklch(0.141 0.005 285.823);`,
        `  --popover: oklch(1 0 0);`,
        `  --popover-foreground: oklch(0.141 0.005 285.823);`,
        `  --primary: oklch(0.21 0.006 285.885);`,
        `  --primary-foreground: oklch(0.985 0 0);`,
        `  --secondary: oklch(0.967 0.001 286.375);`,
        `  --secondary-foreground: oklch(0.21 0.006 285.885);`,
        `  --muted: oklch(0.967 0.001 286.375);`,
        `  --muted-foreground: oklch(0.552 0.016 285.938);`,
        `  --accent: oklch(0.967 0.001 286.375);`,
        `  --accent-foreground: oklch(0.21 0.006 285.885);`,
        `  --destructive: oklch(0.577 0.245 27.325);`,
        `  --border: oklch(0.92 0.004 286.32);`,
        `  --input: oklch(0.92 0.004 286.32);`,
        `  --ring: oklch(0.705 0.015 286.067);`,
        `}`,
        ``,
        `.dark {`,
        `  --background: oklch(0.141 0.005 285.823);`,
        `  --foreground: oklch(0.985 0 0);`,
        `  --card: oklch(0.21 0.006 285.885);`,
        `  --card-foreground: oklch(0.985 0 0);`,
        `  --popover: oklch(0.21 0.006 285.885);`,
        `  --popover-foreground: oklch(0.985 0 0);`,
        `  --primary: oklch(0.92 0.004 286.32);`,
        `  --primary-foreground: oklch(0.21 0.006 285.885);`,
        `  --secondary: oklch(0.274 0.006 286.033);`,
        `  --secondary-foreground: oklch(0.985 0 0);`,
        `  --muted: oklch(0.274 0.006 286.033);`,
        `  --muted-foreground: oklch(0.705 0.015 286.067);`,
        `  --accent: oklch(0.274 0.006 286.033);`,
        `  --accent-foreground: oklch(0.985 0 0);`,
        `  --destructive: oklch(0.704 0.191 22.216);`,
        `  --border: oklch(1 0 0 / 10%);`,
        `  --input: oklch(1 0 0 / 15%);`,
        `  --ring: oklch(0.552 0.016 285.938);`,
        `}`,
        ``,
        `@theme inline {`,
        `  --font-sans: "Inter", ui-sans-serif, system-ui, sans-serif;`,
        `  --font-display: "Space Grotesk", "Inter", ui-sans-serif, system-ui, sans-serif;`,
        `  --color-background: var(--background);`,
        `  --color-foreground: var(--foreground);`,
        `  --color-card: var(--card);`,
        `  --color-card-foreground: var(--card-foreground);`,
        `  --color-popover: var(--popover);`,
        `  --color-popover-foreground: var(--popover-foreground);`,
        `  --color-primary: var(--primary);`,
        `  --color-primary-foreground: var(--primary-foreground);`,
        `  --color-secondary: var(--secondary);`,
        `  --color-secondary-foreground: var(--secondary-foreground);`,
        `  --color-muted: var(--muted);`,
        `  --color-muted-foreground: var(--muted-foreground);`,
        `  --color-accent: var(--accent);`,
        `  --color-accent-foreground: var(--accent-foreground);`,
        `  --color-destructive: var(--destructive);`,
        `  --color-border: var(--border);`,
        `  --color-input: var(--input);`,
        `  --color-ring: var(--ring);`,
        `  --radius-sm: calc(var(--radius) - 4px);`,
        `  --radius-md: calc(var(--radius) - 2px);`,
        `  --radius-lg: var(--radius);`,
        `  --radius-xl: calc(var(--radius) + 4px);`,
        `}`,
        ``,
        `@layer base {`,
        `  * {`,
        `    @apply border-border outline-ring/50;`,
        `  }`,
        ``,
        `  body {`,
        `    @apply bg-background text-foreground font-sans antialiased;`,
        `  }`,
        ``,
        `  ::selection {`,
        `    @apply bg-primary text-primary-foreground;`,
        `  }`,
        `}`,
      ]),
    },
    {
      path: "/app/types/modules.d.ts",
      content: file([
        `// Ambient module declarations for the scaffold's import conventions.`,
        ``,
        `// Deep per-icon lucide imports keep the build graph small; lucide-react`,
        `// ships no per-icon type declarations, so type them here.`,
        `declare module "lucide-react/dist/esm/icons/*" {`,
        `  import type { LucideIcon } from "lucide-react";`,
        `  const Icon: LucideIcon;`,
        `  export default Icon;`,
        `}`,
        ``,
        `// Virtual module provided by the React Router build (imported by workers/app.ts).`,
        `declare module "virtual:react-router/server-build" {`,
        `  import type { ServerBuild } from "react-router";`,
        `  const build: ServerBuild;`,
        `  export = build;`,
        `}`,
      ]),
    },
    {
      path: "/app/lib/utils.ts",
      content: file([
        `import { clsx, type ClassValue } from "clsx";`,
        `import { twMerge } from "tailwind-merge";`,
        ``,
        `export function cn(...inputs: ClassValue[]) {`,
        `  return twMerge(clsx(inputs));`,
        `}`,
      ]),
    },
    ...seededShadcnScaffoldFiles(),
    {
      path: "/app/routes.ts",
      content: file([
        `import { index, type RouteConfig } from "@react-router/dev/routes";`,
        ``,
        `export default [index("routes/home.tsx")] satisfies RouteConfig;`,
      ]),
    },
    {
      path: "/app/routes/home.tsx",
      content: file([
        `import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";`,
        `import Cloud from "lucide-react/dist/esm/icons/cloud.js";`,
        `import Code2 from "lucide-react/dist/esm/icons/code-2.js";`,
        `import Sparkles from "lucide-react/dist/esm/icons/sparkles.js";`,
        ``,
        `import { Badge } from "~/components/ui/badge";`,
        `import { Button } from "~/components/ui/button";`,
        `import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";`,
        ``,
        `export function meta() {`,
        `  return [`,
        `    { title: ${JSON.stringify(projectName)} },`,
        `    { name: "description", content: "A polished camelAI React Router app" },`,
        `    { property: "og:title", content: ${JSON.stringify(projectName)} },`,
        `    { property: "og:description", content: "Built with React Router, Tailwind, and shadcn-style primitives." },`,
        `    { property: "og:image", content: "/og-image.svg" },`,
        `    { name: "twitter:card", content: "summary_large_image" },`,
        `    { name: "twitter:image", content: "/og-image.svg" },`,
        `  ];`,
        `}`,
        ``,
        `export default function Home() {`,
        `  return (`,
        `    <main className="min-h-svh overflow-hidden bg-[radial-gradient(circle_at_top_left,rgba(244,244,245,0.9),transparent_32rem)]">`,
        `      <section className="mx-auto grid min-h-svh w-full max-w-6xl items-center gap-10 px-6 py-16 lg:grid-cols-[1.15fr_0.85fr] lg:px-8">`,
        `        <div className="space-y-8">`,
        `          <Badge variant="outline" className="bg-background/80 backdrop-blur">`,
        `            <Sparkles className="size-3" />`,
        `            React Router + Tailwind scaffold`,
        `          </Badge>`,
        ``,
        `          <div className="space-y-5">`,
        `            <h1 className="font-display text-5xl font-semibold tracking-tight text-balance md:text-7xl">`,
        `              <span>{${JSON.stringify(projectName)}}</span>`,
        `              <span className="block text-muted-foreground">ready for real product work.</span>`,
        `            </h1>`,
        `            <p className="max-w-2xl text-lg leading-8 text-muted-foreground">`,
        `              You have SSR, Cloudflare Workers deploy metadata, Tailwind v4, and shadcn-style primitives wired up. Edit`,
        `              <code className="mx-1 rounded-md bg-muted px-1.5 py-0.5 text-sm text-foreground">app/routes/home.tsx</code>`,
        `              and keep building from here.`,
        `            </p>`,
        `          </div>`,
        ``,
        `          <div className="flex flex-col gap-3 sm:flex-row">`,
        `            <Button asChild size="lg">`,
        `              <a href="https://reactrouter.com/start/framework/routing" target="_blank" rel="noreferrer">`,
        `                React Router docs`,
        `                <ArrowRight className="size-4" />`,
        `              </a>`,
        `            </Button>`,
        `            <Button asChild variant="outline" size="lg">`,
        `              <a href="https://ui.shadcn.com/docs/components" target="_blank" rel="noreferrer">`,
        `                Browse shadcn components`,
        `              </a>`,
        `            </Button>`,
        `          </div>`,
        `        </div>`,
        ``,
        `        <div className="grid gap-4">`,
        `          <Card className="border-primary/20 bg-background/85 shadow-2xl shadow-zinc-950/5 backdrop-blur">`,
        `            <CardHeader>`,
        `              <CardTitle className="flex items-center gap-2">`,
        `                <Cloud className="size-5 text-primary" />`,
        `                Cloudflare-ready`,
        `              </CardTitle>`,
        `              <CardDescription>Build output includes a worker bundle, native assets metadata, and deploy manifest.</CardDescription>`,
        `            </CardHeader>`,
        `          </Card>`,
        ``,
        `          <Card className="bg-background/75 backdrop-blur">`,
        `            <CardHeader>`,
        `              <CardTitle className="flex items-center gap-2">`,
        `                <Code2 className="size-5 text-primary" />`,
        `                Product patterns`,
        `              </CardTitle>`,
        `              <CardDescription>Use loaders, actions, and route modules for server-first fullstack behavior.</CardDescription>`,
        `            </CardHeader>`,
        `            <CardContent className="grid grid-cols-2 gap-3 text-sm text-muted-foreground">`,
        `              <div className="rounded-lg border bg-muted/40 p-3">SSR enabled</div>`,
        `              <div className="rounded-lg border bg-muted/40 p-3">shadcn-ready</div>`,
        `              <div className="rounded-lg border bg-muted/40 p-3">Tailwind v4</div>`,
        `              <div className="rounded-lg border bg-muted/40 p-3">Lucide icons</div>`,
        `            </CardContent>`,
        `          </Card>`,
        `        </div>`,
        `      </section>`,
        `    </main>`,
        `  );`,
        `}`,
      ]),
    },
    {
      path: "/app/entry.server.tsx",
      content: file([
        `import { renderToReadableStream } from "react-dom/server.edge";`,
        `import type { AppLoadContext, EntryContext } from "react-router";`,
        `import { ServerRouter } from "react-router";`,
        ``,
        `// React Router's idiomatic hook for server-side error logging. It catches`,
        `// loader, action, and rendering errors before the ErrorBoundary renders,`,
        `// so they reach console.error and flow through the worker log tail pipeline`,
        `// instead of being silently swallowed by the ErrorBoundary.`,
        `export function handleError(error: unknown) {`,
        `  console.error(error);`,
        `}`,
        ``,
        `export default async function handleRequest(`,
        `  request: Request,`,
        `  responseStatusCode: number,`,
        `  responseHeaders: Headers,`,
        `  routerContext: EntryContext,`,
        `  _loadContext: AppLoadContext,`,
        `): Promise<Response> {`,
        `  const body = await renderToReadableStream(`,
        `    <ServerRouter context={routerContext} url={request.url} />,`,
        `    {`,
        `      signal: request.signal,`,
        `      onError(error: unknown) {`,
        `        console.error(error);`,
        `        responseStatusCode = 500;`,
        `      },`,
        `    },`,
        `  );`,
        `  responseHeaders.set("Content-Type", "text/html");`,
        `  return new Response(body, { headers: responseHeaders, status: responseStatusCode });`,
        `}`,
      ]),
    },
    {
      path: "/workers/camelai-binding.ts",
      content: file([
        `export interface CamelAiGeneratedImage {`,
        `  dataUrl: string;`,
        `  index: number;`,
        `}`,
        ``,
        `export interface CamelAiGenerateImageResult {`,
        `  text: string | null;`,
        `  imageDataUrl: string | null;`,
        `  images: CamelAiGeneratedImage[];`,
        `}`,
        ``,
        `export interface CamelAiBinding {`,
        `  generateImage(input: string | { prompt: string; referenceImageUrl?: string }): Promise<CamelAiGenerateImageResult>;`,
        `  transcribeAudio(input: string | { path?: string; audio?: string; base64?: string; data?: string }): Promise<{ text: string }>;`,
        `}`,
      ]),
    },
    {
      path: "/workers/app.ts",
      content: file([
        `import { createRequestHandler } from "react-router";`,
        `import type { CamelAiBinding } from "./camelai-binding";`,
        ``,
        `interface Env {`,
        `  ASSETS?: { fetch(request: Request): Promise<Response> | Response };`,
        `  CAMELAI: CamelAiBinding;`,
        `}`,
        ``,
        `const requestHandler = createRequestHandler(`,
        `  () => import("virtual:react-router/server-build"),`,
        `  import.meta.env.MODE,`,
        `);`,
        ``,
        `function shouldServeAsset(request: Request): boolean {`,
        `  const method = request.method.toUpperCase();`,
        `  if (method !== "GET" && method !== "HEAD") return false;`,
        `  const pathname = new URL(request.url).pathname;`,
        `  return pathname.startsWith("/assets/") || pathname.includes(".") || pathname === "/robots.txt";`,
        `}`,
        ``,
        `export default {`,
        `  async fetch(request: Request, env: Env, ctx: ExecutionContext) {`,
        `    if (env.ASSETS && shouldServeAsset(request)) {`,
        `      const assetResponse = await env.ASSETS.fetch(request);`,
        `      if (assetResponse.status !== 404) return assetResponse;`,
        `    }`,
        `    return requestHandler(request, { cloudflare: { env, ctx } });`,
        `  },`,
        `} satisfies ExportedHandler<Env>;`,
      ]),
    },
    {
      path: "/public/robots.txt",
      content: file([`User-agent: *`, `Allow: /`]),
    },
    {
      path: "/public/favicon.svg",
      content: file([
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="camelAI app icon">`,
        `  <rect width="64" height="64" rx="18" fill="#18181b"/>`,
        `  <path d="M18 40c6 7 22 7 28 0" fill="none" stroke="#fafafa" stroke-width="5" stroke-linecap="round"/>`,
        `  <path d="M20 25h24" stroke="#a1a1aa" stroke-width="5" stroke-linecap="round"/>`,
        `  <circle cx="25" cy="33" r="3" fill="#fafafa"/>`,
        `  <circle cx="39" cy="33" r="3" fill="#fafafa"/>`,
        `</svg>`,
      ]),
    },
    {
      path: "/public/og-image.svg",
      content: file([
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" role="img" aria-label="${svgProjectName} preview">`,
        `  <rect width="1200" height="630" fill="#fafafa"/>`,
        `  <circle cx="1040" cy="90" r="260" fill="#e4e4e7"/>`,
        `  <circle cx="180" cy="560" r="220" fill="#f4f4f5"/>`,
        `  <rect x="90" y="90" width="1020" height="450" rx="42" fill="#ffffff" stroke="#d4d4d8" stroke-width="3"/>`,
        `  <text x="150" y="245" fill="#18181b" font-family="Inter, Arial, sans-serif" font-size="42" font-weight="700">camelAI React Router app</text>`,
        `  <text x="150" y="350" fill="#18181b" font-family="Inter, Arial, sans-serif" font-size="78" font-weight="800">${svgProjectName}</text>`,
        `  <text x="150" y="430" fill="#71717a" font-family="Inter, Arial, sans-serif" font-size="30">Tailwind + shadcn-style primitives on Cloudflare Workers</text>`,
        `</svg>`,
      ]),
    },
    {
      path: "/scripts/build-manifest.mjs",
      content: file([
        `import { execFileSync } from "node:child_process";`,
        `import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";`,
        ``,
        `mkdirSync("build/server", { recursive: true });`,
        ``,
        `const rawConfig = readFileSync("wrangler.jsonc", "utf8");`,
        `const config = JSON.parse(rawConfig.replace(/\\/\\/[^\\n]*/g, "").replace(/,(\\s*[}\\]])/g, "$1"));`,
        ``,
        `const sharedEsbuildArgs = [`,
        `  "--bundle",`,
        `  "--format=esm",`,
        `  "--platform=browser",`,
        `  "--conditions=workerd,worker,browser",`,
        `  "--external:cloudflare:*",`,
        `  "--external:node:*",`,
        `  "--external:util",`,
        `  "--external:crypto",`,
        `  "--external:async_hooks",`,
        `  "--external:stream",`,
        `  "--external:buffer",`,
        `  "--external:events",`,
        `  "--outfile=build/server/worker.js",`,
        `];`,
        ``,
        `if (config.main) {`,
        `  // Bundle the configured worker entry (e.g. ./workers/app.ts) so exports such as`,
        `  // Durable Object classes survive the build. The React Router server build is`,
        `  // aliased in for the virtual module the entry imports.`,
        `  execFileSync("node_modules/.bin/esbuild", [`,
        `    config.main,`,
        `    '--alias:virtual:react-router/server-build=./build/server/index.js',`,
        `    '--define:import.meta.env.MODE="production"',`,
        `    ...sharedEsbuildArgs,`,
        `  ], { stdio: "inherit" });`,
        `} else {`,
        `  const workerEntryPath = "build/server/_cf_worker_entry.js";`,
        `  const workerEntry = [`,
        `    'import { createRequestHandler } from "react-router";',`,
        `    'import * as build from "./index.js";',`,
        `    '',`,
        `    'const handler = createRequestHandler(build, "production");',`,
        `    '',`,
        `    'function shouldServeAsset(request) {',`,
        `    '  const method = request.method.toUpperCase();',`,
        `    '  if (method !== "GET" && method !== "HEAD") return false;',`,
        `    '  const pathname = new URL(request.url).pathname;',`,
        `    '  return pathname.startsWith("/assets/") || pathname.includes(".") || pathname === "/robots.txt";',`,
        `    '}',`,
        `    '',`,
        `    'export default {',`,
        `    '  async fetch(request, env, ctx) {',`,
        `    '    if (env.ASSETS && shouldServeAsset(request)) {',`,
        `    '      const assetResponse = await env.ASSETS.fetch(request);',`,
        `    '      if (assetResponse.status !== 404) return assetResponse;',`,
        `    '    }',`,
        `    '    return handler(request, { cloudflare: { env, ctx } });',`,
        `    '  },',`,
        `    '};',`,
        `  ].join("\\n");`,
        `  writeFileSync(workerEntryPath, workerEntry + "\\n");`,
        `  execFileSync("node_modules/.bin/esbuild", [workerEntryPath, ...sharedEsbuildArgs], { stdio: "inherit" });`,
        `  rmSync(workerEntryPath, { force: true });`,
        `}`,
        ``,
        `// The platform deploy pipeline only reads metadata.bindings (a top-level vars`,
        `// key is a no-op on that path), so convert wrangler vars into env-var bindings:`,
        `// strings become plain_text bindings and everything else becomes a json binding.`,
        `// The manifest is a wrangler-valid config describing the FINAL build`,
        `// output: main names the entry module and rules declare which other files`,
        `// upload as modules (no_bundle semantics). The deploy pipeline`,
        `// (project-worker-bundle) selects modules strictly by these rules and`,
        `// lifts vars/durable_objects/kv_namespaces/r2_buckets/ai/services into API bindings.`,
        `const manifest = {`,
        `  main: "worker.js",`,
        `  no_bundle: true,`,
        `  rules: [{ type: "ESModule", globs: ["**/*.js", "**/*.mjs"] }],`,
        `  compatibility_date: config.compatibility_date,`,
        `  compatibility_flags: config.compatibility_flags ?? [],`,
        `  assets: { directory: "../client", binding: "ASSETS" },`,
        `  ...(config.vars ? { vars: config.vars } : {}),`,
        `  ...(config.durable_objects ? { durable_objects: config.durable_objects } : {}),`,
        `  ...(config.migrations ? { migrations: config.migrations } : {}),`,
        `  ...(config.kv_namespaces ? { kv_namespaces: config.kv_namespaces } : {}),`,
        `  ...(config.r2_buckets ? { r2_buckets: config.r2_buckets } : {}),`,
        `  ...(config.ai ? { ai: config.ai } : {}),`,
        `  ...(config.services ? { services: config.services } : {}),`,
        `  ...(config.bindings ? { bindings: config.bindings } : {}),`,
        `};`,
        `writeFileSync("build/server/wrangler.json", JSON.stringify(manifest, null, 2) + "\\n");`,
        `console.log("build/server/wrangler.json written.");`,
      ]),
    },
    {
      path: "/README.md",
      content: file([
        `# ${projectName}`,
        ``,
        `React Router SSR scaffolded by camelAI with Tailwind v4 and shadcn-style UI primitives.`,
        ``,
        `## Commands`,
        ``,
        "- `bun install` installs explicit dependencies and CLIs.",
        "- `bun run dev` starts React Router local development.",
        "- `bun run typecheck` regenerates React Router route types and checks TypeScript.",
        "- `bun run build` typechecks first (`react-router typegen && tsc --noEmit`), then runs `react-router build`, bundles a Cloudflare Worker wrapper, and writes `build/server/wrangler.json` for `deploy_project`. Type errors fail the build — fix them rather than loosening tsconfig.",
        "- `bun run deploy` is included for compatibility; camelAI's `deploy_project` uses the platform direct-deploy path.",
        "- In camelAI chat, call `deploy_project({ project: \"<project>\" })` once to build, publish, return the live URL, and open the app in preview. Use `dry_run: true` only for build validation without publishing. No manual `set_preview` or `list_apps` call is needed after deploy; `set_preview` remains available for an explicit preview switch. The hidden `build_project` name is compatibility-only.",
        "- In camelAI chat, add bundled shadcn/ui components or full blocks (login pages, sidebar layouts, dashboards) with `add_shadcn_component({ project: \"<project>\", components: [\"accordion\", \"chart\", \"login-03\"] })` — the whole shadcn catalog is bundled, dependencies resolve automatically, and needed npm packages are added to package.json. Block pages land under `app/blocks/<name>/page.tsx`; register them in `app/routes.ts`. For local development outside camelAI, use `bunx --bun shadcn@latest add <component> --yes`. `components.json`, `app/app.css`, and `~/lib/utils` are already configured.",
        ``,
        "Build scripts must declare every CLI they use in `dependencies` or `devDependencies`; package scripts can then resolve those binaries from `node_modules/.bin`.",
        ``,
        `## Persistence (Durable Objects + SQLite)`,
        ``,
        "Use SQLite-backed Durable Objects for persistence: add the class under `workers/`, export it from `workers/app.ts`, and declare it in `wrangler.jsonc` under `durable_objects.bindings` plus a `migrations` entry with `new_sqlite_classes`.",
        ``,
        "Durable Object SQLite is NOT the D1 API. `this.ctx.storage.sql` has no `.prepare()`, `.bind()`, `.all()`, `.first()`, or `.run()` — D1-style calls fail the build's typecheck. Pass parameters directly to `exec` and read the cursor:",
        ``,
        "```ts",
        `const rows = this.ctx.storage.sql`,
        `  .exec("SELECT * FROM items WHERE owner = ?", ownerId)`,
        `  .toArray(); // .one() for a single row, .raw() for column arrays`,
        "```",
      ]),
    },
  ];
}

function replaceScaffoldFile(files: ProjectScaffoldFile[], path: string, content: string): void {
  const index = files.findIndex((file) => file.path === path);
  const next = { path, content: content.endsWith("\n") ? content : `${content}\n` };
  if (index === -1) files.push(next);
  else files[index] = next;
}

function updateScaffoldJson(
  files: ProjectScaffoldFile[],
  path: string,
  update: (value: Record<string, unknown>) => void,
): void {
  const current = files.find((file) => file.path === path);
  if (!current) throw new Error(`Missing scaffold file ${path}`);
  const value = JSON.parse(current.content) as Record<string, unknown>;
  update(value);
  current.content = `${JSON.stringify(value, null, 2)}\n`;
}

function crudScaffoldFiles(projectName: string, scriptName: string): ProjectScaffoldFile[] {
  const files = defaultReactRouterScaffoldFiles(projectName, scriptName);
  updateScaffoldJson(files, "/wrangler.jsonc", (config) => {
    config.durable_objects = { bindings: [{ name: "ITEMS", class_name: "ItemStore" }] };
    config.migrations = [{ tag: "v1", new_sqlite_classes: ["ItemStore"] }];
  });
  replaceScaffoldFile(files, "/workers/item-store.ts", `import { DurableObject } from "cloudflare:workers";

interface ItemStoreEnv {}

export interface Item extends Record<string, SqlStorageValue> {
  id: number;
  title: string;
  status: "todo" | "in-progress" | "done";
  createdAt: string;
}

export class ItemStore extends DurableObject<ItemStoreEnv> {
  constructor(ctx: DurableObjectState, env: ItemStoreEnv) {
    super(ctx, env);
    this.ctx.storage.sql.exec(\`
      CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'todo',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    \`);
  }

  list(): Item[] {
    return this.ctx.storage.sql.exec<Item>(
      "SELECT id, title, status, created_at AS createdAt FROM items ORDER BY id DESC",
    ).toArray();
  }

  create(title: string): Item {
    return this.ctx.storage.sql.exec<Item>(
      "INSERT INTO items (title) VALUES (?) RETURNING id, title, status, created_at AS createdAt",
      title,
    ).one();
  }

  updateStatus(id: number, status: Item["status"]): void {
    this.ctx.storage.sql.exec("UPDATE items SET status = ? WHERE id = ?", status, id);
  }

  remove(id: number): void {
    this.ctx.storage.sql.exec("DELETE FROM items WHERE id = ?", id);
  }
}
`);
  replaceScaffoldFile(files, "/workers/app.ts", `import { createRequestHandler } from "react-router";
import type { CamelAiBinding } from "./camelai-binding";
import type { ItemStore } from "./item-store";

export { ItemStore } from "./item-store";

interface Env {
  ASSETS?: { fetch(request: Request): Promise<Response> | Response };
  CAMELAI: CamelAiBinding;
  ITEMS: DurableObjectNamespace<ItemStore>;
}

declare module "react-router" {
  export interface AppLoadContext {
    cloudflare: { env: Env; ctx: ExecutionContext };
  }
}

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

function shouldServeAsset(request: Request): boolean {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;
  const pathname = new URL(request.url).pathname;
  return pathname.startsWith("/assets/") || pathname.includes(".") || pathname === "/robots.txt";
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (env.ASSETS && shouldServeAsset(request)) {
      const assetResponse = await env.ASSETS.fetch(request);
      if (assetResponse.status !== 404) return assetResponse;
    }
    return requestHandler(request, { cloudflare: { env, ctx } });
  },
} satisfies ExportedHandler<Env>;
`);
  replaceScaffoldFile(files, "/app/routes/home.tsx", `import { Form, useLoaderData, useSubmit } from "react-router";
import ClipboardList from "lucide-react/dist/esm/icons/clipboard-list.js";
import Plus from "lucide-react/dist/esm/icons/plus.js";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.js";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import type { Route } from "./+types/home";

function store(context: Route.LoaderArgs["context"]) {
  const namespace = context.cloudflare.env.ITEMS;
  return namespace.get(namespace.idFromName("default"));
}

export async function loader({ context }: Route.LoaderArgs) {
  return { items: await store(context).list() };
}

export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "create");
  const items = store(context);
  if (intent === "create") {
    const title = String(form.get("title") ?? "").trim();
    if (title) await items.create(title);
  } else if (intent === "status") {
    const id = Number(form.get("id"));
    const status = String(form.get("status"));
    if (Number.isInteger(id) && ["todo", "in-progress", "done"].includes(status)) {
      await items.updateStatus(id, status as "todo" | "in-progress" | "done");
    }
  } else if (intent === "delete") {
    const id = Number(form.get("id"));
    if (Number.isInteger(id)) await items.remove(id);
  }
  return { ok: true };
}

export function meta() {
  return [{ title: ${JSON.stringify(projectName)} }, { name: "description", content: "A durable CRUD app" }];
}

export default function Home() {
  const { items } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  return (
    <main className="min-h-svh bg-muted/30 px-6 py-10">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <Badge variant="outline" className="mb-3"><ClipboardList className="size-3" /> Durable CRUD starter</Badge>
            <h1 className="font-display text-4xl font-semibold tracking-tight">${projectName}</h1>
            <p className="mt-2 text-muted-foreground">A server-first list backed by Durable Object SQLite.</p>
          </div>
          <Badge>{items.length} items</Badge>
        </div>

        <Card>
          <CardHeader><CardTitle>Add an item</CardTitle><CardDescription>React Router actions write directly to the Durable Object.</CardDescription></CardHeader>
          <CardContent>
            <Form method="post" className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <input type="hidden" name="intent" value="create" />
              <div className="grid flex-1 gap-2"><Label htmlFor="title">Title</Label><Input id="title" name="title" required placeholder="What needs doing?" /></div>
              <Button type="submit"><Plus className="size-4" /> Add item</Button>
            </Form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Items</CardTitle><CardDescription>Use this route as the pattern for your own entities and workflows.</CardDescription></CardHeader>
          <CardContent>
            {items.length === 0 ? (
              <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">No items yet. Add the first one above.</div>
            ) : (
              <Table>
                <TableHeader><TableRow><TableHead>Title</TableHead><TableHead>Status</TableHead><TableHead>Created</TableHead><TableHead className="w-16" /></TableRow></TableHeader>
                <TableBody>{items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="font-medium">{item.title}</TableCell>
                    <TableCell><Select defaultValue={item.status} onValueChange={(status) => submit({ intent: "status", id: String(item.id), status }, { method: "post" })}><SelectTrigger className="w-36"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="todo">To do</SelectItem><SelectItem value="in-progress">In progress</SelectItem><SelectItem value="done">Done</SelectItem></SelectContent></Select></TableCell>
                    <TableCell className="text-muted-foreground">{item.createdAt}</TableCell>
                    <TableCell><Form method="post"><input type="hidden" name="intent" value="delete" /><input type="hidden" name="id" value={item.id} /><Button type="submit" size="icon" variant="ghost" aria-label={\`Delete \${item.title}\`}><Trash2 className="size-4" /></Button></Form></TableCell>
                  </TableRow>
                ))}</TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
`);
  return files;
}

function aiChatScaffoldFiles(projectName: string, scriptName: string): ProjectScaffoldFile[] {
  const files = defaultReactRouterScaffoldFiles(projectName, scriptName);
  updateScaffoldJson(files, "/wrangler.jsonc", (config) => {
    config.ai = { binding: "AI" };
  });
  replaceScaffoldFile(files, "/workers/app.ts", `import { createRequestHandler } from "react-router";
import type { CamelAiBinding } from "./camelai-binding";

interface AiBinding {
  run(model: string, input: { messages: Array<{ role: string; content: string }> }): Promise<unknown>;
}

interface Env {
  ASSETS?: { fetch(request: Request): Promise<Response> | Response };
  AI: AiBinding;
  CAMELAI: CamelAiBinding;
}

declare module "react-router" {
  export interface AppLoadContext {
    cloudflare: { env: Env; ctx: ExecutionContext };
  }
}

const requestHandler = createRequestHandler(() => import("virtual:react-router/server-build"), import.meta.env.MODE);

function shouldServeAsset(request: Request): boolean {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;
  const pathname = new URL(request.url).pathname;
  return pathname.startsWith("/assets/") || pathname.includes(".") || pathname === "/robots.txt";
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (env.ASSETS && shouldServeAsset(request)) {
      const assetResponse = await env.ASSETS.fetch(request);
      if (assetResponse.status !== 404) return assetResponse;
    }
    return requestHandler(request, { cloudflare: { env, ctx } });
  },
} satisfies ExportedHandler<Env>;
`);
  replaceScaffoldFile(files, "/app/routes/home.tsx", `import { Form, useActionData, useNavigation } from "react-router";
import Bot from "lucide-react/dist/esm/icons/bot.js";
import Send from "lucide-react/dist/esm/icons/send.js";
import Sparkles from "lucide-react/dist/esm/icons/sparkles.js";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import type { Route } from "./+types/home";

function responseText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && "response" in result && typeof result.response === "string") return result.response;
  return JSON.stringify(result, null, 2);
}

export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData();
  const message = String(form.get("message") ?? "").trim();
  if (!message) return { message: "", response: "Enter a message to begin." };
  const result = await context.cloudflare.env.AI.run("auto", {
    messages: [
      { role: "system", content: "You are a concise, helpful assistant." },
      { role: "user", content: message },
    ],
  });
  return { message, response: responseText(result) };
}

export function meta() { return [{ title: ${JSON.stringify(projectName)} }, { name: "description", content: "An AI chat starter" }]; }

export default function Home() {
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  return (
    <main className="min-h-svh bg-muted/30 px-6 py-10">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <div><Badge variant="outline" className="mb-3"><Sparkles className="size-3" /> AI starter</Badge><h1 className="font-display text-4xl font-semibold tracking-tight">${projectName}</h1><p className="mt-2 text-muted-foreground">A server-rendered chat surface wired to camelAI's virtual AI binding.</p></div>
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Bot className="size-5" /> Assistant</CardTitle><CardDescription>Replace the system instruction and add your product context or tools.</CardDescription></CardHeader>
          <CardContent className="space-y-5">
            {result ? <div className="space-y-3"><div className="ml-auto max-w-[85%] rounded-xl bg-primary px-4 py-3 text-sm text-primary-foreground">{result.message}</div><div className="max-w-[85%] whitespace-pre-wrap rounded-xl border bg-background px-4 py-3 text-sm leading-6">{result.response}</div></div> : <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">Ask a question to test the AI binding.</div>}
            <Form method="post" className="grid gap-3"><Label htmlFor="message">Message</Label><Textarea id="message" name="message" required rows={4} placeholder="How can you help me today?" /><Button type="submit" disabled={busy}>{busy ? "Thinking…" : "Send message"}<Send className="size-4" /></Button></Form>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
`);
  return files;
}

function integrationDashboardScaffoldFiles(projectName: string, scriptName: string): ProjectScaffoldFile[] {
  const files = defaultReactRouterScaffoldFiles(projectName, scriptName);
  replaceScaffoldFile(files, "/workers/app.ts", `import { createRequestHandler } from "react-router";
import type { CamelAiBinding } from "./camelai-binding";

interface ConnectionMethod { name: string; tool: string; description?: string }
interface ConnectionEntry { alias: string; connection: { id: string; type: string; displayName: string }; methods: ConnectionMethod[]; error?: { message: string } }
interface ConnectionsBinding { methods(): Promise<ConnectionEntry[]> }
interface Env { ASSETS?: { fetch(request: Request): Promise<Response> | Response }; CAMELAI: CamelAiBinding; CONNECTIONS: ConnectionsBinding }

declare module "react-router" {
  export interface AppLoadContext { cloudflare: { env: Env; ctx: ExecutionContext } }
}

const requestHandler = createRequestHandler(() => import("virtual:react-router/server-build"), import.meta.env.MODE);
function shouldServeAsset(request: Request): boolean { const method = request.method.toUpperCase(); if (method !== "GET" && method !== "HEAD") return false; const pathname = new URL(request.url).pathname; return pathname.startsWith("/assets/") || pathname.includes(".") || pathname === "/robots.txt"; }
export default { async fetch(request: Request, env: Env, ctx: ExecutionContext) { if (env.ASSETS && shouldServeAsset(request)) { const assetResponse = await env.ASSETS.fetch(request); if (assetResponse.status !== 404) return assetResponse; } return requestHandler(request, { cloudflare: { env, ctx } }); } } satisfies ExportedHandler<Env>;
`);
  replaceScaffoldFile(files, "/app/routes/home.tsx", `import { useLoaderData } from "react-router";
import Cable from "lucide-react/dist/esm/icons/cable.js";
import Database from "lucide-react/dist/esm/icons/database.js";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.js";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import type { Route } from "./+types/home";

export async function loader({ context }: Route.LoaderArgs) {
  try { return { connections: await context.cloudflare.env.CONNECTIONS.methods(), error: null }; }
  catch (error) { return { connections: [], error: error instanceof Error ? error.message : "Connections unavailable" }; }
}
export function meta() { return [{ title: ${JSON.stringify(projectName)} }, { name: "description", content: "A workspace integration dashboard" }]; }
export default function Home() {
  const { connections, error } = useLoaderData<typeof loader>();
  const methodCount = connections.reduce((sum, entry) => sum + entry.methods.length, 0);
  return <main className="min-h-svh bg-muted/30 px-6 py-10"><div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
    <div className="flex items-start justify-between gap-4"><div><Badge variant="outline" className="mb-3"><Cable className="size-3" /> Integration starter</Badge><h1 className="font-display text-4xl font-semibold tracking-tight">${projectName}</h1><p className="mt-2 text-muted-foreground">Inspect connected services and build workflows on their typed methods.</p></div><Button asChild variant="outline"><a href="/"><RefreshCw className="size-4" /> Refresh</a></Button></div>
    <div className="grid gap-4 sm:grid-cols-2"><Card><CardHeader><CardDescription>Connections</CardDescription><CardTitle className="text-3xl">{connections.length}</CardTitle></CardHeader></Card><Card><CardHeader><CardDescription>Callable methods</CardDescription><CardTitle className="text-3xl">{methodCount}</CardTitle></CardHeader></Card></div>
    <Card><CardHeader><CardTitle className="flex items-center gap-2"><Database className="size-5" /> Workspace connections</CardTitle><CardDescription>{error ?? "Credentials stay behind the platform binding and are never exposed to the app."}</CardDescription></CardHeader><CardContent>{connections.length === 0 ? <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">{error ?? "No connections configured yet."}</div> : <Table><TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Type</TableHead><TableHead>Alias</TableHead><TableHead>Methods</TableHead></TableRow></TableHeader><TableBody>{connections.map((entry) => <TableRow key={entry.connection.id}><TableCell className="font-medium">{entry.connection.displayName}</TableCell><TableCell><Badge variant="secondary">{entry.connection.type}</Badge></TableCell><TableCell className="font-mono text-xs">{entry.alias}</TableCell><TableCell>{entry.methods.map((method) => method.name).join(", ") || "—"}</TableCell></TableRow>)}</TableBody></Table>}</CardContent></Card>
  </div></main>;
}
`);
  return files;
}

function dataDashboardScaffoldFiles(projectName: string, scriptName: string): ProjectScaffoldFile[] {
  const files = defaultReactRouterScaffoldFiles(projectName, scriptName);
  const chart = SHADCN_REGISTRY.chart;
  if (!chart) throw new Error("The data-dashboard scaffold requires the bundled shadcn chart component");
  for (const chartFile of chart.files) replaceScaffoldFile(files, chartFile.path, chartFile.content);
  updateScaffoldJson(files, "/package.json", (packageJson) => {
    const dependencies = packageJson.dependencies as Record<string, string>;
    for (const name of chart.dependencies) {
      const version = SHADCN_NPM_PACKAGE_VERSIONS[name];
      if (!version) throw new Error(`Missing bundled version for chart dependency ${name}`);
      dependencies[name] = version;
    }
  });
  replaceScaffoldFile(files, "/app/routes/home.tsx", `import { Form, useLoaderData } from "react-router";
import BarChart3 from "lucide-react/dist/esm/icons/chart-no-axes-column-increasing.js";
import Download from "lucide-react/dist/esm/icons/download.js";
import TrendingUp from "lucide-react/dist/esm/icons/trending-up.js";
import { Bar, BarChart, CartesianGrid, XAxis } from "recharts";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "~/components/ui/chart";
import { Label } from "~/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import type { Route } from "./+types/home";

const allRows = [
  { month: "Jan", revenue: 18200, customers: 124 }, { month: "Feb", revenue: 21400, customers: 138 },
  { month: "Mar", revenue: 23900, customers: 151 }, { month: "Apr", revenue: 27800, customers: 169 },
  { month: "May", revenue: 30100, customers: 184 }, { month: "Jun", revenue: 34700, customers: 203 },
];
const chartConfig = { revenue: { label: "Revenue", color: "var(--color-primary)" } } satisfies ChartConfig;

export function loader({ request }: Route.LoaderArgs) {
  const range = new URL(request.url).searchParams.get("range") ?? "6";
  const count = range === "3" ? 3 : 6;
  return { rows: allRows.slice(-count), range };
}
export function meta() { return [{ title: ${JSON.stringify(projectName)} }, { name: "description", content: "An interactive data dashboard" }]; }
export default function Home() {
  const { rows, range } = useLoaderData<typeof loader>();
  const revenue = rows.reduce((sum, row) => sum + row.revenue, 0);
  const latest = rows.at(-1);
  return <main className="min-h-svh bg-muted/30 px-6 py-10"><div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
    <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div><Badge variant="outline" className="mb-3"><BarChart3 className="size-3" /> Data dashboard starter</Badge><h1 className="font-display text-4xl font-semibold tracking-tight">${projectName}</h1><p className="mt-2 text-muted-foreground">Replace the sample loader data with a database or workspace connection.</p></div><Form method="get" className="flex items-end gap-2"><div className="grid gap-2"><Label htmlFor="range">Range</Label><Select name="range" defaultValue={range}><SelectTrigger id="range" className="w-40"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="3">Last 3 months</SelectItem><SelectItem value="6">Last 6 months</SelectItem></SelectContent></Select></div><Button type="submit" variant="outline">Apply</Button></Form></div>
    <div className="grid gap-4 sm:grid-cols-3"><Card><CardHeader><CardDescription>Total revenue</CardDescription><CardTitle className="text-3xl">\${revenue.toLocaleString()}</CardTitle></CardHeader></Card><Card><CardHeader><CardDescription>Customers</CardDescription><CardTitle className="text-3xl">{latest?.customers ?? 0}</CardTitle></CardHeader></Card><Card><CardHeader><CardDescription>Trend</CardDescription><CardTitle className="flex items-center gap-2 text-3xl"><TrendingUp className="size-6" /> +18%</CardTitle></CardHeader></Card></div>
    <Card><CardHeader><CardTitle>Revenue</CardTitle><CardDescription>Monthly performance for the selected range.</CardDescription></CardHeader><CardContent><ChartContainer config={chartConfig} className="max-h-80 w-full"><BarChart accessibilityLayer data={rows}><CartesianGrid vertical={false} /><XAxis dataKey="month" tickLine={false} axisLine={false} /><ChartTooltip content={<ChartTooltipContent />} /><Bar dataKey="revenue" fill="var(--color-revenue)" radius={6} /></BarChart></ChartContainer></CardContent></Card>
    <Card><CardHeader className="flex-row items-center justify-between"><div><CardTitle>Monthly detail</CardTitle><CardDescription>Keep export and drill-down actions close to the data.</CardDescription></div><Button variant="outline" size="sm"><Download className="size-4" /> Export</Button></CardHeader><CardContent><Table><TableHeader><TableRow><TableHead>Month</TableHead><TableHead>Revenue</TableHead><TableHead>Customers</TableHead></TableRow></TableHeader><TableBody>{rows.map((row) => <TableRow key={row.month}><TableCell className="font-medium">{row.month}</TableCell><TableCell>\${row.revenue.toLocaleString()}</TableCell><TableCell>{row.customers}</TableCell></TableRow>)}</TableBody></Table></CardContent></Card>
  </div></main>;
}
`);
  return files;
}

function vanillaScaffoldFiles(projectName: string, scriptName: string): ProjectScaffoldFile[] {
  const packageName = scaffoldPackageName(projectName);
  const escapedProjectName = escapeXmlText(projectName);
  const file = (lines: string[]) => `${lines.join("\n")}\n`;
  return [
    {
      path: "/package.json",
      content: `${JSON.stringify({
        name: packageName,
        private: true,
        type: "module",
        scripts: {
          dev: "wrangler dev",
          build: "node ./scripts/build.mjs",
          deploy: "wrangler deploy",
        },
        devDependencies: {
          wrangler: "^4.97.0",
        },
      }, null, 2)}\n`,
    },
    {
      path: "/wrangler.jsonc",
      content: `${JSON.stringify({
        name: scriptName,
        main: "./worker.js",
        compatibility_date: "2026-06-01",
        assets: {
          directory: "./public",
          binding: "ASSETS",
        },
      }, null, 2)}\n`,
    },
    {
      path: "/worker.js",
      content: file([
        `export default {`,
        `  async fetch(request, env) {`,
        `    const assetResponse = await env.ASSETS.fetch(request);`,
        `    if (assetResponse.status !== 404) return assetResponse;`,
        ``,
        `    const method = request.method.toUpperCase();`,
        `    const acceptsHtml = request.headers.get("accept")?.includes("text/html");`,
        `    if ((method === "GET" || method === "HEAD") && acceptsHtml) {`,
        `      return env.ASSETS.fetch(new URL("/index.html", request.url));`,
        `    }`,
        ``,
        `    return assetResponse;`,
        `  },`,
        `};`,
      ]),
    },
    {
      path: "/public/index.html",
      content: file([
        `<!doctype html>`,
        `<html lang="en">`,
        `  <head>`,
        `    <meta charset="UTF-8" />`,
        `    <meta name="viewport" content="width=device-width, initial-scale=1" />`,
        `    <meta name="description" content="A lightweight web experience built with plain HTML, CSS, and JavaScript." />`,
        `    <meta property="og:title" content="${escapedProjectName}" />`,
        `    <meta property="og:description" content="A lightweight web experience built with plain HTML, CSS, and JavaScript." />`,
        `    <meta property="og:image" content="/og-image.svg" />`,
        `    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />`,
        `    <link rel="stylesheet" href="/styles.css" />`,
        `    <title>${escapedProjectName}</title>`,
        `  </head>`,
        `  <body>`,
        `    <main class="shell">`,
        `      <section class="hero" aria-labelledby="page-title">`,
        `        <p class="eyebrow">Vanilla web starter</p>`,
        `        <h1 id="page-title">${escapedProjectName}</h1>`,
        `        <p class="lede">A fast, focused starting point for a landing page, calculator, quiz, or browser game.</p>`,
        `        <button id="demo-action" type="button">Try the interaction</button>`,
        `        <p id="demo-status" class="status" role="status" aria-live="polite">Ready when you are.</p>`,
        `      </section>`,
        `      <section class="card-grid" aria-label="Starter capabilities">`,
        `        <article><span>01</span><h2>HTML</h2><p>Semantic structure ready to reshape.</p></article>`,
        `        <article><span>02</span><h2>CSS</h2><p>Responsive styles without a framework.</p></article>`,
        `        <article><span>03</span><h2>JavaScript</h2><p>A small module for your interaction or game loop.</p></article>`,
        `      </section>`,
        `    </main>`,
        `    <script type="module" src="/main.js"></script>`,
        `  </body>`,
        `</html>`,
      ]),
    },
    {
      path: "/public/styles.css",
      content: file([
        `:root {`,
        `  color-scheme: light dark;`,
        `  font-family: Inter, ui-sans-serif, system-ui, sans-serif;`,
        `  color: #f7f7f2;`,
        `  background: #10120f;`,
        `  font-synthesis: none;`,
        `}`,
        `* { box-sizing: border-box; }`,
        `body { margin: 0; min-width: 320px; min-height: 100vh; background: radial-gradient(circle at 80% 0%, #33492d 0, transparent 36rem), #10120f; }`,
        `button { font: inherit; }`,
        `.shell { width: min(1120px, calc(100% - 2rem)); margin: 0 auto; padding: clamp(3rem, 9vw, 8rem) 0; }`,
        `.hero { max-width: 760px; }`,
        `.eyebrow { margin: 0 0 1rem; color: #b9e7a9; font-size: .78rem; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; }`,
        `h1 { margin: 0; font-size: clamp(3.5rem, 10vw, 7.5rem); line-height: .9; letter-spacing: -.07em; }`,
        `.lede { max-width: 640px; margin: 1.75rem 0; color: #c5c9c1; font-size: clamp(1.1rem, 2.4vw, 1.45rem); line-height: 1.6; }`,
        `button { border: 0; border-radius: 999px; padding: .9rem 1.3rem; color: #10200c; background: #b9e7a9; font-weight: 800; cursor: pointer; transition: transform 160ms ease, background 160ms ease; }`,
        `button:hover { transform: translateY(-2px); background: #d2f6c5; }`,
        `button:focus-visible { outline: 3px solid #f7f7f2; outline-offset: 4px; }`,
        `.status { min-height: 1.5rem; color: #979e93; }`,
        `.card-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; margin-top: clamp(4rem, 10vw, 8rem); }`,
        `.card-grid article { min-height: 180px; padding: 1.4rem; border: 1px solid #363b34; border-radius: 1.25rem; background: rgb(24 27 23 / 78%); }`,
        `.card-grid span { color: #9bd68a; font: 700 .75rem ui-monospace, monospace; }`,
        `.card-grid h2 { margin: 2.5rem 0 .5rem; }`,
        `.card-grid p { margin: 0; color: #aeb3aa; line-height: 1.5; }`,
        `@media (max-width: 700px) { .card-grid { grid-template-columns: 1fr; } .card-grid article { min-height: auto; } .card-grid h2 { margin-top: 1.5rem; } }`,
        `@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; } }`,
      ]),
    },
    {
      path: "/public/main.js",
      content: file([
        `const action = document.querySelector("#demo-action");`,
        `const status = document.querySelector("#demo-status");`,
        `let count = 0;`,
        ``,
        `action?.addEventListener("click", () => {`,
        `  count += 1;`,
        `  if (status) status.textContent = count === 1 ? "It works — now make it yours." : "Interaction count: " + count;`,
        `});`,
      ]),
    },
    {
      path: "/public/favicon.svg",
      content: file([
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="${escapedProjectName} icon">`,
        `  <rect width="64" height="64" rx="18" fill="#b9e7a9"/>`,
        `  <path d="M19 20h26L34 44h-9l7-15H19z" fill="#10200c"/>`,
        `</svg>`,
      ]),
    },
    {
      path: "/public/og-image.svg",
      content: file([
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" role="img" aria-label="${escapedProjectName} preview">`,
        `  <rect width="1200" height="630" fill="#10120f"/>`,
        `  <circle cx="1040" cy="80" r="330" fill="#33492d"/>`,
        `  <text x="90" y="210" fill="#b9e7a9" font-family="Arial, sans-serif" font-size="34" font-weight="700">VANILLA WEB STARTER</text>`,
        `  <text x="90" y="355" fill="#f7f7f2" font-family="Arial, sans-serif" font-size="84" font-weight="800">${escapedProjectName}</text>`,
        `  <text x="90" y="440" fill="#aeb3aa" font-family="Arial, sans-serif" font-size="34">Plain HTML, CSS, and JavaScript on Cloudflare</text>`,
        `</svg>`,
      ]),
    },
    { path: "/public/robots.txt", content: "User-agent: *\nAllow: /\n" },
    {
      path: "/scripts/build.mjs",
      content: file([
        `import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";`,
        ``,
        `rmSync("build", { recursive: true, force: true });`,
        `mkdirSync("build/client", { recursive: true });`,
        `mkdirSync("build/server", { recursive: true });`,
        `cpSync("public", "build/client", { recursive: true });`,
        `cpSync("worker.js", "build/server/worker.js");`,
        ``,
        `const rawConfig = readFileSync("wrangler.jsonc", "utf8");`,
        `const config = JSON.parse(rawConfig.replace(/\\/\\/[^\\n]*/g, "").replace(/,(\\s*[}\\]])/g, "$1"));`,
        `const manifest = {`,
        `  main: "worker.js",`,
        `  no_bundle: true,`,
        `  rules: [{ type: "ESModule", globs: ["**/*.js", "**/*.mjs"] }],`,
        `  compatibility_date: config.compatibility_date,`,
        `  compatibility_flags: config.compatibility_flags ?? [],`,
        `  assets: { directory: "../client", binding: "ASSETS" },`,
        `  ...(config.vars ? { vars: config.vars } : {}),`,
        `  ...(config.durable_objects ? { durable_objects: config.durable_objects } : {}),`,
        `  ...(config.migrations ? { migrations: config.migrations } : {}),`,
        `  ...(config.kv_namespaces ? { kv_namespaces: config.kv_namespaces } : {}),`,
        `  ...(config.r2_buckets ? { r2_buckets: config.r2_buckets } : {}),`,
        `  ...(config.bindings ? { bindings: config.bindings } : {}),`,
        `};`,
        `writeFileSync("build/server/wrangler.json", JSON.stringify(manifest, null, 2) + "\\n");`,
      ]),
    },
    {
      path: "/README.md",
      content: file([
        `# ${projectName}`,
        ``,
        `A dependency-light HTML, CSS, and JavaScript project scaffolded by camelAI.`,
        ``,
        `## Structure`,
        ``,
        `- Edit the browser experience in \`public/index.html\`, \`public/styles.css\`, and \`public/main.js\`.`,
        `- \`worker.js\` serves static assets and falls back to \`index.html\` for browser routes. It is also the upgrade seam for small server endpoints.`,
        `- \`bun run build\` copies deployable assets into \`build/client\` and writes the Worker manifest to \`build/server\`.`,
        ``,
        `This starter is best for client-only experiences. If the product needs durable records, accounts, a shared leaderboard, or multiplayer state, the \`crud\` template is usually the better foundation.`,
      ]),
    },
  ];
}

export function defaultProjectScaffoldFiles(
  projectName: string,
  template: ProjectScaffoldTemplate,
  scriptName: string,
): ProjectScaffoldFile[] {
  switch (template) {
    case "crud":
      return crudScaffoldFiles(projectName, scriptName);
    case "vanilla":
      return vanillaScaffoldFiles(projectName, scriptName);
    case "ai-chat":
      return aiChatScaffoldFiles(projectName, scriptName);
    case "integration-dashboard":
      return integrationDashboardScaffoldFiles(projectName, scriptName);
    case "data-dashboard":
      return dataDashboardScaffoldFiles(projectName, scriptName);
    case "data-analysis":
      return defaultDataAnalysisScaffoldFiles(projectName);
  }
}
