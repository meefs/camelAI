// Bundled from sandbox/skills at build time (Wrangler Text imports; Vite ?raw).
import customDomainTroubleshooting from "../../../sandbox/skills/custom-domain-troubleshooting/SKILL.md?raw";
import dataAnalysis from "../../../sandbox/skills/data-analysis/SKILL.md?raw";
import developingSoftwareAiApps from "../../../sandbox/skills/developing-software/AI-APPS.md?raw";
import developingSoftware from "../../../sandbox/skills/developing-software/SKILL.md?raw";
import fileSharing from "../../../sandbox/skills/file-sharing/SKILL.md?raw";
import generatingImages from "../../../sandbox/skills/generating-images/SKILL.md?raw";
import testingDebugging from "../../../sandbox/skills/testing-debugging/SKILL.md?raw";

export const PI_SKILLS_ROOT = "/opt/chiridion-host-pi/skills";

export const PI_SKILL_FILES: Record<string, string> = {
  "custom-domain-troubleshooting/SKILL.md": customDomainTroubleshooting,
  "data-analysis/SKILL.md": dataAnalysis,
  "developing-software/AI-APPS.md": developingSoftwareAiApps,
  "developing-software/SKILL.md": developingSoftware,
  "file-sharing/SKILL.md": fileSharing,
  "generating-images/SKILL.md": generatingImages,
  "testing-debugging/SKILL.md": testingDebugging,
};

export const PI_SKILL_NAMES = [
  "custom-domain-troubleshooting",
  "data-analysis",
  "developing-software",
  "file-sharing",
  "generating-images",
  "testing-debugging",
] as const;
