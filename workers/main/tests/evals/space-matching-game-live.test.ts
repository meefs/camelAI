import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createOrg, createUser, type TestEnv } from "../test-helpers";
import {
  assertPassFailCriteria,
  buildEvalCriteriaSummary,
  buildSessionCompletedCriterion,
  passFailCriterion,
  scoreCriterion,
  scoreLatestPreview,
  scoreSignalEfficiency,
} from "./eval-criteria";
import {
  evaluateAgentEvalSignal,
  getEvalSignalThresholds,
  type EvalSignalEnv,
} from "./eval-signal";
import {
  configureEvalModel,
  getEvalTimeoutMs,
  type EvalModelEnv,
} from "./model-config";
import { isRealEvalDeployEnabled } from "../../src/eval-deploy-context";
import {
  assertDeployedApp,
  countWorkspaceApps,
  type EvalDeployedApp,
} from "./eval-deploy-assert";
import { emitEvalTranscript } from "./eval-transcript";
import type { ChatThreadDO } from "../../src/chat-thread-do";
import type {
  WorkspaceFilesystemDO,
  WorkspaceProject,
} from "../../src/workspace-filesystem-do";

type SpaceMatchingGameEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  APP_DB?: D1Database;
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  WORKSPACE_FS: DurableObjectNamespace<WorkspaceFilesystemDO>;
  PROJECT_RUNTIME_HOST: Fetcher;
  RUN_AGENT_EVALS?: string;
  EVAL_REAL_DEPLOY?: string;
  CF_API_TOKEN?: string;
};

type RuntimeFileEntry = {
  name?: string;
  type?: string;
  size?: number;
  relativePath?: string;
  absolutePath?: string;
};

type RuntimeItem = Record<string, unknown>;

type RuntimeEvidence = {
  commands: string[];
  jsExecCodeBlocks: string[];
  jsExecResultTexts: string[];
  tools: string[];
};

type SourceFile = {
  path: string;
  text: string;
  size: number;
};

type SourceInspection = {
  appDir?: string;
  checkedFiles: string[];
  sourceFiles: Array<{ path: string; size: number }>;
  taskFiles?: string[];
  packageName?: string;
  deployScript?: string;
  signalHits: Record<string, string[]>;
  persistenceFiles: string[];
  failures: string[];
  error?: string;
};

type ProjectMetadata = {
  id: string;
  name: string;
  description: string;
  defaultVmId: string;
  kind?: WorkspaceProject["kind"];
  clonedFromProjectId?: string;
  artifactRemote?: string;
  artifactStatus?: WorkspaceProject["artifactStatus"];
  createdAt: string;
  updatedAt: string;
};

type ProjectCreationInspection = {
  initialProjects: ProjectMetadata[];
  finalProjects: ProjectMetadata[];
  newProjects: ProjectMetadata[];
  selectedProject?: ProjectMetadata;
  failures: string[];
};

type SourceInspectionCandidate = {
  project: ProjectMetadata;
  score: number;
  appDir?: string;
  packageName?: string;
  deployScript?: string;
  sourceFileCount: number;
  failures: string[];
};

type PageSmoke = {
  url?: string;
  status?: number;
  bodyLength?: number;
  errorStrings: string[];
  error?: string;
};

const EVAL_ID = "space-matching-game-live";
const APP_NAME_HINTS = [
  "space-matching-game",
  "space-game",
  "matching-game",
  "space-memory",
  "memory-game",
];
const testEnv = env as unknown as SpaceMatchingGameEvalEnv;
// This eval needs the real testing-grounds deploy path because it asserts a live app.
const maybeIt = isRealEvalDeployEnabled(testEnv) ? it : it.skip;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function runtimeUrl(
  projectId: string,
  subpath: string,
  params: Record<string, string>,
): string {
  const url = new URL(
    `http://runtime.test/v1/projects/${encodeURIComponent(projectId)}${subpath}`,
  );
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

async function listRuntimeFiles(
  runtime: Fetcher,
  projectId: string,
  directory: string,
  recursive = false,
): Promise<RuntimeFileEntry[]> {
  const response = await runtime.fetch(
    runtimeUrl(projectId, "/fs/list", {
      path: directory,
      ...(recursive ? { recursive: "1" } : {}),
    }),
  );
  if (!response.ok) return [];
  const body = await response.json() as { files?: RuntimeFileEntry[] };
  return Array.isArray(body.files) ? body.files : [];
}

async function readRuntimeText(
  runtime: Fetcher,
  projectId: string,
  filePath: string,
): Promise<string | undefined> {
  const response = await runtime.fetch(
    runtimeUrl(projectId, "/fs/read", { path: filePath }),
  );
  if (!response.ok) return undefined;
  return await response.text();
}

function joinVmPath(base: string, child: string): string {
  return `${base.replace(/\/+$/, "")}/${child.replace(/^\/+/, "")}`;
}

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

function lowerText(value: unknown): string {
  return JSON.stringify(value).toLowerCase();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasTerm(text: string, term: string): boolean {
  const pattern = escapeRegex(term.trim()).replace(/\s+/g, "\\s+");
  return new RegExp(`(^|[^a-z0-9_])${pattern}([^a-z0-9_]|$)`, "i").test(text);
}

function containsAny(text: string, terms: string[]): boolean {
  return terms.some((term) => hasTerm(text, term));
}

function hitsFor(text: string, terms: string[]): string[] {
  return terms.filter((term) => hasTerm(text, term));
}

function parseJsonObject(text: string | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return asRecord(parsed) ?? {};
  } catch {
    return {};
  }
}

function projectMetadata(project: WorkspaceProject): ProjectMetadata {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    defaultVmId: project.defaultVmId,
    kind: project.kind,
    clonedFromProjectId: project.clonedFromProjectId,
    artifactRemote: project.artifactRemote,
    artifactStatus: project.artifactStatus,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function diffNewProjects(
  initialProjects: WorkspaceProject[],
  finalProjects: WorkspaceProject[],
): WorkspaceProject[] {
  const initialIds = new Set(initialProjects.map((project) => project.id));
  return finalProjects.filter((project) => !initialIds.has(project.id));
}

function describeProjects(projects: WorkspaceProject[]): string {
  return projects
    .map((project) => `${project.name} (${project.id})`)
    .join(", ");
}

function buildProjectCreationInspection(
  initialProjects: WorkspaceProject[],
  finalProjects: WorkspaceProject[],
  selectedProject?: WorkspaceProject,
): ProjectCreationInspection {
  const newProjects = diffNewProjects(initialProjects, finalProjects);
  const failures: string[] = [];
  if (initialProjects.length > 0) {
    failures.push(
      `harness/environment failure: workspace started with existing project(s): ${
        describeProjects(initialProjects)
      }`,
    );
  } else if (newProjects.length === 0) {
    failures.push("agent failed to create a project from the empty workspace");
  }

  return {
    initialProjects: initialProjects.map(projectMetadata),
    finalProjects: finalProjects.map(projectMetadata),
    newProjects: newProjects.map(projectMetadata),
    selectedProject: selectedProject ? projectMetadata(selectedProject) : undefined,
    failures,
  };
}

function collectRuntimeItems(events: Array<Record<string, unknown>>): RuntimeItem[] {
  const items: RuntimeItem[] = [];
  for (const rawEvent of events) {
    const event = asRecord(rawEvent);
    if (event?.type !== "runtime_event") continue;
    const runtimeEvent = asRecord(event.event);
    if (runtimeEvent?.method !== "item/completed") continue;
    const params = asRecord(runtimeEvent.params);
    const item = asRecord(params?.item);
    if (item) items.push(item);
  }
  return items;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function runtimeToolName(item: RuntimeItem): string | undefined {
  return asString(item.tool)?.toLowerCase();
}

function isJsExecItem(item: RuntimeItem): boolean {
  const tool = runtimeToolName(item);
  return tool === "js_exec" || tool?.endsWith("__js_exec") === true;
}

function resultText(value: unknown): string {
  const record = asRecord(value);
  if (!record) return typeof value === "string" ? value : "";
  const text = asString(record.text);
  if (text) return text;
  const content = record.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => asString(asRecord(part)?.text) ?? "")
    .filter(Boolean)
    .join("\n");
}

function extractJsStringLiterals(code: string): string[] {
  const literals: string[] = [];
  const pattern = /(["'`])((?:\\[\s\S]|(?!\1)[\s\S])*?)\1/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(code)) !== null) {
    literals.push(match[2]);
  }
  return literals;
}

function extractCommandEvidenceFromJsExec(code: string): string[] {
  const commandSignal =
    /\b(create-worker|bun\s+run\s+deploy|wrangler\s+init|npm\s+create\s+cloudflare|pnpm\s+create\s+cloudflare|yarn\s+create\s+cloudflare)\b/i;
  const stripped = stripComments(code);
  return uniqueStrings(
    extractJsStringLiterals(stripped).filter((literal) =>
      commandSignal.test(literal),
    ),
  );
}

function jsExecCodeMentionsTool(code: string, toolName: string): boolean {
  const stripped = stripComments(code);
  const escaped = escapeRegex(toolName);
  return [
    new RegExp(`\\btools\\s*\\.\\s*${escaped}\\s*\\(`, "i"),
    new RegExp(`\\btools\\s*\\[\\s*(["'\`])${escaped}\\1\\s*\\]\\s*\\(`, "i"),
    new RegExp(`\\bcallTool\\s*\\(\\s*(["'\`])${escaped}\\1`, "i"),
  ].some((pattern) => pattern.test(stripped));
}

function collectRuntimeEvidence(events: Array<Record<string, unknown>>): RuntimeEvidence {
  const items = collectRuntimeItems(events);
  const jsExecCodeBlocks = items
    .filter(isJsExecItem)
    .map((item) => asString(asRecord(item.arguments)?.code) ?? "")
    .filter(Boolean);
  const jsExecResultTexts = items
    .filter(isJsExecItem)
    .map((item) => resultText(item.result))
    .filter(Boolean);

  const topLevelCommands = items
    .filter((item) => item.type === "commandExecution")
    .map((item) => asString(item.command) ?? "")
    .filter(Boolean);
  const jsExecCommands = jsExecCodeBlocks.flatMap(extractCommandEvidenceFromJsExec);
  const topLevelTools = items
    .map(runtimeToolName)
    .filter((tool): tool is string => Boolean(tool));

  return {
    commands: uniqueStrings([...topLevelCommands, ...jsExecCommands]),
    jsExecCodeBlocks,
    jsExecResultTexts,
    tools: uniqueStrings(topLevelTools),
  };
}

function usedTool(events: Array<Record<string, unknown>>, toolName: string): boolean {
  const expected = toolName.toLowerCase();
  const evidence = collectRuntimeEvidence(events);
  return (
    evidence.tools.some((tool) => tool === expected || tool.endsWith(`__${expected}`)) ||
    evidence.jsExecCodeBlocks.some((code) => jsExecCodeMentionsTool(code, expected))
  );
}

function readDevelopingSoftwareSkill(
  events: Array<Record<string, unknown>>,
): boolean {
  const evidence = collectRuntimeEvidence(events);
  if (collectRuntimeItems(events).some((item) => {
    const tool = asString(item.tool)?.toLowerCase();
    if (tool !== "read") return false;
    const args = asRecord(item.arguments);
    const result = asRecord(item.result);
    const details = asRecord(result?.details);
    const pathText = [
      asString(args?.path),
      asString(details?.path),
    ].filter(Boolean).join(" ").toLowerCase();
    const itemText = lowerText(item);
    return (
      pathText.includes("developing-software/skill.md") &&
      (
        details?.source === "bundled_skill" ||
        itemText.includes("deploying software to cloudflare") ||
        itemText.includes("use `create-worker`")
      )
    );
  })) {
    return true;
  }

  return (
    evidence.jsExecCodeBlocks.some((code) => {
      const lowerCode = stripComments(code).toLowerCase();
      return (
        lowerCode.includes("developing-software/skill.md") &&
        jsExecCodeMentionsTool(code, "read")
      );
    }) ||
    evidence.jsExecResultTexts.some((text) => {
      const lower = text.toLowerCase();
      return (
        lower.includes("deploying software to cloudflare") ||
        lower.includes("use `create-worker`")
      );
    })
  );
}

function evaluateRuntimeAssertions(
  result: { events: Array<Record<string, unknown>> },
): {
  commands: string[];
  failures: string[];
} {
  const evidence = collectRuntimeEvidence(result.events);
  const commands = evidence.commands;
  const commandSignalText = [
    ...commands,
    ...evidence.jsExecCodeBlocks.map(stripComments),
  ].join("\n").toLowerCase();
  const failures: string[] = [];

  if (!readDevelopingSoftwareSkill(result.events)) {
    failures.push("agent did not read developing-software/SKILL.md");
  }
  if (!/\bcreate-worker\b/.test(commandSignalText)) {
    failures.push("agent did not run the create-worker scaffold command");
  }
  if (!/\bbun\s+run\s+deploy\b/.test(commandSignalText)) {
    failures.push("agent did not run bun run deploy");
  }
  if (!usedTool(result.events, "list_apps")) {
    failures.push("agent did not call list_apps after deploy");
  }
  if (!usedTool(result.events, "set_preview")) {
    failures.push("agent did not call set_preview for the deployed app");
  }

  const wrongScaffoldCommands = commands.filter((command) =>
    /\b(wrangler\s+init|npm\s+create\s+cloudflare|pnpm\s+create\s+cloudflare|yarn\s+create\s+cloudflare)\b/i
      .test(command),
  );
  if (
    wrongScaffoldCommands.length === 0 &&
    evidence.jsExecCodeBlocks.some((code) =>
      /\b(wrangler\s+init|npm\s+create\s+cloudflare|pnpm\s+create\s+cloudflare|yarn\s+create\s+cloudflare)\b/i
        .test(stripComments(code)),
    )
  ) {
    wrongScaffoldCommands.push("js_exec code referenced unsupported scaffold command");
  }
  if (wrongScaffoldCommands.length > 0) {
    failures.push(
      `agent used unsupported scaffold command(s): ${wrongScaffoldCommands.join(" | ")}`,
    );
  }

  return { commands, failures };
}

function buildPostDeployToolCriteria(runtimeAssertions: { failures: string[] }) {
  const listAppsFailure = runtimeAssertions.failures.find((failure) =>
    failure.includes("list_apps"),
  );
  const setPreviewFailure = runtimeAssertions.failures.find((failure) =>
    failure.includes("set_preview"),
  );

  return [
    passFailCriterion({
      id: "called_list_apps",
      label: "Agent called list_apps after deploy",
      passed: !listAppsFailure,
      reason: listAppsFailure,
      details: { failures: runtimeAssertions.failures },
    }),
    passFailCriterion({
      id: "called_set_preview",
      label: "Agent called set_preview for the deployed app",
      passed: !setPreviewFailure,
      reason: setPreviewFailure,
      details: { failures: runtimeAssertions.failures },
    }),
  ];
}

function normalizedName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function resemblesPromptApp(value: string): boolean {
  const normalized = normalizedName(value);
  return APP_NAME_HINTS.some((hint) => normalized.includes(hint));
}

function runtimeEntryPath(parent: string, entry: RuntimeFileEntry): string | undefined {
  if (entry.absolutePath) return entry.absolutePath;
  const child = entry.relativePath ?? entry.name;
  return child ? joinVmPath(parent, child) : undefined;
}

function shouldSearchDirectory(directory: string): boolean {
  const name = directory.split("/").pop() ?? "";
  return !/^(?:node_modules|\.wrangler|\.react-router|dist|build|coverage|public)$/
    .test(name);
}

async function findGeneratedAppDir(
  runtime: Fetcher,
  projectId: string,
): Promise<string | undefined> {
  const topLevel = await listRuntimeFiles(runtime, projectId, "/workspace");
  const candidates = new Set<string>(["/workspace"]);
  const topLevelDirs = topLevel
    .filter((entry) => entry.type === "directory")
    .map((entry) => runtimeEntryPath("/workspace", entry))
    .filter((directory): directory is string => Boolean(directory))
    .filter(shouldSearchDirectory);

  for (const directory of topLevelDirs) {
    candidates.add(directory);
    const children = await listRuntimeFiles(runtime, projectId, directory);
    for (const child of children) {
      if (child.type !== "directory") continue;
      const childPath = runtimeEntryPath(directory, child);
      if (childPath && shouldSearchDirectory(childPath)) candidates.add(childPath);
    }
  }

  const scored: Array<{ dir: string; score: number }> = [];
  for (const dir of candidates.values()) {
    const packageJson = await readRuntimeText(
      runtime,
      projectId,
      joinVmPath(dir, "package.json"),
    );
    if (!packageJson) continue;
    const hasComponentsJson =
      (await readRuntimeText(runtime, projectId, joinVmPath(dir, "components.json"))) !==
      undefined;
    const hasWrangler =
      (await readRuntimeText(runtime, projectId, joinVmPath(dir, "wrangler.jsonc"))) !==
      undefined;
    const wrangler = hasWrangler
      ? await readRuntimeText(runtime, projectId, joinVmPath(dir, "wrangler.jsonc"))
      : undefined;
    const activeWrangler = stripComments(wrangler ?? "").toLowerCase();
    let score = 1;
    const parsedPackage = parseJsonObject(packageJson);
    const packageName = asString(parsedPackage.name) ?? "";
    const scripts = asRecord(parsedPackage.scripts) ?? {};
    const dependencies = asRecord(parsedPackage.dependencies) ?? {};
    const devDependencies = asRecord(parsedPackage.devDependencies) ?? {};
    const deployScript = asString(scripts.deploy) ?? "";
    if (resemblesPromptApp(packageName)) score += 4;
    if (resemblesPromptApp(dir)) score += 4;
    if (hasComponentsJson) score += 3;
    if (hasWrangler) score += 3;
    if (dependencies.react && dependencies["react-dom"] && dependencies["react-router"]) {
      score += 4;
    }
    if (devDependencies["@cloudflare/vite-plugin"] && devDependencies.wrangler) {
      score += 4;
    }
    if (deployScript.includes("wrangler deploy")) score += 3;
    if (deployScript.includes("dispatch-namespace")) score += 3;
    if (activeWrangler.includes('"main": "./workers/app.ts"')) score += 4;
    if (activeWrangler.includes('"assets"') && activeWrangler.includes('"binding": "assets"')) {
      score += 2;
    }
    scored.push({ dir, score });
  }

  return scored.sort((a, b) => b.score - a.score || a.dir.length - b.dir.length)[0]?.dir;
}

async function collectSourceFiles(
  runtime: Fetcher,
  projectId: string,
  appDir: string,
): Promise<SourceFile[]> {
  const sourceFiles = new Map<string, SourceFile>();
  const roots = ["app", "workers", "src"];
  const rootFiles = [
    "package.json",
    "components.json",
    "wrangler.jsonc",
    "react-router.config.ts",
  ];
  const sourceExtension = /\.(?:tsx?|jsx?|css|json|jsonc)$/i;
  const excluded =
    /(?:^|\/)(node_modules|\.wrangler|\.react-router|dist|build|public|coverage)(?:\/|$)|bun\.lock$/;

  async function addFile(filePath: string): Promise<void> {
    if (sourceFiles.has(filePath) || excluded.test(filePath) || !sourceExtension.test(filePath)) {
      return;
    }
    const text = await readRuntimeText(runtime, projectId, filePath);
    if (text === undefined) return;
    sourceFiles.set(filePath, { path: filePath, text, size: text.length });
  }

  for (const file of rootFiles) {
    await addFile(joinVmPath(appDir, file));
  }

  for (const root of roots) {
    const rootPath = joinVmPath(appDir, root);
    const entries = await listRuntimeFiles(runtime, projectId, rootPath, true);
    for (const entry of entries) {
      if (entry.type !== "file") continue;
      const filePath =
        entry.absolutePath ??
        joinVmPath(rootPath, entry.relativePath ?? entry.name ?? "");
      await addFile(filePath);
    }
  }

  return [...sourceFiles.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function inspectCollectedSource(
  appDir: string,
  sourceFiles: SourceFile[],
): SourceInspection {
  const textByBasename = new Map(
    sourceFiles.map((file) => [file.path.slice(appDir.length + 1), file.text]),
  );
  const packageJson = parseJsonObject(textByBasename.get("package.json"));
  const scripts = asRecord(packageJson.scripts) ?? {};
  const dependencies = asRecord(packageJson.dependencies) ?? {};
  const devDependencies = asRecord(packageJson.devDependencies) ?? {};
  const componentsJson = parseJsonObject(textByBasename.get("components.json"));
  const wrangler = textByBasename.get("wrangler.jsonc") ?? "";
  const activeWrangler = stripComments(wrangler).toLowerCase();
  const activeSourceText = sourceFiles
    .map((file) => stripComments(file.text))
    .join("\n")
    .toLowerCase();
  const taskTerms = [
    "matching",
    "match",
    "memory",
    "leaderboard",
    "score",
    "space",
    "planet",
    "star",
    "stars",
    "rocket",
    "galaxy",
    "card",
    "tile",
  ];
  const taskFiles = sourceFiles.filter((file) =>
    containsAny(stripComments(file.text).toLowerCase(), taskTerms),
  );
  const taskSourceText = taskFiles
    .map((file) => stripComments(file.text))
    .join("\n")
    .toLowerCase();

  const signalTerms = {
    matchingGame: [
      "matching",
      "match",
      "memory",
      "card",
      "cards",
      "tile",
      "tiles",
      "flip",
      "flipped",
      "matched",
      "shuffle",
    ],
    leaderboard: ["leaderboard", "score", "high score", "best score"],
    credentials: [
      "credential",
      "credentials",
      "username",
      "player",
      "players",
      "player name",
      "email",
      "password",
    ],
    spaceTheme: [
      "space",
      "planet",
      "planets",
      "star",
      "stars",
      "galaxy",
      "rocket",
      "astronaut",
      "nebula",
      "orbit",
      "cosmic",
      "asteroid",
      "moon",
      "comet",
    ],
  };
  const signalHits = Object.fromEntries(
    Object.entries(signalTerms).map(([name, terms]) => [
      name,
      hitsFor(taskSourceText, terms),
    ]),
  );

  const persistenceFiles = sourceFiles
    .filter((file) => {
      const text = stripComments(file.text).toLowerCase();
      return (
        containsAny(text, [
          "durableobject",
          "storage.sql",
          "ctx.storage.sql",
          "sql.exec",
          "create table",
        ]) &&
        containsAny(text, ["score", "leaderboard", "player", "credential", "user"])
      );
    })
    .map((file) => file.path.slice(appDir.length + 1));

  const failures: string[] = [];
  const deployScript = asString(scripts.deploy);
  if (!deployScript?.includes("wrangler deploy") || !deployScript.includes("dispatch-namespace")) {
    failures.push("package.json deploy script does not deploy with wrangler dispatch namespace");
  }
  if (!dependencies["react-router"] || !dependencies.react || !dependencies["react-dom"]) {
    failures.push("package.json is missing React/React Router scaffold dependencies");
  }
  if (!devDependencies["@cloudflare/vite-plugin"] || !devDependencies.wrangler) {
    failures.push("package.json is missing Cloudflare Vite/Wrangler dev dependencies");
  }
  if (
    componentsJson["$schema"] !== "https://ui.shadcn.com/schema.json" ||
    componentsJson.tsx !== true ||
    componentsJson.iconLibrary !== "lucide" ||
    !asRecord(componentsJson.tailwind)
  ) {
    failures.push("components.json does not look like a shadcn/ui configuration");
  }
  if (!activeWrangler.includes('"main": "./workers/app.ts"')) {
    failures.push("wrangler.jsonc does not point at the create-worker Worker entrypoint");
  }
  if (!activeWrangler.includes('"assets"') || !activeWrangler.includes('"binding": "assets"')) {
    failures.push("wrangler.jsonc is missing the create-worker static assets binding");
  }
  if (!activeSourceText.includes("@react-router/dev/routes")) {
    failures.push("app source is missing React Router route configuration");
  }
  if (
    !activeWrangler.includes('"durable_objects"') ||
    !activeWrangler.includes('"new_sqlite_classes"') ||
    persistenceFiles.length === 0
  ) {
    failures.push("source does not show leaderboard persistence with Durable Objects + SQLite");
  }
  if (signalHits.matchingGame.length < 4) {
    failures.push("source does not show enough matching-game mechanics");
  }
  if (signalHits.leaderboard.length < 2) {
    failures.push("source does not show leaderboard/high-score behavior");
  }
  if (
    signalHits.credentials.length < 2 ||
    !/\b(input|form|action|method=["']post|onsubmit|submit)\b/i.test(taskSourceText)
  ) {
    failures.push("source does not show a credential/name entry flow for high scores");
  }
  if (signalHits.spaceTheme.length < 3) {
    failures.push("source does not show a clear space theme");
  }

  return {
    appDir,
    checkedFiles: sourceFiles.map((file) => file.path.slice(appDir.length + 1)),
    sourceFiles: sourceFiles.map((file) => ({
      path: file.path.slice(appDir.length + 1),
      size: file.size,
    })),
    taskFiles: taskFiles.map((file) => file.path.slice(appDir.length + 1)),
    packageName: asString(packageJson.name),
    deployScript,
    signalHits,
    persistenceFiles,
    failures,
  };
}

async function inspectSource(
  runtime: Fetcher,
  projectId: string,
): Promise<SourceInspection> {
  try {
    const appDir = await findGeneratedAppDir(runtime, projectId);
    if (!appDir) {
      return {
        checkedFiles: [],
        sourceFiles: [],
        signalHits: {},
        persistenceFiles: [],
        failures: ["could not find a generated app directory with package.json"],
      };
    }

    const sourceFiles = await collectSourceFiles(runtime, projectId, appDir);
    return inspectCollectedSource(appDir, sourceFiles);
  } catch (error) {
    return {
      checkedFiles: [],
      sourceFiles: [],
      signalHits: {},
      persistenceFiles: [],
      failures: ["source inspection failed"],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function missingProjectSourceInspection(): SourceInspection {
  return {
    checkedFiles: [],
    sourceFiles: [],
    signalHits: {},
    persistenceFiles: [],
    failures: ["agent did not create a project for source inspection"],
  };
}

async function smokeFetchRoot(app: EvalDeployedApp | undefined): Promise<PageSmoke> {
  if (!app) {
    return {
      errorStrings: [],
      error: "No deployed app URL was captured.",
    };
  }
  try {
    const response = await fetch(app.url, { redirect: "follow" });
    const body = await response.text();
    const lower = body.toLowerCase();
    const errorStrings = [
      "oops",
      "application error",
      "internal server error",
      "not found",
      "stack",
    ].filter((term) => lower.includes(term));
    return {
      url: app.url,
      status: response.status,
      bodyLength: body.length,
      errorStrings,
    };
  } catch (error) {
    return {
      url: app.url,
      errorStrings: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function sourceInspectionScore(inspection: SourceInspection): number {
  const signalHitCount = Object.values(inspection.signalHits).reduce(
    (total, hits) => total + hits.length,
    0,
  );
  return (
    (inspection.appDir ? 20 : 0) +
    inspection.sourceFiles.length +
    signalHitCount +
    (inspection.deployScript ? 5 : 0) +
    (inspection.persistenceFiles.length > 0 ? 5 : 0) -
    inspection.failures.length * 25
  );
}

async function inspectCreatedProjectSources(
  runtime: Fetcher,
  projects: WorkspaceProject[],
): Promise<{
  selectedProject?: WorkspaceProject;
  sourceInspection: SourceInspection;
  sourceInspectionCandidates: SourceInspectionCandidate[];
}> {
  const inspected = await Promise.all(
    projects.map(async (project) => {
      const inspection = await inspectSource(runtime, project.id);
      return {
        project,
        inspection,
        score: sourceInspectionScore(inspection),
      };
    }),
  );
  const selected = inspected.sort((a, b) => b.score - a.score)[0];

  return {
    selectedProject: selected?.project,
    sourceInspection: selected?.inspection ?? missingProjectSourceInspection(),
    sourceInspectionCandidates: inspected.map(({ project, inspection, score }) => ({
      project: projectMetadata(project),
      score,
      appDir: inspection.appDir,
      packageName: inspection.packageName,
      deployScript: inspection.deployScript,
      sourceFileCount: inspection.sourceFiles.length,
      failures: inspection.failures,
    })),
  };
}

function completedRuntimeItem(item: RuntimeItem): Record<string, unknown> {
  return {
    type: "runtime_event",
    event: {
      method: "item/completed",
      params: { item },
    },
  };
}

describe("space matching game runtime assertion extraction", () => {
  it("does not treat bare tool-name mentions as tool calls", () => {
    expect(jsExecCodeMentionsTool('const next = "list_apps";', "list_apps")).toBe(false);
    expect(jsExecCodeMentionsTool("list_apps;", "list_apps")).toBe(false);
    expect(jsExecCodeMentionsTool("await tools.list_apps({});", "list_apps")).toBe(true);
    expect(jsExecCodeMentionsTool('await callTool("set_preview", {});', "set_preview")).toBe(true);
  });

  it("accepts valid deploy behavior routed through js_exec", () => {
    const code = `
      const project = await env.PROJECTS.create({
        name: "space-matching-game",
        description: "Space themed matching game",
      });
      await tools.read({ location: "workspace", path: "developing-software/SKILL.md" });
      await vm.exec({ project: project.name, command: "create-worker space-matching-game" });
      await vm.exec({ project: project.name, command: "bun run deploy", timeoutSeconds: 120 });
      await tools.list_apps({});
      await tools.set_preview({ app_name: "space-matching-game" });
    `;
    const runtimeAssertions = evaluateRuntimeAssertions({
      events: [
        completedRuntimeItem({
          type: "dynamicToolCall",
          tool: "js_exec",
          arguments: { code },
          result: { content: [{ type: "text", text: "done" }] },
        }),
      ],
    });

    expect(runtimeAssertions.failures).toEqual([]);
    expect(runtimeAssertions.commands).toEqual(
      expect.arrayContaining([
        "create-worker space-matching-game",
        "bun run deploy",
      ]),
    );
  });

  it("detects unsupported scaffold commands inside js_exec", () => {
    const runtimeAssertions = evaluateRuntimeAssertions({
      events: [
        completedRuntimeItem({
          type: "dynamicToolCall",
          tool: "js_exec",
          arguments: {
            code: `
              await tools.read({ location: "workspace", path: "developing-software/SKILL.md" });
              await vm.exec({ project: "space", command: "npm create cloudflare@latest space" });
              await vm.exec({ project: "space", command: "bun run deploy" });
              await tools.list_apps({});
              await tools.set_preview({ app_name: "space" });
            `,
          },
          result: { content: [{ type: "text", text: "done" }] },
        }),
      ],
    });

    expect(runtimeAssertions.failures).toContain(
      "agent did not run the create-worker scaffold command",
    );
    expect(runtimeAssertions.failures).toContain(
      "agent used unsupported scaffold command(s): npm create cloudflare@latest space",
    );
  });

  it("keeps post-deploy tool failures in pass/fail criteria", () => {
    const criteria = buildPostDeployToolCriteria({
      failures: [
        "agent did not call list_apps after deploy",
        "agent did not call set_preview for the deployed app",
      ],
    });

    expect(criteria).toMatchObject([
      {
        id: "called_list_apps",
        status: "failed",
        reason: "agent did not call list_apps after deploy",
      },
      {
        id: "called_set_preview",
        status: "failed",
        reason: "agent did not call set_preview for the deployed app",
      },
    ]);
  });
});

describe("space matching game deploy agent eval", () => {
  maybeIt(
    "asks the agent to create and deploy a persistent space matching game",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const { userId } = await createUser(
        testEnv,
        `space-game-eval-${suffix}@example.com`,
        "password123",
        "Space Game Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Space Game Eval ${suffix}`,
        userId,
      );

      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      await configureEvalModel(testEnv, orgStub, userId);
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Space matching game eval",
        userId,
        undefined,
        testEnv.EVAL_MODEL,
      );

      const workspaceFs = testEnv.WORKSPACE_FS.get(
        testEnv.WORKSPACE_FS.idFromName(defaultWorkspaceId),
      );
      const initialProjects = await workspaceFs.listProjectsForMigrationReset();
      if (initialProjects.length > 0) {
        const projectCreation = buildProjectCreationInspection(
          initialProjects,
          initialProjects,
        );
        const evaluation = buildEvalCriteriaSummary({
          passFail: [
            passFailCriterion({
              id: "agent_session_completed",
              label: "Agent session completed",
              passed: false,
              reason: "Agent session did not run because the workspace was not empty.",
            }),
            passFailCriterion({
              id: "agent_created_project",
              label: "Agent created a project",
              passed: false,
              reason: projectCreation.failures.join("; "),
              details: projectCreation,
            }),
          ],
          scorecard: [
            scoreCriterion({
              id: "previewed_latest_app",
              label: "Previewed the latest deployed app",
              points: 0,
              maxPoints: 5,
              reason: "Agent session did not run.",
            }),
            scoreCriterion({
              id: "agent_efficiency",
              label: "Agent efficiency / signal",
              points: 0,
              maxPoints: 4,
              reason: "Agent session did not run.",
            }),
          ],
        });
        const payload = {
          status: "harness_error",
          evaluation,
          model: testEnv.EVAL_MODEL,
          projectCreation,
          sourceInspection: missingProjectSourceInspection(),
        };
        emitEvalTranscript(payload);
        assertPassFailCriteria(evaluation);
        return;
      }

      const chatThread = testEnv.CHAT_THREAD.get(
        testEnv.CHAT_THREAD.idFromName(thread.id),
      );
      const appsBefore = await countWorkspaceApps(orgStub, defaultWorkspaceId);
      const result = await chatThread.runAgentEvalSession({
        threadId: thread.id,
        workspaceId: defaultWorkspaceId,
        orgId: org.id,
        userId,
        userName: "Space Game Eval",
        userEmail: `space-game-eval-${suffix}@example.com`,
        messageSource: "eval",
        timeoutMs: getEvalTimeoutMs(testEnv, 900_000),
        message: [
          "Create a web app that is a space themed matching game with a leaderboard where users can enter their credentials for their high score.",
          "This eval runtime injects CLOUDFLARE_API_BASE_URL and CLOUDFLARE_API_TOKEN, so do not ask for login or real Cloudflare credentials.",
        ].join(" "),
      });
      const finalProjects = await workspaceFs.listProjectsForMigrationReset();
      const newProjects = diffNewProjects(initialProjects, finalProjects);
      const {
        selectedProject,
        sourceInspection,
        sourceInspectionCandidates,
      } = await inspectCreatedProjectSources(
        testEnv.PROJECT_RUNTIME_HOST,
        newProjects,
      );
      const projectCreation = buildProjectCreationInspection(
        initialProjects,
        finalProjects,
        selectedProject,
      );
      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          maxAssistantTurns: 20,
          maxBadToolCalls: 3,
        }),
      );
      const runtimeAssertions = evaluateRuntimeAssertions(result);
      const commandText = runtimeAssertions.commands.join("\n").toLowerCase();
      const unsupportedScaffoldFailures = runtimeAssertions.failures.filter((failure) =>
        failure.includes("unsupported scaffold"),
      );
      const shadcnFailures = sourceInspection.failures.filter((failure) =>
        /components\.json|shadcn/i.test(failure),
      );
      const usedCreateWorker = /\bcreate-worker\b/.test(commandText);
      const usedBunRunDeploy = /\bbun\s+run\s+deploy\b/.test(commandText);
      const appsAfter = await countWorkspaceApps(orgStub, defaultWorkspaceId);
      let deployedApp: EvalDeployedApp | undefined;
      let deployedAppError: string | undefined;
      try {
        deployedApp = assertDeployedApp(result, { hostSuffix: ".evals.camelai.app" });
      } catch (error) {
        deployedAppError = error instanceof Error ? error.message : String(error);
      }
      const rootSmoke = await smokeFetchRoot(deployedApp);
      const evaluation = buildEvalCriteriaSummary({
        passFail: [
          buildSessionCompletedCriterion(result),
          passFailCriterion({
            id: "agent_created_project",
            label: "Agent created a project",
            passed: projectCreation.failures.length === 0,
            reason: projectCreation.failures.length
              ? projectCreation.failures.join("; ")
              : undefined,
            details: projectCreation,
          }),
          passFailCriterion({
            id: "read_deploy_skill",
            label: "Agent read the deploy software skill",
            passed: readDevelopingSoftwareSkill(result.events),
            reason: readDevelopingSoftwareSkill(result.events)
              ? undefined
              : "No qualifying developing-software/SKILL.md read evidence was found.",
          }),
          passFailCriterion({
            id: "scaffolded_with_create_worker_and_shadcn",
            label: "Agent scaffolded with create-worker and shadcn",
            passed:
              usedCreateWorker &&
              unsupportedScaffoldFailures.length === 0 &&
              shadcnFailures.length === 0,
            reason:
              usedCreateWorker &&
              unsupportedScaffoldFailures.length === 0 &&
              shadcnFailures.length === 0
                ? undefined
                : [
                    ...(usedCreateWorker ? [] : ["No create-worker scaffold command evidence was found."]),
                    ...unsupportedScaffoldFailures,
                    ...shadcnFailures,
                  ].join(" "),
            details: {
              commands: runtimeAssertions.commands,
              unsupportedScaffoldFailures,
              shadcnFailures,
            },
          }),
          passFailCriterion({
            id: "deployed_with_bun_run_deploy",
            label: "Agent deployed with bun run deploy",
            passed: usedBunRunDeploy,
            reason: usedBunRunDeploy
              ? undefined
              : "No bun run deploy command evidence was found.",
            details: { commands: runtimeAssertions.commands },
          }),
          ...buildPostDeployToolCriteria(runtimeAssertions),
          passFailCriterion({
            id: "source_satisfies_app_requirements",
            label: "Generated source satisfies required app requirements",
            passed: sourceInspection.failures.length === 0,
            reason: sourceInspection.failures.length
              ? sourceInspection.failures.join("; ")
              : undefined,
            details: sourceInspection,
          }),
          passFailCriterion({
            id: "workspace_app_created",
            label: "Workspace app was created",
            passed: appsAfter === appsBefore + 1,
            reason:
              appsAfter === appsBefore + 1
                ? undefined
                : `Expected app count to increase by one; before=${appsBefore}, after=${appsAfter}.`,
            details: { appsBefore, appsAfter },
          }),
          passFailCriterion({
            id: "eval_app_url_deployed",
            label: "A real eval app URL was deployed",
            passed: Boolean(deployedApp),
            reason: deployedApp ? undefined : deployedAppError,
            details: { deployedApp },
          }),
          passFailCriterion({
            id: "deployed_app_live",
            label: "Deployed app is live",
            passed: rootSmoke.status === 200 && (rootSmoke.bodyLength ?? 0) > 0,
            reason:
              rootSmoke.status === 200 && (rootSmoke.bodyLength ?? 0) > 0
                ? undefined
                : rootSmoke.error ??
                  `Root fetch returned HTTP ${rootSmoke.status ?? "unknown"} with body length ${rootSmoke.bodyLength ?? 0}.`,
            details: rootSmoke,
          }),
          passFailCriterion({
            id: "important_pages_load_without_server_error",
            label: "Important app pages load without obvious server error",
            passed:
              rootSmoke.status === 200 &&
              (rootSmoke.bodyLength ?? 0) > 0 &&
              rootSmoke.errorStrings.length === 0,
            reason:
              rootSmoke.status === 200 &&
              (rootSmoke.bodyLength ?? 0) > 0 &&
              rootSmoke.errorStrings.length === 0
                ? undefined
                : rootSmoke.errorStrings.length
                  ? `Root body contained error marker(s): ${rootSmoke.errorStrings.join(", ")}`
                  : rootSmoke.error ??
                    `Root fetch returned HTTP ${rootSmoke.status ?? "unknown"} with body length ${rootSmoke.bodyLength ?? 0}.`,
            details: rootSmoke,
          }),
        ],
        scorecard: [
          scoreLatestPreview(result.events),
          scoreSignalEfficiency(signal, {
            maxPoints: 4,
            fallbackPoints: 1,
            tiers: [
              { maxAssistantTurns: 20, maxBadToolCalls: 3, points: 4 },
              { maxAssistantTurns: 30, maxBadToolCalls: 6, points: 3 },
              { maxAssistantTurns: 40, maxBadToolCalls: 12, points: 2 },
              { maxAssistantTurns: 50, maxBadToolCalls: 24, points: 1 },
            ],
          }),
        ],
      });

      const payload = {
        status: result.status,
        evaluation,
        error: result.error,
        model: testEnv.EVAL_MODEL,
        signal,
        deployedApps: result.deployedApps,
        projectCreation,
        runtimeAssertions,
        sourceInspection,
        sourceInspectionCandidates,
        livePageSmoke: rootSmoke,
        result: result.result,
        events: result.events,
        messages: result.messages,
      };
      emitEvalTranscript(payload);
      assertPassFailCriteria(evaluation);
    },
    960_000,
  );
});
