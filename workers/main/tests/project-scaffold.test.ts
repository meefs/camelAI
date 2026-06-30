import { describe, expect, it } from "vitest";

import { defaultProjectScaffoldFiles, normalizeProjectScaffoldTemplate } from "../src/project-scaffold";

function scaffoldFile(files: Array<{ path: string; content: string }>, path: string): string {
  const file = files.find((candidate) => candidate.path === path);
  if (!file) throw new Error(`Missing scaffold file ${path}`);
  return file.content;
}

describe("normalizeProjectScaffoldTemplate", () => {
  it("defaults to React Router while preserving explicit templates", () => {
    expect(normalizeProjectScaffoldTemplate(undefined)).toBe("react-router");
    expect(normalizeProjectScaffoldTemplate(null)).toBe("react-router");
    expect(normalizeProjectScaffoldTemplate("")).toBe("react-router");
    expect(normalizeProjectScaffoldTemplate("react-router")).toBe("react-router");
    expect(normalizeProjectScaffoldTemplate("worker")).toBe("worker");
    expect(normalizeProjectScaffoldTemplate("api")).toBe("api");
  });
});

describe("defaultProjectScaffoldFiles", () => {
  it("generates the React Router Tailwind/shadcn-style scaffold", () => {
    const files = defaultProjectScaffoldFiles("Demo App", "react-router", "demo-app");

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
      "/app/root.tsx",
      "/app/routes.ts",
      "/app/routes/home.tsx",
      "/app/entry.server.tsx",
      "/workers/app.ts",
      "/public/robots.txt",
      "/public/favicon.svg",
      "/public/og-image.svg",
      "/scripts/build-manifest.mjs",
    ]));

    const packageJson = JSON.parse(scaffoldFile(files, "/package.json"));
    expect(packageJson).toMatchObject({
      type: "module",
      scripts: {
        dev: "react-router dev",
        build: "react-router build && node ./scripts/build-manifest.mjs",
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
        "vite-tsconfig-paths": expect.any(String),
        wrangler: expect.any(String),
      },
    });

    expect(scaffoldFile(files, "/wrangler.jsonc")).toContain('"main": "./workers/app.ts"');
    expect(scaffoldFile(files, "/vite.config.ts")).toContain("tailwindcss()");
    expect(scaffoldFile(files, "/vite.config.ts")).toContain("noExternal: true");
    expect(scaffoldFile(files, "/components.json")).toContain('"ui": "~/components/ui"');
    expect(scaffoldFile(files, "/app/app.css")).toContain('@import "tailwindcss"');
    expect(scaffoldFile(files, "/app/app.css")).toContain("--color-background");
    expect(scaffoldFile(files, "/app/lib/utils.ts")).toContain("twMerge(clsx(inputs))");
    expect(scaffoldFile(files, "/app/components/ui/button.tsx")).toContain("buttonVariants");
    expect(scaffoldFile(files, "/app/routes/home.tsx")).toContain("Browse shadcn components");
    expect(scaffoldFile(files, "/app/root.tsx")).toContain('import "./app.css"');
    expect(scaffoldFile(files, "/app/entry.server.tsx")).toContain("renderToReadableStream");
    expect(scaffoldFile(files, "/workers/app.ts")).toContain("createRequestHandler");
    expect(scaffoldFile(files, "/workers/app.ts")).toContain("env.ASSETS.fetch(request)");
    expect(scaffoldFile(files, "/scripts/build-manifest.mjs")).toContain('main_module: "worker.js"');
    expect(scaffoldFile(files, "/scripts/build-manifest.mjs")).toContain("node_modules/.bin/esbuild");
    expect(scaffoldFile(files, "/scripts/build-manifest.mjs")).toContain("env.ASSETS.fetch(request)");
  });

  it("keeps the explicit bare Worker scaffold available", () => {
    const files = defaultProjectScaffoldFiles("Demo App", "worker", "demo-app");

    expect(files.map((file) => file.path)).toEqual(expect.arrayContaining([
      "/package.json",
      "/wrangler.jsonc",
      "/tsconfig.json",
      "/src/index.ts",
      "/scripts/write-build-manifest.mjs",
    ]));
    expect(files.map((file) => file.path)).not.toContain("/app/root.tsx");

    const packageJson = JSON.parse(scaffoldFile(files, "/package.json"));
    expect(packageJson.scripts.build).toContain("tsc --noEmit");
    expect(packageJson.scripts.build).toContain("build/server/index.js");
    expect(packageJson.devDependencies).toMatchObject({
      typescript: expect.any(String),
      wrangler: expect.any(String),
      "@cloudflare/workers-types": expect.any(String),
    });
    expect(scaffoldFile(files, "/wrangler.jsonc")).toContain('"main": "src/index.ts"');
  });
});
