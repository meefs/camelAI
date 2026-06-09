#!/usr/bin/env bun

import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PI_SKILLS_ROOT,
  createPiSubagentSystemPrompt,
  createPiSystemPrompt,
  type PiSystemPromptContext,
} from "../workers/main/src/pi-system-prompt";

type PromptKind = "base" | "agent" | "explore" | "all";
type OutputFormat = "markdown" | "text" | "raw" | "json";
type SkillMetadata = {
  names: string[];
  descriptions: Record<string, string>;
};

const DEFAULT_CONTEXT: PiSystemPromptContext = {
  threadId: "{{THREAD_ID}}",
  workspaceId: "{{WORKSPACE_ID}}",
  orgId: "{{ORG_ID}}",
};

function usage(): string {
  return [
    "Usage: bun scripts/print-pi-system-prompt.ts [options]",
    "",
    "Options:",
    "  --kind <base|agent|explore|all>     Prompt to print. Defaults to all.",
    "  --format <markdown|text|raw|json>   Output format. Defaults to markdown.",
    "  --thread-id <id>                    Thread ID to render into the prompt.",
    "  --workspace-id <id>                 Workspace ID to render into the prompt.",
    "  --org-id <id>                       Organization ID to render into the prompt.",
    "  --output <path>                     Write output to a file instead of stdout.",
    "  --help                              Show this help.",
    "",
    "If IDs are omitted, placeholder values are rendered.",
    "Use --format raw with --kind base, --kind agent, or --kind explore to print only",
    "the exact prompt text with no headings or separators.",
  ].join("\n");
}

function readOption(args: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);

  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];

  return undefined;
}

function parseKind(raw: string | undefined): PromptKind {
  const value = raw ?? "all";
  if (value === "base" || value === "agent" || value === "explore" || value === "all") {
    return value;
  }
  throw new Error(`Invalid --kind "${value}". Expected base, agent, explore, or all.`);
}

function parseFormat(raw: string | undefined): OutputFormat {
  const value = raw ?? "markdown";
  if (value === "markdown" || value === "text" || value === "raw" || value === "json") {
    return value;
  }
  throw new Error(`Invalid --format "${value}". Expected markdown, text, raw, or json.`);
}

function extractSkillDescription(content: string): string | undefined {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  const frontmatter = frontmatterMatch?.[1];
  if (!frontmatter) return undefined;

  const descriptionMatch = frontmatter.match(/^description:\s*(.+)$/m);
  return descriptionMatch?.[1]?.trim();
}

async function collectSkillMetadata(root: string): Promise<SkillMetadata> {
  const names: string[] = [];
  const descriptions: Record<string, string> = {};

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        return;
      }
      if (entry.isFile() && entry.name === "SKILL.md") {
        const name = path.relative(root, path.dirname(fullPath)).split(path.sep).join("/");
        const content = await Bun.file(fullPath).text();
        const description = extractSkillDescription(content);
        names.push(name);
        if (description) descriptions[name] = description;
      }
    }));
  }

  await walk(root);
  return { names: names.sort(), descriptions };
}

function selectPrompts(
  kind: PromptKind,
  context: PiSystemPromptContext,
  skillMetadata: SkillMetadata,
): Record<Exclude<PromptKind, "all">, string> | Partial<Record<Exclude<PromptKind, "all">, string>> {
  const options = {
    skillNames: skillMetadata.names,
    skillDescriptions: skillMetadata.descriptions,
  };
  const prompts = {
    base: createPiSystemPrompt(context, options),
    agent: createPiSubagentSystemPrompt(context, "agent", options),
    explore: createPiSubagentSystemPrompt(context, "explore", options),
  };

  if (kind === "all") return prompts;
  return { [kind]: prompts[kind] };
}

function renderMarkdown(
  prompts: Partial<Record<Exclude<PromptKind, "all">, string>>,
  context: PiSystemPromptContext,
  skillMetadata: SkillMetadata,
): string {
  const labels: Record<Exclude<PromptKind, "all">, string> = {
    base: "Base Agent Prompt",
    agent: "Agent Subagent Prompt",
    explore: "Explore Subagent Prompt",
  };
  const sections = Object.entries(prompts).map(([kind, prompt]) =>
    [`## ${labels[kind as Exclude<PromptKind, "all">]}`, "", "```text", prompt, "```"].join("\n"),
  );

  return [
    "# camelAI Pi System Prompt",
    "",
    `Thread ID: ${context.threadId}`,
    `Workspace ID: ${context.workspaceId}`,
    `Organization ID: ${context.orgId}`,
    `Skill root: ${PI_SKILLS_ROOT}`,
    `Skill count: ${skillMetadata.names.length}`,
    "",
    ...sections,
  ].join("\n");
}

function renderText(
  prompts: Partial<Record<Exclude<PromptKind, "all">, string>>,
): string {
  return Object.entries(prompts)
    .map(([kind, prompt]) => [`===== ${kind} =====`, prompt].join("\n"))
    .join("\n\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return;
  }

  const kind = parseKind(readOption(args, "--kind"));
  const format = parseFormat(readOption(args, "--format"));
  const outputPath = readOption(args, "--output");
  if (format === "raw" && kind === "all") {
    throw new Error("--format raw requires --kind base, --kind agent, or --kind explore.");
  }

  const context: PiSystemPromptContext = {
    threadId: readOption(args, "--thread-id") ?? process.env.THREAD_ID ?? DEFAULT_CONTEXT.threadId,
    workspaceId:
      readOption(args, "--workspace-id") ?? process.env.WORKSPACE_ID ?? DEFAULT_CONTEXT.workspaceId,
    orgId: readOption(args, "--org-id") ?? process.env.ORG_ID ?? DEFAULT_CONTEXT.orgId,
  };

  const skillMetadata = await collectSkillMetadata(path.resolve("sandbox/skills"));
  const prompts = selectPrompts(kind, context, skillMetadata);

  const output = format === "json"
    ? JSON.stringify(
      {
        context,
        skillRoot: PI_SKILLS_ROOT,
        skillNames: skillMetadata.names,
        skillDescriptions: skillMetadata.descriptions,
        prompts,
      },
      null,
      2,
    )
    : format === "raw"
      ? Object.values(prompts)[0]
      : format === "text"
        ? renderText(prompts)
        : renderMarkdown(prompts, context, skillMetadata);

  if (outputPath) {
    const resolved = path.resolve(outputPath);
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, `${output}\n`, "utf8");
    console.error(`Wrote ${resolved}`);
    return;
  }

  console.log(output);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
