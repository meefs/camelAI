import { PI_SKILL_FILES } from "./pi-skills-bundle";

export type PiBundledSkillReadResult = {
  text: string;
  skill: string;
  file: string;
  size: number;
  encoding: "utf8";
  source: "bundled_skill";
};

export function readPiBundledSkillFile(
  skill: string,
  file: string,
): PiBundledSkillReadResult | null {
  const content = PI_SKILL_FILES[`${skill}/${file}`];
  if (typeof content !== "string") return null;
  return {
    text: content,
    skill,
    file,
    size: content.length,
    encoding: "utf8",
    source: "bundled_skill",
  };
}

export function listPiBundledSkillFiles(skill: string): string[] {
  const prefix = `${skill}/`;
  const files: string[] = [];
  for (const filePath of Object.keys(PI_SKILL_FILES)) {
    if (filePath.startsWith(prefix)) files.push(filePath.slice(prefix.length));
  }
  return files.sort();
}
