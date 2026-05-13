#!/usr/bin/env node
import { readdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const skillsRoot = resolve(repoRoot, "sandbox/skills");
const outputPath = resolve(repoRoot, "workers/main/src/pi-skills-bundle.ts");
const check = process.argv.includes("--check");

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

const files = (await listFiles(skillsRoot))
  .map((file) => relative(skillsRoot, file).replaceAll("\\", "/"))
  .sort();

const skillNames = [];
for (const file of files) {
  if (file.endsWith("/SKILL.md")) {
    skillNames.push(file.slice(0, -"/SKILL.md".length));
  }
}

const lines = [
  "// Generated from sandbox/skills so the Worker DO can expose built-in skills without host filesystem access.",
  "// Regenerate with `bun run generate:pi-skills` when sandbox/skills changes.",
  "",
  'export const PI_SKILLS_ROOT = "/opt/chiridion-host-pi/skills";',
  "",
  "export const PI_SKILL_FILES: Record<string, string> = {",
];

for (const file of files) {
  const content = await readFile(resolve(skillsRoot, file), "utf8");
  lines.push(`  ${JSON.stringify(file)}: ${JSON.stringify(content)},`);
}

lines.push("};", "", "export const PI_SKILL_NAMES = [");
for (const name of skillNames.sort()) {
  lines.push(`  ${JSON.stringify(name)},`);
}
lines.push("];", "");

const next = lines.join("\n");

if (check) {
  const current = await readFile(outputPath, "utf8");
  if (current !== next) {
    console.error("workers/main/src/pi-skills-bundle.ts is stale. Run `bun run generate:pi-skills`.");
    process.exit(1);
  }
  process.exit(0);
}

await writeFile(outputPath, next);
