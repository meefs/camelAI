import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createOrg, createUser, type TestEnv } from "../test-helpers";
import {
  assertPassFailCriteria,
  buildEvalCriteriaSummary,
  buildNoAssistantErrorCriterion,
  buildResultEventCriterion,
  buildRuntimeEventsCriterion,
  buildSessionCompletedCriterion,
  passFailCriterion,
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
import type { WorkspaceFilesystemDO } from "../../src/workspace-filesystem-do";

type DeployEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  APP_DB?: D1Database;
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  WORKSPACE_FS: DurableObjectNamespace<WorkspaceFilesystemDO>;
  PROJECT_RUNTIME_HOST: Fetcher;
  RUN_AGENT_EVALS?: string;
  EVAL_REAL_DEPLOY?: string;
  CF_API_TOKEN?: string;
};

const testEnv = env as unknown as DeployEvalEnv;
// Real deploy is required for this eval (it publishes to the testing-grounds namespace and
// fetches the live URL). Skips when not an agent eval run, real deploy is disabled, or no
// CF_API_TOKEN is available.
const maybeIt = isRealEvalDeployEnabled(testEnv) ? it : it.skip;

type RuntimeFileEntry = {
  name?: string;
  type?: string;
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

type DeploySourceInspection = {
  appDir?: string;
  checkedFiles: string[];
  sourceFiles: Array<{ path: string; size: number }>;
  packageName?: string;
  deployScript?: string;
  cloudflareFailures: string[];
  contentFailures: string[];
  contentSignals: string[];
  error?: string;
};

type PageSmoke = {
  url?: string;
  status?: number;
  bodyLength?: number;
  errorStrings: string[];
  error?: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function lowerJson(value: unknown): string {
  try {
    return JSON.stringify(value).toLowerCase();
  } catch {
    return String(value).toLowerCase();
  }
}

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  while ((match = pattern.exec(code)) !== null) literals.push(match[2]);
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
  const topLevelTools = items
    .map(runtimeToolName)
    .filter((tool): tool is string => Boolean(tool));
  return {
    commands: uniqueStrings([
      ...topLevelCommands,
      ...jsExecCodeBlocks.flatMap(extractCommandEvidenceFromJsExec),
    ]),
    jsExecCodeBlocks,
    jsExecResultTexts,
    tools: uniqueStrings(topLevelTools),
  };
}

function commandEvidenceText(evidence: RuntimeEvidence): string {
  return [
    ...evidence.commands,
    ...evidence.jsExecCodeBlocks.map(stripComments),
  ].join("\n").toLowerCase();
}

function buildPostDeployToolCriteria(runtimeAssertions: {
  calledListApps: boolean;
  calledSetPreview: boolean;
}) {
  return [
    passFailCriterion({
      id: "called_list_apps",
      label: "Agent called list_apps",
      passed: runtimeAssertions.calledListApps,
      reason: runtimeAssertions.calledListApps
        ? undefined
        : "No list_apps tool call evidence was found.",
    }),
    passFailCriterion({
      id: "called_set_preview",
      label: "Agent called set_preview",
      passed: runtimeAssertions.calledSetPreview,
      reason: runtimeAssertions.calledSetPreview
        ? undefined
        : "No set_preview tool call evidence was found.",
    }),
  ];
}

function usedTool(events: Array<Record<string, unknown>>, toolName: string): boolean {
  const expected = toolName.toLowerCase();
  const evidence = collectRuntimeEvidence(events);
  return (
    evidence.tools.some((tool) => tool === expected || tool.endsWith(`__${expected}`)) ||
    evidence.jsExecCodeBlocks.some((code) => jsExecCodeMentionsTool(code, expected))
  );
}

function readDevelopingSoftwareSkill(events: Array<Record<string, unknown>>): boolean {
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
    const itemText = lowerJson(item);
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

function joinVmPath(base: string, child: string): string {
  return `${base.replace(/\/+$/, "")}/${child.replace(/^\/+/, "")}`;
}

function runtimeUrl(
  projectId: string,
  subpath: string,
  params: Record<string, string>,
): string {
  const url = new URL(
    `http://runtime.test/v1/projects/${encodeURIComponent(projectId)}${subpath}`,
  );
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
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
  for (const entry of topLevel) {
    if (entry.type !== "directory") continue;
    const child = runtimeEntryPath("/workspace", entry);
    if (child && shouldSearchDirectory(child)) candidates.add(child);
  }

  const scored: Array<{ dir: string; score: number }> = [];
  for (const dir of candidates) {
    const packageText = await readRuntimeText(
      runtime,
      projectId,
      joinVmPath(dir, "package.json"),
    );
    if (!packageText) continue;
    const packageJson = parseJsonObject(packageText);
    const scripts = asRecord(packageJson.scripts) ?? {};
    const dependencies = asRecord(packageJson.dependencies) ?? {};
    const devDependencies = asRecord(packageJson.devDependencies) ?? {};
    const deployScript = asString(scripts.deploy) ?? "";
    let score = 1;
    if ((asString(packageJson.name) ?? "").includes("fake-data")) score += 4;
    if (dir.includes("fake-data")) score += 4;
    if (deployScript.includes("wrangler deploy")) score += 4;
    if (dependencies.react || dependencies["react-router"]) score += 2;
    if (devDependencies.wrangler || devDependencies["@cloudflare/vite-plugin"]) score += 3;
    if (await readRuntimeText(runtime, projectId, joinVmPath(dir, "wrangler.jsonc"))) score += 4;
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
  const sourceExtension = /\.(?:tsx?|jsx?|css|json|jsonc|html)$/i;
  const excluded =
    /(?:^|\/)(node_modules|\.wrangler|\.react-router|dist|build|coverage)(?:\/|$)|bun\.lock$/;

  async function addFile(filePath: string): Promise<void> {
    if (sourceFiles.has(filePath) || excluded.test(filePath) || !sourceExtension.test(filePath)) {
      return;
    }
    const text = await readRuntimeText(runtime, projectId, filePath);
    if (text === undefined) return;
    sourceFiles.set(filePath, { path: filePath, text, size: text.length });
  }

  for (const file of [
    "package.json",
    "wrangler.jsonc",
    "react-router.config.ts",
    "components.json",
  ]) {
    await addFile(joinVmPath(appDir, file));
  }
  for (const root of ["app", "workers", "src"]) {
    const rootPath = joinVmPath(appDir, root);
    for (const entry of await listRuntimeFiles(runtime, projectId, rootPath, true)) {
      if (entry.type !== "file") continue;
      await addFile(
        entry.absolutePath ??
          joinVmPath(rootPath, entry.relativePath ?? entry.name ?? ""),
      );
    }
  }
  return [...sourceFiles.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function inspectCollectedSource(
  appDir: string,
  sourceFiles: SourceFile[],
): DeploySourceInspection {
  const textByRelativePath = new Map(
    sourceFiles.map((file) => [file.path.slice(appDir.length + 1), file.text]),
  );
  const packageJson = parseJsonObject(textByRelativePath.get("package.json"));
  const scripts = asRecord(packageJson.scripts) ?? {};
  const dependencies = asRecord(packageJson.dependencies) ?? {};
  const devDependencies = asRecord(packageJson.devDependencies) ?? {};
  const wrangler = stripComments(textByRelativePath.get("wrangler.jsonc") ?? "");
  const sourceText = sourceFiles.map((file) => stripComments(file.text)).join("\n");
  const lowerSource = sourceText.toLowerCase();
  const deployScript = asString(scripts.deploy);
  const cloudflareFailures: string[] = [];
  const contentFailures: string[] = [];

  if (!textByRelativePath.has("package.json")) cloudflareFailures.push("package.json is missing");
  if (!deployScript?.includes("wrangler deploy")) {
    cloudflareFailures.push("package.json deploy script does not run wrangler deploy");
  }
  if (!textByRelativePath.has("wrangler.jsonc")) cloudflareFailures.push("wrangler.jsonc is missing");
  if (
    !wrangler.includes('"main"') &&
    !sourceFiles.some((file) => /(?:workers\/app|src\/index)\.tsx?$/.test(file.path))
  ) {
    cloudflareFailures.push("no Worker entrypoint marker was found");
  }
  if (
    !devDependencies.wrangler &&
    !devDependencies["@cloudflare/vite-plugin"] &&
    !dependencies["@cloudflare/workers-types"]
  ) {
    cloudflareFailures.push("expected Cloudflare/Wrangler dependency markers are missing");
  }

  const contentSignals = [
    "dashboard",
    "operations",
    "metric",
    "table",
    "chart",
    "revenue",
    "sales",
    "customer",
    "orders",
    "inventory",
    "sample",
    "fake",
    "mock",
  ].filter((term) => lowerSource.includes(term));
  if (!contentSignals.some((term) => ["fake", "sample", "mock"].includes(term))) {
    contentFailures.push("source does not show fake/sample business data");
  }
  if (!contentSignals.includes("dashboard") && !contentSignals.includes("operations")) {
    contentFailures.push("source does not show dashboard or operations UI content");
  }
  if (
    !contentSignals.includes("metric") ||
    !contentSignals.includes("table") ||
    !contentSignals.includes("chart")
  ) {
    contentFailures.push("source does not show metrics, table, and chart-like content");
  }

  return {
    appDir,
    checkedFiles: [...textByRelativePath.keys()],
    sourceFiles: sourceFiles.map((file) => ({
      path: file.path.slice(appDir.length + 1),
      size: file.size,
    })),
    packageName: asString(packageJson.name),
    deployScript,
    cloudflareFailures,
    contentFailures,
    contentSignals,
  };
}

async function inspectDeploySource(
  runtime: Fetcher,
  projectId: string,
): Promise<DeploySourceInspection> {
  try {
    const appDir = await findGeneratedAppDir(runtime, projectId);
    if (!appDir) {
      return {
        checkedFiles: [],
        sourceFiles: [],
        cloudflareFailures: ["could not find a generated app directory with package.json"],
        contentFailures: ["could not inspect generated app content"],
        contentSignals: [],
      };
    }
    return inspectCollectedSource(
      appDir,
      await collectSourceFiles(runtime, projectId, appDir),
    );
  } catch (error) {
    return {
      checkedFiles: [],
      sourceFiles: [],
      cloudflareFailures: ["source inspection failed"],
      contentFailures: ["source inspection failed"],
      contentSignals: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
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

describe("deploy fake data runtime evidence extraction", () => {
  it("does not treat bare tool-name mentions as tool calls", () => {
    expect(jsExecCodeMentionsTool('const next = "list_apps";', "list_apps")).toBe(false);
    expect(jsExecCodeMentionsTool("list_apps;", "list_apps")).toBe(false);
  });

  it("accepts explicit tool call expressions", () => {
    expect(jsExecCodeMentionsTool("await tools.list_apps({});", "list_apps")).toBe(true);
    expect(jsExecCodeMentionsTool("await tools['set_preview']({});", "set_preview")).toBe(true);
    expect(jsExecCodeMentionsTool('await callTool("list_apps", {});', "list_apps")).toBe(true);
  });

  it("does not treat js_exec output as executed command evidence", () => {
    const evidence = collectRuntimeEvidence([
      {
        type: "runtime_event",
        event: {
          method: "item/completed",
          params: {
            item: {
              tool: "js_exec",
              arguments: {
                code: 'await tools.read({ path: "sandbox/skills/developing-software/SKILL.md" });',
              },
              result: {
                text: [
                  "Use `create-worker` for deploy scaffolds.",
                  "Do not run wrangler init or npm create cloudflare.",
                  "Then use bun run deploy.",
                ].join("\n"),
              },
            },
          },
        },
      },
    ]);

    const text = commandEvidenceText(evidence);

    expect(evidence.jsExecResultTexts.join("\n")).toContain("wrangler init");
    expect(text).not.toContain("wrangler init");
    expect(text).not.toContain("npm create cloudflare");
    expect(text).not.toContain("create-worker");
    expect(text).not.toContain("bun run deploy");
  });

  it("keeps post-deploy tool calls in pass/fail criteria", () => {
    const criteria = buildPostDeployToolCriteria({
      calledListApps: true,
      calledSetPreview: false,
    });

    expect(criteria).toMatchObject([
      { id: "called_list_apps", status: "passed" },
      {
        id: "called_set_preview",
        status: "failed",
        reason: "No set_preview tool call evidence was found.",
      },
    ]);
  });
});

describe("deploy fake data agent eval", () => {
  maybeIt(
    "asks the agent to scaffold from the bundled template and deploy with wrangler",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const { userId } = await createUser(
        testEnv,
        `deploy-eval-${suffix}@example.com`,
        "password123",
        "Deploy Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Deploy Eval ${suffix}`,
        userId,
      );

      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      await configureEvalModel(testEnv, orgStub, userId);
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Deploy fake data eval",
        userId,
        undefined,
        testEnv.EVAL_MODEL,
      );

      const workspaceFs = testEnv.WORKSPACE_FS.get(
        testEnv.WORKSPACE_FS.idFromName(defaultWorkspaceId),
      );
      const project = await workspaceFs.createProject({
        id: "deploy-fake-data",
        name: "deploy-fake-data",
        description: "Deploy eval project.",
        workspaceId: defaultWorkspaceId,
      });

      const chatThread = testEnv.CHAT_THREAD.get(
        testEnv.CHAT_THREAD.idFromName(thread.id),
      );
      // Snapshot the workspace's app count so we can assert the eval actually deployed one.
      const appsBefore = await countWorkspaceApps(orgStub, defaultWorkspaceId);
      const result = await chatThread.runAgentEvalSession({
        threadId: thread.id,
        workspaceId: defaultWorkspaceId,
        orgId: org.id,
        userId,
        userName: "Deploy Eval",
        userEmail: `deploy-eval-${suffix}@example.com`,
        messageSource: "eval",
        timeoutMs: getEvalTimeoutMs(testEnv, 600_000),
        message: [
          "In the deploy-fake-data project, use the bundled create-worker command to scaffold a Cloudflare Worker app named fake-data-dashboard.",
          "Customize the generated app into a polished fake-data dashboard or operations app using believable sample business data.",
          "Then run the generated app's exact deploy script with bun run deploy so it exercises wrangler deploy from the template.",
          "This eval runtime injects CLOUDFLARE_API_BASE_URL and CLOUDFLARE_API_TOKEN, so do not ask for login or real Cloudflare credentials.",
          "After deploying, call list_apps and verify fake-data-dashboard appears, then call set_preview for fake-data-dashboard.",
          "Summarize the deploy result and list_apps/set_preview result.",
        ].join(" "),
      });
      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          maxAssistantTurns: 14,
          maxBadToolCalls: 0,
        }),
      );
      const agentOutputText = JSON.stringify({
        result: result.result,
        events: result.events,
        messages: result.messages.filter((message) => message.role !== "user"),
      }).toLowerCase();
      const sourceInspection = await inspectDeploySource(
        testEnv.PROJECT_RUNTIME_HOST,
        project.id,
      );
      const appsAfter = await countWorkspaceApps(orgStub, defaultWorkspaceId);
      let deployedApp: EvalDeployedApp | undefined;
      let deployedAppError: string | undefined;
      try {
        deployedApp = assertDeployedApp(result, { hostSuffix: ".evals.camelai.app" });
      } catch (error) {
        deployedAppError = error instanceof Error ? error.message : String(error);
      }
      const rootSmoke = await smokeFetchRoot(deployedApp);
      const runtimeEvidence = collectRuntimeEvidence(result.events);
      const runtimeEvidenceText = commandEvidenceText(runtimeEvidence);
      const unsupportedScaffoldCommands = [
        "wrangler init",
        "npm create cloudflare",
        "pnpm create cloudflare",
        "yarn create cloudflare",
      ].filter((command) => runtimeEvidenceText.includes(command));
      const runtimeAssertions = {
        usedExistingProject:
          Boolean(sourceInspection.appDir) ||
          runtimeEvidenceText.includes("deploy-fake-data"),
        readDevelopingSoftwareSkill: readDevelopingSoftwareSkill(result.events),
        usedCreateWorker: /\bcreate-worker\b/.test(runtimeEvidenceText),
        unsupportedScaffoldCommands,
        deployedWithBunRunDeploy: /\bbun\s+run\s+deploy\b/.test(runtimeEvidenceText),
        calledListApps: usedTool(result.events, "list_apps"),
        calledSetPreview: usedTool(result.events, "set_preview"),
        evidence: runtimeEvidence,
      };
      const evaluation = buildEvalCriteriaSummary({
        passFail: [
          buildSessionCompletedCriterion(result),
          passFailCriterion({
            id: "used_existing_project",
            label: "Agent used the existing project",
            passed: runtimeAssertions.usedExistingProject,
            reason: runtimeAssertions.usedExistingProject
              ? undefined
              : "Runtime/source evidence did not show work in the deploy-fake-data project.",
          }),
          passFailCriterion({
            id: "read_deploy_skill",
            label: "Agent read the deploy software skill",
            passed: runtimeAssertions.readDevelopingSoftwareSkill,
            reason: runtimeAssertions.readDevelopingSoftwareSkill
              ? undefined
              : "No qualifying developing-software/SKILL.md read evidence was found.",
          }),
          passFailCriterion({
            id: "scaffolded_with_create_worker",
            label: "Agent scaffolded with create-worker",
            passed:
              runtimeAssertions.usedCreateWorker &&
              runtimeAssertions.unsupportedScaffoldCommands.length === 0,
            reason:
              runtimeAssertions.usedCreateWorker &&
              runtimeAssertions.unsupportedScaffoldCommands.length === 0
                ? undefined
                : runtimeAssertions.unsupportedScaffoldCommands.length
                  ? `Unsupported scaffold command(s): ${runtimeAssertions.unsupportedScaffoldCommands.join(", ")}`
                  : "No create-worker scaffold command evidence was found.",
            details: runtimeAssertions,
          }),
          passFailCriterion({
            id: "cloudflare_worker_source",
            label: "Generated source looks like a Cloudflare Worker app",
            passed: sourceInspection.cloudflareFailures.length === 0,
            reason: sourceInspection.cloudflareFailures.length
              ? sourceInspection.cloudflareFailures.join("; ")
              : undefined,
            details: sourceInspection,
          }),
          passFailCriterion({
            id: "fake_business_dashboard_content",
            label: "Generated app contains fake business dashboard content",
            passed: sourceInspection.contentFailures.length === 0,
            reason: sourceInspection.contentFailures.length
              ? sourceInspection.contentFailures.join("; ")
              : undefined,
            details: sourceInspection,
          }),
          passFailCriterion({
            id: "deployed_with_bun_run_deploy",
            label: "Agent deployed with bun run deploy",
            passed: runtimeAssertions.deployedWithBunRunDeploy,
            reason: runtimeAssertions.deployedWithBunRunDeploy
              ? undefined
              : "No bun run deploy command evidence was found.",
          }),
          ...buildPostDeployToolCriteria(runtimeAssertions),
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
            id: "deployed_root_no_server_error",
            label: "Deployed root page does not show an obvious server error",
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
          buildNoAssistantErrorCriterion(agentOutputText),
          buildRuntimeEventsCriterion(result),
          buildResultEventCriterion(result),
        ],
        scorecard: [
          scoreLatestPreview(result.events),
          scoreSignalEfficiency(signal, {
            maxPoints: 4,
            fallbackPoints: 1,
            tiers: [
              { maxAssistantTurns: 14, maxBadToolCalls: 1, points: 4 },
              { maxAssistantTurns: 20, maxBadToolCalls: 3, points: 3 },
              { maxAssistantTurns: 30, maxBadToolCalls: 6, points: 2 },
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
        runtimeAssertions,
        sourceInspection,
        livePageSmoke: rootSmoke,
        result: result.result,
        events: result.events,
        messages: result.messages,
      };
      emitEvalTranscript(payload);
      assertPassFailCriteria(evaluation);
    },
    660_000,
  );
});
