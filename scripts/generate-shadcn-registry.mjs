#!/usr/bin/env node
// Regenerates workers/main/src/shadcn-registry.generated.ts from the public
// shadcn/ui registry (new-york-v4 style). The generated file is the single
// source of truth for the `add_shadcn_component` tool and for the UI
// primitives pre-seeded by the DO-backed project scaffold, so component source
// is delivered server-side without agent tokens or sandbox npm access.
//
// Usage: bun scripts/generate-shadcn-registry.mjs
//
// Transforms applied to registry file contents:
// - `@/registry/new-york-v4/{ui,hooks,lib}/...` and `@/{components,hooks,lib}/...`
//   import aliases are rewritten to the scaffold's `~/` aliases.
// - `import { XIcon } from "lucide-react"` barrel imports are rewritten to the
//   scaffold's deep-import convention (`lucide-react/dist/esm/icons/x.js`),
//   verified against the real icon file list for the scaffold's pinned
//   lucide-react version; unresolvable names keep the barrel import.
// - npm dependency names are pinned to `^<latest>` fetched from the npm
//   registry at generation time.

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REGISTRY_BASE = "https://ui.shadcn.com/r";
const STYLE = "new-york-v4";
// Keep in sync with the scaffold package.json in workers/main/src/project-scaffold.ts.
const LUCIDE_VERSION = "0.562.0";
const OUTPUT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "workers/main/src/shadcn-registry.generated.ts",
);

// Items whose files the scaffold already seeds; registry dependencies on these
// resolve without shipping content twice.
const SCAFFOLD_PROVIDED = new Set(["utils"]);

// Curated blocks. The full shadcn block gallery is large; this list favors the
// shells app-building agents reach for most (auth pages, sidebar layouts, a
// full dashboard) over one-off demos.
const BLOCKS = [
  "login-01",
  "login-02",
  "login-03",
  "login-04",
  "login-05",
  "signup-01",
  "otp-01",
  "sidebar-01",
  "sidebar-02",
  "sidebar-03",
  "sidebar-07",
  "sidebar-08",
  "sidebar-13",
  "sidebar-15",
  "sidebar-16",
  "dashboard-01",
  "calendar-04",
  "calendar-22",
];

async function fetchJson(url, { optional = false } = {}) {
  const response = await fetch(url);
  if (!response.ok) {
    if (optional && response.status === 404) return null;
    throw new Error(`GET ${url} failed: ${response.status}`);
  }
  return await response.json();
}

async function mapConcurrent(items, limit, fn) {
  const results = Array.from({ length: items.length });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index], index);
      }
    }),
  );
  return results;
}

function toKebabCase(value) {
  return value
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/([a-zA-Z])(\d)/g, "$1-$2")
    .toLowerCase();
}

function lucideIconFileCandidates(exportName) {
  const candidates = new Set();
  const base = exportName.replace(/^Lucide/, "");
  for (const name of [base, base.replace(/Icon$/, "")]) {
    if (name) candidates.add(`${toKebabCase(name)}.js`);
  }
  return [...candidates];
}

function rewriteLucideImports(content, iconFiles, warnings, context) {
  return content.replace(
    /import \{([^}]+)\} from "lucide-react"/g,
    (whole, specifiers) => {
      const rewritten = [];
      const unresolved = [];
      for (const rawSpecifier of specifiers.split(",")) {
        const specifier = rawSpecifier.trim();
        if (!specifier) continue;
        const match = /^(\w+)(?:\s+as\s+(\w+))?$/.exec(specifier);
        const sourceName = match?.[1];
        const localName = match?.[2] ?? match?.[1];
        const file = sourceName
          ? lucideIconFileCandidates(sourceName).find((candidate) => iconFiles.has(candidate))
          : undefined;
        if (!file) {
          unresolved.push(specifier);
          continue;
        }
        rewritten.push(`import ${localName} from "lucide-react/dist/esm/icons/${file}"`);
      }
      if (unresolved.length > 0) {
        warnings.push(`${context}: kept lucide barrel import for ${unresolved.join(", ")}`);
        rewritten.push(`import { ${unresolved.join(", ")} } from "lucide-react"`);
      }
      return rewritten.join("\n");
    },
  );
}

function rewriteAliases(content) {
  return content
    .replace(
      new RegExp(`@/registry/${STYLE}/blocks/[\\w-]+/components/`, "g"),
      "~/components/",
    )
    .replaceAll(`@/registry/${STYLE}/ui/`, "~/components/ui/")
    .replaceAll(`@/registry/${STYLE}/hooks/`, "~/hooks/")
    .replaceAll(`@/registry/${STYLE}/lib/`, "~/lib/")
    .replaceAll('from "@/components/', 'from "~/components/')
    .replaceAll('from "@/hooks/', 'from "~/hooks/')
    .replaceAll('from "@/lib/', 'from "~/lib/');
}

function mapRegistryFilePath(itemName, itemType, file) {
  const basename = path.posix.basename(file.path);
  if (file.type === "registry:ui") return `/app/components/ui/${basename}`;
  if (file.type === "registry:hook") return `/app/hooks/${basename}`;
  if (file.type === "registry:lib") return `/app/lib/${basename}`;
  if (itemType === "registry:block") {
    // Preserve the block's internal layout under /app/blocks/<name>/ so
    // relative imports (e.g. ./data.json) keep working; shared components go
    // to /app/components/ to match the `~/components/...` imports the block
    // files use (mirrors shadcn CLI target resolution).
    if (file.type === "registry:component") return `/app/components/${basename}`;
    const marker = `/blocks/${itemName}/`;
    const index = file.path.indexOf(marker);
    const relative = index >= 0 ? file.path.slice(index + marker.length) : basename;
    return `/app/blocks/${itemName}/${relative}`;
  }
  return `/app/components/${basename}`;
}

function normalizeItemType(itemType) {
  if (itemType === "registry:block") return "block";
  if (itemType === "registry:hook") return "hook";
  if (itemType === "registry:lib") return "lib";
  return "ui";
}

async function main() {
  const index = await fetchJson(`${REGISTRY_BASE}/index.json`);
  const uiNames = index
    .filter((item) => item.type === "registry:ui")
    .map((item) => item.name)
    .sort();

  const lucideMeta = await fetchJson(
    `https://unpkg.com/lucide-react@${LUCIDE_VERSION}/dist/esm/icons/?meta`,
  );
  const iconFiles = new Set(
    lucideMeta.files.map((file) => path.posix.basename(file.path)),
  );

  const warnings = [];
  const items = new Map();
  let queue = [...uiNames, ...BLOCKS];
  const seen = new Set(SCAFFOLD_PROVIDED);

  while (queue.length > 0) {
    const batch = queue.filter((name) => !seen.has(name));
    for (const name of batch) seen.add(name);
    queue = [];
    const fetched = await mapConcurrent(batch, 8, async (name) => {
      const item = await fetchJson(`${REGISTRY_BASE}/styles/${STYLE}/${name}.json`, {
        optional: true,
      });
      if (!item) warnings.push(`registry item not found, skipped: ${name}`);
      return item;
    });
    for (const item of fetched) {
      if (!item) continue;
      const registryDependencies = (item.registryDependencies ?? []).filter((dep) => {
        if (/^[\w-]+$/.test(dep)) return true;
        warnings.push(`${item.name}: dropped non-name registry dependency ${dep}`);
        return false;
      });
      items.set(item.name, {
        name: item.name,
        type: normalizeItemType(item.type),
        description: item.description ?? undefined,
        // Entries may embed a version spec (e.g. "react-day-picker@latest");
        // strip it — versions are pinned via SHADCN_NPM_PACKAGE_VERSIONS.
        dependencies: [
          ...new Set(
            (item.dependencies ?? []).map((dep) =>
              dep.startsWith("@")
                ? `@${dep.slice(1).split("@")[0]}`
                : dep.split("@")[0],
            ),
          ),
        ].sort(),
        registryDependencies: registryDependencies
          .filter((dep) => !SCAFFOLD_PROVIDED.has(dep))
          .sort(),
        files: (item.files ?? [])
          .filter((file) => typeof file.content === "string")
          .map((file) => ({
            path: mapRegistryFilePath(item.name, item.type, file),
            content: rewriteLucideImports(
              rewriteAliases(file.content),
              iconFiles,
              warnings,
              `${item.name}:${path.posix.basename(file.path)}`,
            ),
          })),
      });
      for (const dep of registryDependencies) {
        if (!seen.has(dep)) queue.push(dep);
      }
    }
  }

  // Pin npm dependency versions at generation time.
  const npmPackages = [...new Set([...items.values()].flatMap((item) => item.dependencies))].sort();
  const npmVersions = {};
  await mapConcurrent(npmPackages, 8, async (name) => {
    const info = await fetchJson(`https://registry.npmjs.org/${name}/latest`);
    npmVersions[name] = `^${info.version}`;
  });
  // Deep icon-import paths are validated against LUCIDE_VERSION's file list;
  // keep the pin in lockstep with the scaffold rather than floating to latest.
  if (npmVersions["lucide-react"]) {
    npmVersions["lucide-react"] = `^${LUCIDE_VERSION}`;
  }

  // Validate that every internal import resolves to a generated or
  // scaffold-provided file, and registry dependencies resolve to items.
  const generatedPaths = new Set(
    [...items.values()].flatMap((item) => item.files.map((file) => file.path)),
  );
  const providedModules = new Set(["~/lib/utils"]);
  for (const generatedPath of generatedPaths) {
    providedModules.add(
      generatedPath.replace(/^\/app\//, "~/").replace(/\.(tsx|ts)$/, ""),
    );
  }
  for (const item of items.values()) {
    for (const dep of item.registryDependencies) {
      if (!items.has(dep)) {
        throw new Error(`${item.name}: unresolved registry dependency ${dep}`);
      }
    }
    for (const file of item.files) {
      for (const match of file.content.matchAll(/from "(~\/[^"]+)"/g)) {
        if (!providedModules.has(match[1])) {
          throw new Error(`${item.name}: ${file.path} imports unresolved module ${match[1]}`);
        }
      }
      if (file.content.includes('"@/') || file.content.includes("next/")) {
        throw new Error(`${item.name}: ${file.path} still contains an untransformed import`);
      }
    }
  }

  const sortedItems = [...items.values()].sort((a, b) => a.name.localeCompare(b.name));
  const output = [
    "// Generated by scripts/generate-shadcn-registry.mjs — do not edit by hand.",
    `// Source: ${REGISTRY_BASE} style ${STYLE}, generated with lucide-react@${LUCIDE_VERSION} icon paths.`,
    "",
    "export interface ShadcnRegistryFile {",
    "  path: string;",
    "  content: string;",
    "}",
    "",
    "export interface ShadcnRegistryItem {",
    "  name: string;",
    '  type: "ui" | "block" | "hook" | "lib";',
    "  description?: string;",
    "  /** npm packages the item needs, resolved via SHADCN_NPM_PACKAGE_VERSIONS. */",
    "  dependencies: string[];",
    "  /** Other registry item names the item needs. */",
    "  registryDependencies: string[];",
    "  files: ShadcnRegistryFile[];",
    "}",
    "",
    `export const SHADCN_NPM_PACKAGE_VERSIONS: Record<string, string> = ${JSON.stringify(npmVersions, null, 2)};`,
    "",
    `export const SHADCN_REGISTRY: Record<string, ShadcnRegistryItem> = ${JSON.stringify(
      Object.fromEntries(sortedItems.map((item) => [item.name, item])),
      null,
      2,
    )};`,
    "",
  ].join("\n");

  await writeFile(OUTPUT_PATH, output);

  const totalFiles = sortedItems.reduce((sum, item) => sum + item.files.length, 0);
  console.log(
    `Wrote ${OUTPUT_PATH}: ${sortedItems.length} items (${sortedItems.filter((i) => i.type === "ui").length} ui, ${sortedItems.filter((i) => i.type === "block").length} blocks), ${totalFiles} files, ${(output.length / 1024).toFixed(0)} KiB`,
  );
  for (const warning of warnings) console.warn(`warning: ${warning}`);
}

await main();
