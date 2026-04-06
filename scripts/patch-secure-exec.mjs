import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const targetPath = resolve(
  process.cwd(),
  "node_modules/@secure-exec/nodejs/dist/module-source.js",
);

const originalSnippet = `        try {
            const targetSource = readFileSync(targetPath, "utf-8");
            const [, targetExports] = parse(targetSource, targetPath);
            const names = targetExports
                .map((e) => e.n)
                .filter((n) => typeof n === "string" &&
                n !== "default" &&
                !ownExportNames.has(n));
            if (names.length > 0) {
                // Track these names so subsequent export * don't duplicate
                for (const n of names)
                    ownExportNames.add(n);
                result = result.replace(match[0], \`export { \${names.join(", ")} } from '\${specifier}';\`);
            }
            else {
                result = result.replace(match[0], "");
            }
        }
        catch {
            // If we can't resolve, leave the export * as-is
        }
    }
    return result;
}
function isValidIdentifier(value) {`;

const patchedSnippet = `        try {
            const names = collectNamedExportsForStarResolution(targetPath)
                .filter((n) => n !== "default" && !ownExportNames.has(n));
            if (names.length > 0) {
                // Track these names so subsequent export * don't duplicate
                for (const n of names)
                    ownExportNames.add(n);
                result = result.replace(match[0], \`export { \${names.join(", ")} } from '\${specifier}';\`);
            }
            else {
                result = result.replace(match[0], "");
            }
        }
        catch {
            // If we can't resolve, leave the export * as-is
        }
    }
    return result;
}
function collectNamedExportsForStarResolution(filePath, visited = new Set()) {
    if (visited.has(filePath) || !existsSync(filePath)) {
        return [];
    }
    visited.add(filePath);
    const source = readFileSync(filePath, "utf-8");
    const starExportRegex = /export\\s*\\*\\s*from\\s*['"]([^'"]+)['"]\\s*;?/g;
    const [, ownExports] = parse(source, filePath);
    const names = new Set(ownExports
        .map((e) => e.n)
        .filter((n) => typeof n === "string"));
    let match;
    while ((match = starExportRegex.exec(source)) !== null) {
        const specifier = match[1];
        if (!specifier.startsWith("."))
            continue;
        const targetPath = pathJoin(pathDirname(filePath), specifier);
        for (const name of collectNamedExportsForStarResolution(targetPath, visited)) {
            names.add(name);
        }
    }
    return Array.from(names);
}
function isValidIdentifier(value) {`;

const fileContents = readFileSync(targetPath, "utf8");

if (fileContents.includes("collectNamedExportsForStarResolution")) {
  process.stdout.write("secure-exec patch already applied\n");
  process.exit(0);
}

if (!fileContents.includes(originalSnippet)) {
  process.stderr.write(
    `secure-exec patch target not found in ${targetPath}\n`,
  );
  process.exit(1);
}

writeFileSync(
  targetPath,
  fileContents.replace(originalSnippet, patchedSnippet),
  "utf8",
);

process.stdout.write("applied secure-exec star export patch\n");
