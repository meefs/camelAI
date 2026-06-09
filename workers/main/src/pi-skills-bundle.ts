// Discovered from sandbox/skills at build time via import.meta.glob (Vite ?raw; Wrangler Text).
import { PI_SKILLS_ROOT } from "./pi-system-prompt";

export { PI_SKILLS_ROOT };

const skillModules = import.meta.glob("../../../sandbox/skills/**/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function toSkillRelativePath(globKey: string): string {
  const normalized = globKey.replace(/\\/g, "/");
  const marker = "/sandbox/skills/";
  const idx = normalized.indexOf(marker);
  if (idx >= 0) {
    return normalized.slice(idx + marker.length);
  }
  return normalized.replace(/^(\.\.\/)+/, "").replace(/^sandbox\/skills\//, "");
}

export const PI_SKILL_FILES: Record<string, string> = Object.fromEntries(
  Object.entries(skillModules).map(([path, content]) => [toSkillRelativePath(path), content]),
);

export const PI_SKILL_NAMES = Object.keys(PI_SKILL_FILES)
  .filter((path) => path.endsWith("/SKILL.md"))
  .map((path) => path.slice(0, -"/SKILL.md".length))
  .sort();

function extractSkillDescription(content: string): string | undefined {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  const frontmatter = frontmatterMatch?.[1];
  if (!frontmatter) return undefined;

  const descriptionMatch = frontmatter.match(/^description:\s*(.+)$/m);
  return descriptionMatch?.[1]?.trim();
}

export const PI_SKILL_DESCRIPTIONS: Record<string, string> = Object.fromEntries(
  PI_SKILL_NAMES.flatMap((name) => {
    const description = extractSkillDescription(PI_SKILL_FILES[`${name}/SKILL.md`] ?? "");
    return description ? [[name, description]] : [];
  }),
);
