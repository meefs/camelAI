import { env } from "cloudflare:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createOrg, createUser, type TestEnv } from "../test-helpers";
import {
  assertEvalSignal,
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
  assertDeployedAppLive,
  countWorkspaceApps,
} from "./eval-deploy-assert";
import { emitEvalTranscript } from "./eval-transcript";
import type { ChatThreadDO } from "../../src/chat-thread-do";
import type { WorkspaceFilesystemDO } from "../../src/workspace-filesystem-do";

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

const EVAL_ID = "space-matching-game-live";
const PROJECT_NAME = "space-matching-game";
const testEnv = env as unknown as SpaceMatchingGameEvalEnv;
// This eval needs the real testing-grounds deploy path because it asserts a live app.
const maybeIt = isRealEvalDeployEnabled(testEnv) ? it : it.skip;

function persistEvalArtifact(name: string, value: unknown): void {
  try {
    const dir = path.resolve(
      process.env.EVAL_ARTIFACT_DIR ??
        path.join(os.tmpdir(), "camelai-eval-artifacts"),
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${name}.json`),
      JSON.stringify(value, null, 2),
    );
  } catch (error) {
    console.warn(
      `Unable to persist eval artifact ${name}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

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

function executedCommands(events: Array<Record<string, unknown>>): string[] {
  return collectRuntimeItems(events)
    .filter((item) => item.type === "commandExecution")
    .map((item) => asString(item.command) ?? "")
    .filter(Boolean);
}

function usedTool(events: Array<Record<string, unknown>>, toolName: string): boolean {
  const expected = toolName.toLowerCase();
  return collectRuntimeItems(events).some((item) => {
    const tool = asString(item.tool)?.toLowerCase();
    return tool === expected || tool?.endsWith(`__${expected}`);
  });
}

function readDevelopingSoftwareSkill(
  events: Array<Record<string, unknown>>,
): boolean {
  return collectRuntimeItems(events).some((item) => {
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
  });
}

function evaluateRuntimeAssertions(
  result: { events: Array<Record<string, unknown>> },
): {
  commands: string[];
  failures: string[];
} {
  const commands = executedCommands(result.events);
  const lowerCommands = commands.map((command) => command.toLowerCase());
  const failures: string[] = [];

  if (!readDevelopingSoftwareSkill(result.events)) {
    failures.push("agent did not read developing-software/SKILL.md");
  }
  if (!lowerCommands.some((command) => /\bcreate-worker\b/.test(command))) {
    failures.push("agent did not run the create-worker scaffold command");
  }
  if (!lowerCommands.some((command) => /\bbun\s+run\s+deploy\b/.test(command))) {
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
  if (wrongScaffoldCommands.length > 0) {
    failures.push(
      `agent used unsupported scaffold command(s): ${wrongScaffoldCommands.join(" | ")}`,
    );
  }

  return { commands, failures };
}

async function findGeneratedAppDir(
  runtime: Fetcher,
  projectId: string,
): Promise<string | undefined> {
  const topLevel = await listRuntimeFiles(runtime, projectId, "/workspace");
  const candidates = [
    "/workspace",
    ...topLevel
      .filter((entry) => entry.type === "directory")
      .map((entry) => entry.absolutePath ?? joinVmPath("/workspace", entry.name ?? ""))
      .filter(Boolean),
  ];

  const scored: Array<{ dir: string; score: number }> = [];
  for (const dir of candidates) {
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
    let score = 1;
    const packageName = asString(parseJsonObject(packageJson).name) ?? "";
    if (packageName === PROJECT_NAME) score += 5;
    if (dir.endsWith(`/${PROJECT_NAME}`)) score += 4;
    if (hasComponentsJson) score += 3;
    if (hasWrangler) score += 3;
    scored.push({ dir, score });
  }

  return scored.sort((a, b) => b.score - a.score)[0]?.dir;
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
      const project = await workspaceFs.createProject({
        id: PROJECT_NAME,
        name: PROJECT_NAME,
        description: "Space themed matching game deploy eval project.",
        workspaceId: defaultWorkspaceId,
      });

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
          `In the ${PROJECT_NAME} project, create a web app that is a space themed matching game with a leaderboard where users can enter their credentials for their high score.`,
          "This eval runtime injects CLOUDFLARE_API_BASE_URL and CLOUDFLARE_API_TOKEN, so do not ask for login or real Cloudflare credentials.",
        ].join(" "),
      });
      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          maxAssistantTurns: 18,
          maxBadToolCalls: 0,
        }),
      );
      const runtimeAssertions = evaluateRuntimeAssertions(result);
      const sourceInspection = await inspectSource(
        testEnv.PROJECT_RUNTIME_HOST,
        project.id,
      );

      const payload = {
        status: result.status,
        error: result.error,
        model: testEnv.EVAL_MODEL,
        signal,
        deployedApps: result.deployedApps,
        runtimeAssertions,
        sourceInspection,
        result: result.result,
        events: result.events,
        messages: result.messages,
      };
      persistEvalArtifact(EVAL_ID, payload);
      emitEvalTranscript(payload);

      const transcriptText = lowerText({
        result: result.result,
        events: result.events,
        messages: result.messages,
      });

      expect(result.status).toBe("completed");
      assertEvalSignal(signal, testEnv);
      expect(transcriptText).not.toContain("assistant error");
      expect(result.events.some((event) => event.type === "runtime_event")).toBe(true);
      expect(result.events.some((event) => event.type === "result")).toBe(true);
      expect(runtimeAssertions.failures).toEqual([]);
      expect(sourceInspection.failures).toEqual([]);
      expect(await countWorkspaceApps(orgStub, defaultWorkspaceId)).toBe(
        appsBefore + 1,
      );

      const deployedApp = assertDeployedApp(result, { hostSuffix: ".evals.camelai.app" });
      await assertDeployedAppLive(deployedApp);
    },
    960_000,
  );
});
