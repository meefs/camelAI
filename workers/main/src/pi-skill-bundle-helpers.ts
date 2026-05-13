import {
  PI_SKILL_FILES,
  PI_SKILLS_ROOT,
} from "./pi-skills-bundle";

export type PiBundledSkillReadResult = {
  text: string;
  path: string;
  size: number;
  encoding: "utf8";
  source: "bundled_skill";
};

export type PiBundledSkillListResult = {
  text: string;
  path: string;
  files: string[];
  source: "bundled_skill";
};

export function normalizePiSkillBundlePath(rawPath: string): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed) return "";
  const candidates = [
    PI_SKILLS_ROOT,
    "/opt/chiridion-host-pi/skills",
    ".agents/skills",
    "/home/claude/.agents/skills",
    "/home/claude/.claude/skills",
  ];
  for (const root of candidates) {
    if (trimmed === root) return "";
    if (trimmed.startsWith(`${root}/`)) {
      return trimmed.slice(root.length + 1).replace(/^\/+/, "");
    }
  }
  return null;
}

export function readPiBundledSkillFile(rawPath: string): PiBundledSkillReadResult | null {
  const normalized = normalizePiSkillBundlePath(rawPath);
  if (!normalized) return null;
  const content = PI_SKILL_FILES[normalized];
  if (typeof content !== "string") return null;
  return {
    text: content,
    path: `${PI_SKILLS_ROOT}/${normalized}`,
    size: content.length,
    encoding: "utf8",
    source: "bundled_skill",
  };
}

export function listPiBundledSkillFiles(rawPath: string): PiBundledSkillListResult | null {
  const normalized = normalizePiSkillBundlePath(rawPath) ?? "";
  const prefix = normalized ? `${normalized.replace(/\/+$/, "")}/` : "";
  const entries = new Set<string>();
  for (const filePath of Object.keys(PI_SKILL_FILES)) {
    if (prefix && !filePath.startsWith(prefix)) continue;
    const rest = prefix ? filePath.slice(prefix.length) : filePath;
    const [entry] = rest.split("/");
    if (entry) entries.add(entry);
  }
  if (entries.size === 0) return null;
  const files = [...entries].sort();
  return {
    text: files.join("\n"),
    path: `${PI_SKILLS_ROOT}${normalized ? `/${normalized}` : ""}`,
    files,
    source: "bundled_skill",
  };
}
