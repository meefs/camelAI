#!/usr/bin/env bun

import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FORBIDDEN_MODULE_PATTERN = /(["'`])(lucide-react\/dynamic[^"'`]*)\1/g;

export interface ForbiddenLucideModuleReference {
  moduleName: string;
  line: number;
  column: number;
}

export function findForbiddenLucideModuleReferences(
  source: string,
): ForbiddenLucideModuleReference[] {
  return [...source.matchAll(FORBIDDEN_MODULE_PATTERN)].map((match) => {
    const index = match.index;
    const beforeMatch = source.slice(0, index);
    const lineStart = beforeMatch.lastIndexOf("\n") + 1;
    return {
      moduleName: match[2],
      line: 1 + (beforeMatch.match(/\n/g)?.length ?? 0),
      column: index - lineStart + 1,
    };
  });
}

async function listRuntimeTypeScriptFiles(sourceRoot: string): Promise<string[]> {
  const directories = [sourceRoot];
  const files: string[] = [];

  while (directories.length > 0) {
    const directory = directories.pop();
    if (!directory) continue;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(path);
      } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
        files.push(path);
      }
    }
  }

  return files.sort();
}

export async function checkRuntimeLucideImports(
  sourceRoot: string,
): Promise<{ checkedFiles: number; violations: string[] }> {
  const files = await listRuntimeTypeScriptFiles(sourceRoot);
  const violations: string[] = [];

  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const match of findForbiddenLucideModuleReferences(source)) {
      violations.push(
        `${relative(sourceRoot, file)}:${match.line}:${match.column} references ${match.moduleName}`,
      );
    }
  }

  return { checkedFiles: files.length, violations };
}

async function main() {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const sourceRoot = resolve(repositoryRoot, "src");
  const result = await checkRuntimeLucideImports(sourceRoot);

  if (result.violations.length > 0) {
    console.error("Forbidden runtime Lucide dynamic imports found:");
    for (const violation of result.violations) console.error(`  ${violation}`);
    console.error("Use the generated Lucide sprite or a static icon import instead.");
    process.exitCode = 1;
    return;
  }

  console.log(
    `Runtime Lucide import guard passed (${result.checkedFiles} files scanned).`,
  );
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main();
}
