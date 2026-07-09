import type { WorkspaceFileStoreLike } from "./workspace-filesystem-do";
import {
  SHADCN_NPM_PACKAGE_VERSIONS,
  SHADCN_REGISTRY,
  type ShadcnRegistryItem,
} from "./shadcn-registry.generated";

function registryNamesOfType(type: ShadcnRegistryItem["type"]): readonly string[] {
  return Object.values(SHADCN_REGISTRY)
    .filter((item) => item.type === type)
    .map((item) => item.name)
    .sort();
}

export const SUPPORTED_SHADCN_COMPONENTS: readonly string[] = registryNamesOfType("ui");
export const SUPPORTED_SHADCN_BLOCKS: readonly string[] = registryNamesOfType("block");

export interface AddShadcnComponentsResult {
  success: true;
  components: string[];
  /** All registry items included after dependency resolution. */
  resolvedItems: string[];
  filesWritten: string[];
  filesSkipped: string[];
  /** npm packages added to the project package.json (name@pinnedVersion). */
  packagesAdded: string[];
  message: string;
}

export function normalizeShadcnComponentName(value: unknown): string {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/^@shadcn\//, "");
  const item = SHADCN_REGISTRY[normalized];
  if (item && (item.type === "ui" || item.type === "block")) {
    return normalized;
  }
  throw new Error(
    `Unsupported shadcn component "${String(value ?? "")}". ` +
      `Supported components: ${SUPPORTED_SHADCN_COMPONENTS.join(", ")}. ` +
      `Supported blocks: ${SUPPORTED_SHADCN_BLOCKS.join(", ")}.`,
  );
}

export function normalizeShadcnComponentList(input: {
  component?: unknown;
  components?: unknown;
}): string[] {
  const rawComponents = input.components !== undefined
    ? Array.isArray(input.components) ? input.components : [input.components]
    : input.component !== undefined
      ? [input.component]
      : [];
  const normalized = rawComponents.map(normalizeShadcnComponentName);
  return [...new Set(normalized)];
}

/** Requested items plus the transitive closure of their registry dependencies. */
function resolveRegistryItems(components: string[]): ShadcnRegistryItem[] {
  const resolved = new Map<string, ShadcnRegistryItem>();
  const queue = [...components];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (resolved.has(name)) continue;
    const item = SHADCN_REGISTRY[name];
    if (!item) {
      throw new Error(`shadcn registry is missing dependency "${name}" — regenerate shadcn-registry.generated.ts`);
    }
    resolved.set(name, item);
    queue.push(...item.registryDependencies);
  }
  return [...resolved.values()];
}

async function mergePackageJsonDependencies(
  files: WorkspaceFileStoreLike,
  packages: string[],
): Promise<string[]> {
  if (packages.length === 0) return [];
  const read = await files.readFile("/package.json");
  if (!read.success || typeof read.content !== "string") {
    throw new Error(read.error ?? "Failed to read /package.json to add component dependencies");
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(read.content) as Record<string, unknown>;
  } catch {
    throw new Error("Failed to parse /package.json to add component dependencies");
  }
  const dependencies = { ...(parsed.dependencies as Record<string, string> | undefined) };
  const devDependencies = (parsed.devDependencies ?? {}) as Record<string, string>;
  const added: string[] = [];
  for (const name of packages) {
    if (dependencies[name] || devDependencies[name]) continue;
    const version = SHADCN_NPM_PACKAGE_VERSIONS[name];
    if (!version) {
      throw new Error(`shadcn registry has no pinned version for npm package "${name}" — regenerate shadcn-registry.generated.ts`);
    }
    dependencies[name] = version;
    added.push(`${name}@${version}`);
  }
  if (added.length === 0) return [];
  parsed.dependencies = Object.fromEntries(
    Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)),
  );
  const write = await files.writeFile("/package.json", `${JSON.stringify(parsed, null, 2)}\n`);
  if (!write.success) {
    throw new Error(write.error ?? "Failed to write /package.json with component dependencies");
  }
  return added;
}

export async function addShadcnComponentsToProject(
  files: WorkspaceFileStoreLike,
  components: string[],
  options: { force?: boolean } = {},
): Promise<AddShadcnComponentsResult> {
  if (components.length === 0) {
    throw new Error("component or components is required (any shadcn/ui component or block name).");
  }

  const requested = new Set(components);
  const resolvedItems = resolveRegistryItems(components);

  const filesWritten: string[] = [];
  const filesSkipped: string[] = [];
  const writtenPaths = new Set<string>();
  const itemsWithWrites = new Set<string>();
  for (const item of resolvedItems) {
    // `force` overwrites only files of explicitly requested items; files pulled
    // in as dependencies never clobber existing (possibly customized) copies.
    const forceItem = options.force === true && requested.has(item.name);
    for (const file of item.files) {
      if (writtenPaths.has(file.path)) continue;
      if (!forceItem) {
        const exists = await files.exists(file.path);
        if (exists.exists) {
          filesSkipped.push(file.path);
          continue;
        }
      }
      const result = await files.writeFile(file.path, file.content);
      if (!result.success) {
        throw new Error(result.error ?? `Failed to write ${file.path}`);
      }
      writtenPaths.add(file.path);
      filesWritten.push(file.path);
      itemsWithWrites.add(item.name);
    }
  }

  // Ensure every npm package the resolved items rely on is present, so builds
  // succeed even when a file was skipped but its package was never installed.
  const npmPackages = [...new Set(resolvedItems.flatMap((item) => item.dependencies))].sort();
  const packagesAdded = await mergePackageJsonDependencies(files, npmPackages);

  const blockPagesWritten = filesWritten.filter((path) => path.startsWith("/app/blocks/") && path.endsWith("/page.tsx"));
  const messageParts: string[] = [];
  messageParts.push(
    filesWritten.length > 0
      ? `Added shadcn file${filesWritten.length === 1 ? "" : "s"}: ${filesWritten.join(", ")}`
      : "All requested shadcn files already exist.",
  );
  if (packagesAdded.length > 0) {
    messageParts.push(`Added npm dependencies to package.json: ${packagesAdded.join(", ")} (installed automatically on the next build).`);
  }
  if (blockPagesWritten.length > 0) {
    messageParts.push(
      `Block page${blockPagesWritten.length === 1 ? "" : "s"} (${blockPagesWritten.join(", ")}) export a default React component — register each as a route in app/routes.ts and adapt placeholder content to the app.`,
    );
  }

  return {
    success: true,
    components,
    resolvedItems: resolvedItems.map((item) => item.name).sort(),
    filesWritten,
    filesSkipped,
    packagesAdded,
    message: messageParts.join(" "),
  };
}
