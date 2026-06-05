import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  applyMigrationAgentPlan,
  appendUnclassifiedMiscProject,
  buildLegacyWorkspaceMigrationDiagnostics,
  buildLegacyWorkspaceMigrationSeedPlan,
  detectWorkerAppSourcePaths,
  buildMigrationPlanningPrompt,
  buildMigrationPlanningResponsesRequest,
  buildMigrationPlanningTextFormat,
  buildLegacyWorkspaceNamingContext,
  parseMigrationPlanningAiResult,
  readMigrationPlanningResponsesPayload,
  type MigrationDeployedAppContext,
  type LegacyWorkspaceMigrationRuntimeReader,
  type RuntimeFileEntry,
} from "../src/legacy-workspace-migration-workflow";
import { CURRENT_LEGACY_WORKSPACE_MIGRATION_VERSION } from "../../../src/lib/legacy-workspace-migration-version";
import { WorkspaceFilesystemClient } from "../src/workspace-filesystem-do";

describe("legacy workspace migration workflow", () => {
  it("builds an agent discovery seed plan from top-level legacy paths", () => {
    const plan = buildLegacyWorkspaceMigrationSeedPlan({
      entries: [
        { name: "web-app", type: "directory", absolutePath: "/home/claude/web-app" },
        { name: "README.md", type: "file", absolutePath: "/home/claude/README.md" },
        { name: ".cache", type: "directory", absolutePath: "/home/claude/.cache" },
      ],
    });

    expect(plan.projects).toEqual([
      {
        name: "web-app",
        description: "Legacy workspace path web-app.",
        sourcePaths: ["/home/claude/web-app"],
        ignoreGlobs: [],
        reason: "Allowed source path for agent-led migration discovery.",
      },
      {
        name: "legacy-workspace-loose-files",
        description: "Loose top-level legacy workspace files for semantic grouping during migration.",
        sourcePaths: ["/home/claude/README.md"],
        ignoreGlobs: [],
        reason: "Grouped loose top-level files so the migration planning agent clusters related files instead of treating each file as its own project.",
      },
    ]);
    expect(plan.workspaceFiles).toEqual([]);
    expect(plan.unclassified).toEqual(["/home/claude/.cache"]);
  });

  it("preserves hidden planning-only paths in a deterministic misc project", () => {
    const plan = appendUnclassifiedMiscProject({
      projects: [
        {
          name: "web-app",
          description: "Migrated app",
          sourcePaths: ["/home/claude/web-app"],
        },
      ],
      workspaceFiles: [],
      unclassified: ["/home/claude/.cache", "/home/claude/.claude"],
    });

    expect(plan.projects).toEqual([
      {
        name: "web-app",
        description: "Migrated app",
        sourcePaths: ["/home/claude/web-app"],
      },
      {
        name: "legacy-workspace-misc",
        description: "Miscellaneous hidden, cache, tooling, and loose legacy workspace paths preserved during migration.",
        sourcePaths: ["/home/claude/.cache", "/home/claude/.claude"],
        ignoreGlobs: [],
        reason: "Preserved automatically outside the AI naming step so hidden/tooling paths are still migrated.",
      },
    ]);
    expect(plan.unclassified).toEqual([]);
  });

  it("builds AI naming context by traversing readable project files without sampling secrets", async () => {
    const reads: string[] = [];
    const listings = new Map<string, RuntimeFileEntry[]>([
      [
        "/home/claude/analysis",
        [
          { name: "README.md", type: "file", absolutePath: "/home/claude/analysis/README.md" },
          { name: "customers.csv", type: "file", absolutePath: "/home/claude/analysis/customers.csv" },
          { name: ".env", type: "file", absolutePath: "/home/claude/analysis/.env" },
          { name: "outputs", type: "directory", absolutePath: "/home/claude/analysis/outputs" },
        ],
      ],
    ]);
    const runtime: LegacyWorkspaceMigrationRuntimeReader = {
      async listLegacyWorkspace(_orgId, _workspaceId, path) {
        const files = listings.get(path) ?? [];
        return { files, count: files.length };
      },
      async readLegacyText(_orgId, _workspaceId, path) {
        reads.push(path);
        if (path.endsWith("README.md")) return "# Customer churn analysis\nNotebook and CSV exploration.";
        if (path.endsWith("customers.csv")) return "name,churned\nAda,false\nGrace,true";
        if (path.endsWith(".env")) return "TOKEN=secret";
        return null;
      },
    };

    const context = await buildLegacyWorkspaceNamingContext({
      runtime,
      orgId: "org-1",
      workspaceId: "workspace-1",
      plan: {
        projects: [
          {
            name: "analysis",
            description: "Migrated notebook or data project.",
            sourcePaths: ["/home/claude/analysis"],
          },
        ],
      },
    });

    expect(reads).toEqual([
      "/home/claude/analysis/README.md",
      "/home/claude/analysis/customers.csv",
    ]);
    expect(context.projects[0].entries).toEqual([
      "file /home/claude/analysis/README.md",
      "file /home/claude/analysis/customers.csv",
      "dir /home/claude/analysis/outputs",
    ]);
    expect(context.projects[0].samples).toEqual([
      { path: "/home/claude/analysis/README.md", text: "# Customer churn analysis\nNotebook and CSV exploration." },
      { path: "/home/claude/analysis/customers.csv", text: "name,churned\nAda,false\nGrace,true" },
    ]);
  });

  it("applies a Think migration plan while preserving source paths and unique slugs", () => {
    const plan = {
      workspaceFiles: [],
      projects: [
        {
          name: "analysis",
          description: "Old description",
          sourcePaths: ["/home/claude/analysis"],
        },
        {
          name: "misc",
          description: "Misc files",
          sourcePaths: ["/home/claude/README.md"],
        },
      ],
    };

    const updated = applyMigrationAgentPlan(plan, {
      projects: [
        {
          name: "Customer Churn Analysis",
          description: "Notebook and CSV work for customer churn exploration.",
          sourcePaths: ["/home/claude/analysis"],
        },
        {
          name: "Customer Churn Analysis",
          description: "  Loose workspace notes.  ",
          sourcePaths: ["/home/claude/README.md"],
        },
      ],
    });

    expect(updated.projects).toEqual([
      {
        name: "customer-churn-analysis",
        description: "Notebook and CSV work for customer churn exploration.",
        sourcePaths: ["/home/claude/analysis"],
        ignoreGlobs: [],
        reason: "Migration planning agent grouped these legacy workspace paths.",
      },
      {
        name: "customer-churn-analysis-2",
        description: "Loose workspace notes.",
        sourcePaths: ["/home/claude/README.md"],
        ignoreGlobs: [],
        reason: "Migration planning agent grouped these legacy workspace paths.",
      },
    ]);
  });

  it("applies deployed app associations from a Think migration plan", () => {
    const deployedApps: MigrationDeployedAppContext[] = [
      {
        scriptName: "customer-dashboard",
        configPath: "/home/claude/analysis/wrangler.jsonc",
        projectId: null,
        updatedAt: 1_700_000_000_000,
        isPublic: true,
      },
    ];
    const plan = {
      workspaceFiles: [],
      projects: [
        {
          name: "analysis",
          description: "Old description",
          sourcePaths: ["/home/claude/analysis"],
        },
      ],
    };

    const updated = applyMigrationAgentPlan(plan, {
      projects: [
        {
          name: "Customer Dashboard",
          description: "Dashboard app for customer analysis.",
          sourcePaths: ["/home/claude/analysis"],
          deployedApps: ["customer-dashboard"],
        },
      ],
    }, { deployedApps });

    expect(updated.projects[0]).toMatchObject({
      name: "customer-dashboard",
      sourcePaths: ["/home/claude/analysis"],
      deployedApps: ["customer-dashboard"],
    });
  });

  it("drops deployed app associations without concrete source evidence", () => {
    const plan = {
      workspaceFiles: [],
      projects: [
        {
          name: "basic-ai-agent",
          description: "Old description",
          sourcePaths: ["/home/claude/basic-ai-agent"],
        },
      ],
    };

    const updated = applyMigrationAgentPlan(plan, {
      projects: [
        {
          name: "basic-ai-agent",
          description: "Basic AI agent project.",
          sourcePaths: ["/home/claude/basic-ai-agent"],
          deployedApps: ["basic-ai-agent", "quick-notes"],
        },
      ],
    }, {
      deployedApps: [
        {
          scriptName: "basic-ai-agent",
          configPath: null,
          projectId: null,
          updatedAt: 1,
          isPublic: true,
        },
        {
          scriptName: "quick-notes",
          configPath: null,
          projectId: null,
          updatedAt: 1,
          isPublic: true,
        },
      ],
    });

    expect(updated.projects[0]?.deployedApps).toEqual(["basic-ai-agent"]);
  });

  it("keeps deployed app associations when the config path is inside the project", () => {
    const plan = {
      workspaceFiles: [],
      projects: [
        {
          name: "customer-dashboard",
          description: "Old description",
          sourcePaths: ["/home/claude/apps/customer-dashboard"],
        },
      ],
    };

    const updated = applyMigrationAgentPlan(plan, {
      projects: [
        {
          name: "customer-dashboard",
          description: "Customer dashboard worker.",
          sourcePaths: ["/home/claude/apps/customer-dashboard"],
          deployedApps: ["customer-dashboard"],
        },
      ],
    }, {
      deployedApps: [
        {
          scriptName: "customer-dashboard",
          configPath: "/home/claude/apps/customer-dashboard/wrangler.jsonc",
          projectId: null,
          updatedAt: 1,
          isPublic: true,
        },
      ],
    });

    expect(updated.projects[0]?.deployedApps).toEqual(["customer-dashboard"]);
  });

  it("keeps the first valid deployed app association when the agent duplicates it", () => {
    const deployedApps: MigrationDeployedAppContext[] = [
      {
        scriptName: "hello-world-test",
        configPath: "/home/claude/hello-world-test/wrangler.jsonc",
        projectId: null,
        updatedAt: 1,
        isPublic: true,
      },
    ];
    const plan = {
      workspaceFiles: [],
      projects: [
        {
          name: "hello-world-test",
          description: "Old description",
          sourcePaths: ["/home/claude/hello-world-test"],
        },
        {
          name: "misc",
          description: "Old description",
          sourcePaths: ["/home/claude/README.md"],
        },
      ],
    };

    const updated = applyMigrationAgentPlan(plan, {
      projects: [
        {
          name: "hello-world-test",
          description: "Hello world worker.",
          sourcePaths: ["/home/claude/hello-world-test"],
          deployedApps: ["hello-world-test"],
        },
        {
          name: "misc",
          description: "Loose workspace files.",
          sourcePaths: ["/home/claude/README.md"],
          deployedApps: ["hello-world-test"],
        },
      ],
    }, { deployedApps });

    expect(updated.projects[0]?.deployedApps).toEqual(["hello-world-test"]);
    expect(updated.projects[1]?.deployedApps).toBeUndefined();
  });

  it("preserves paths that the migration planning agent omits in misc", () => {
    const plan = {
      workspaceFiles: [],
      projects: [
        {
          name: "analysis",
          description: "Old description",
          sourcePaths: ["/home/claude/analysis"],
        },
        {
          name: "misc",
          description: "Misc files",
          sourcePaths: ["/home/claude/README.md"],
        },
      ],
    };

    const updated = applyMigrationAgentPlan(plan, {
      projects: [
        {
          name: "analysis",
          description: "Notebook and CSV work.",
          sourcePaths: ["/home/claude/analysis"],
        },
      ],
    });

    expect(updated.projects).toEqual([
      {
        name: "analysis",
        description: "Notebook and CSV work.",
        sourcePaths: ["/home/claude/analysis"],
        ignoreGlobs: [],
        reason: "Migration planning agent grouped these legacy workspace paths.",
      },
      {
        name: "legacy-workspace-misc",
        description: "Miscellaneous legacy workspace paths preserved because the migration planning agent did not classify them.",
        sourcePaths: ["/home/claude/README.md"],
        ignoreGlobs: [],
        reason: "Added automatically so every allowed legacy source path is migrated exactly once.",
      },
    ]);
  });

  it("coalesces model and safety misc projects into one leftover project", () => {
    const plan = {
      workspaceFiles: [],
      projects: [
        {
          name: "app",
          description: "Old description",
          sourcePaths: ["/home/claude/app"],
        },
        {
          name: "README.md",
          description: "Old description",
          sourcePaths: ["/home/claude/README.md"],
        },
        {
          name: "notes.txt",
          description: "Old description",
          sourcePaths: ["/home/claude/notes.txt"],
        },
      ],
      unclassified: ["/home/claude/.cache"],
    };

    const result = appendUnclassifiedMiscProject(applyMigrationAgentPlan(plan, {
      projects: [
        {
          name: "app",
          description: "Application source.",
          sourcePaths: ["/home/claude/app"],
        },
        {
          name: "misc",
          description: "Loose notes.",
          sourcePaths: ["/home/claude/README.md"],
        },
      ],
    }));

    const miscProjects = result.projects.filter((project) => project.name.includes("misc"));
    expect(miscProjects).toHaveLength(1);
    expect(miscProjects[0]).toMatchObject({
      name: "legacy-workspace-misc",
      sourcePaths: ["/home/claude/README.md", "/home/claude/notes.txt", "/home/claude/.cache"],
    });
  });

  it("deduplicates source paths from migration planning agent proposals", () => {
    const plan = {
      workspaceFiles: [],
      projects: [
        {
          name: "analysis",
          description: "Old description",
          sourcePaths: ["/home/claude/analysis"],
        },
        {
          name: "misc",
          description: "Misc files",
          sourcePaths: ["/home/claude/README.md"],
        },
      ],
    };

    const updated = applyMigrationAgentPlan(plan, {
      projects: [
        {
          name: "analysis",
          description: "Notebook and CSV work.",
          sourcePaths: ["/home/claude/analysis"],
        },
        {
          name: "notes",
          description: "Loose workspace notes.",
          sourcePaths: ["/home/claude/analysis", "/home/claude/README.md"],
        },
      ],
    });

    expect(updated.projects.map((project) => project.sourcePaths)).toEqual([
      ["/home/claude/analysis"],
      ["/home/claude/README.md"],
    ]);
  });

  it("rejects Think migration plans that invent deployed apps", () => {
    const plan = {
      workspaceFiles: [],
      projects: [
        {
          name: "analysis",
          description: "Old description",
          sourcePaths: ["/home/claude/analysis"],
        },
      ],
    };

    expect(() => applyMigrationAgentPlan(plan, {
      projects: [
        {
          name: "analysis",
          description: "Notebook and CSV work.",
          sourcePaths: ["/home/claude/analysis"],
          deployedApps: ["unknown-app"],
        },
      ],
    }, { deployedApps: [] })).toThrow("unknown deployed app: unknown-app");
  });

  it("includes deployed app metadata in the migration planning prompt", () => {
    const prompt = JSON.parse(buildMigrationPlanningPrompt({
      workspaceId: "workspace-1",
      plan: {
        workspaceFiles: [],
        projects: [
          {
            name: "analysis",
            description: "Legacy workspace path analysis.",
            sourcePaths: ["/home/claude/analysis"],
          },
        ],
      },
      context: {
        workspaceId: "workspace-1",
        projects: [
          {
            index: 0,
            currentName: "analysis",
            currentDescription: "Legacy workspace path analysis.",
            sourcePaths: ["/home/claude/analysis"],
            entries: [
              "file /home/claude/analysis/wrangler.jsonc",
              "file /home/claude/analysis/package.json",
            ],
            samples: [],
          },
        ],
      },
      deployedApps: [
        {
          scriptName: "customer-dashboard",
          configPath: "/home/claude/analysis/wrangler.jsonc",
          projectId: null,
          updatedAt: 1_700_000_000_000,
          isPublic: true,
        },
      ],
    }));

    expect(prompt.deployed_apps).toEqual([
      {
        scriptName: "customer-dashboard",
        configPath: "/home/claude/analysis/wrangler.jsonc",
        projectId: null,
        updatedAt: 1_700_000_000_000,
        isPublic: true,
      },
    ]);
    expect(prompt.hard_requirements).toContain(
      "Associate a deployed app only when its configPath is inside one of the project's sourcePaths, its projectId clearly identifies that project, or its scriptName matches a project source directory name.",
    );
    expect(prompt.hard_requirements).toContain(
      "Use at most one misc project for unrelated loose files, caches, dotfolders, or leftovers that still need to be moved.",
    );
    expect(prompt.hard_requirements).toContain(
      "Do not include multiple independent Worker apps in the same project. If multiple source paths each contain a Wrangler config, return them as separate projects.",
    );
    expect(prompt.hard_requirements).toContain(
      "Do not put two detected_worker_app_paths entries in the same project. Worker app source paths are hard project boundaries, even if they are nearby or have similar names.",
    );
    expect(prompt.hard_requirements).toContain(
      "Loose top-level files should usually be clustered by topic, notebook/script/data relationship, or put in the single misc project. Do not create one-file projects for images, CSVs, JSON outputs, logs, lockfiles, or generated artifacts unless the file is clearly a standalone user-authored project.",
    );
    expect(prompt.detected_worker_app_instruction).toBe(
      "Each detected_worker_app_paths entry is a Worker app boundary. Keep every detected Worker app source path in its own project and never group two detected Worker apps together.",
    );
    expect(prompt.deployed_app_evidence_rules.instruction).toBe(
      "Only include deployedApps with strong evidence. Weak evidence means leave the app unassociated.",
    );
    expect(prompt.project_detection_script).toContain("detectWorkerAppProjects");
    expect(prompt.detected_worker_app_paths).toEqual(["/home/claude/analysis"]);
  });

  it("detects Worker app source paths from Wrangler config entries", () => {
    expect(detectWorkerAppSourcePaths({
      workspaceId: "workspace-1",
      projects: [
        {
          index: 0,
          currentName: "worker-app",
          currentDescription: "Worker app.",
          sourcePaths: ["/home/claude/worker-app"],
          entries: [
            "file /home/claude/worker-app/wrangler.toml",
            "file /home/claude/worker-app/package.json",
          ],
          samples: [],
        },
        {
          index: 1,
          currentName: "notebook",
          currentDescription: "Notebook work.",
          sourcePaths: ["/home/claude/notebook"],
          entries: ["file /home/claude/notebook/README.md"],
          samples: [],
        },
      ],
    })).toEqual(["/home/claude/worker-app"]);
  });

  it("carries 100 Worker app projects plus loose analysis files through planning context", async () => {
    const workerEntries = Array.from({ length: 100 }, (_, index) => {
      const name = `worker-app-${String(index + 1).padStart(3, "0")}`;
      return { name, type: "directory" as const, absolutePath: `/home/claude/${name}` };
    });
    const looseAnalysisEntries = [
      { name: "analysis.ipynb", type: "file" as const, absolutePath: "/home/claude/analysis.ipynb" },
      { name: "customers.csv", type: "file" as const, absolutePath: "/home/claude/customers.csv" },
      { name: "analysis-notes.md", type: "file" as const, absolutePath: "/home/claude/analysis-notes.md" },
    ];
    const plan = buildLegacyWorkspaceMigrationSeedPlan({
      entries: [...workerEntries, ...looseAnalysisEntries],
    });
    const listings = new Map<string, RuntimeFileEntry[]>();
    for (const entry of workerEntries) {
      listings.set(entry.absolutePath, [
        { name: "wrangler.jsonc", type: "file", absolutePath: `${entry.absolutePath}/wrangler.jsonc` },
        { name: "package.json", type: "file", absolutePath: `${entry.absolutePath}/package.json` },
        { name: "src", type: "directory", absolutePath: `${entry.absolutePath}/src` },
      ]);
    }
    const runtime: LegacyWorkspaceMigrationRuntimeReader = {
      async listLegacyWorkspace(_orgId, _workspaceId, path) {
        const files = listings.get(path) ?? [];
        return { files, count: files.length };
      },
      async readLegacyText(_orgId, _workspaceId, path) {
        if (path.endsWith(".ipynb")) return "{\"cells\":[{\"source\":[\"Random data analysis notebook\"]}]}";
        if (path.endsWith(".csv")) return "customer,value\nAda,10\nGrace,20";
        if (path.endsWith(".md")) return "# Analysis notes\nLoose exploratory files.";
        return null;
      },
    };

    const context = await buildLegacyWorkspaceNamingContext({
      runtime,
      orgId: "org-1",
      workspaceId: "workspace-1",
      plan,
    });
    const prompt = JSON.parse(buildMigrationPlanningPrompt({
      workspaceId: "workspace-1",
      plan,
      context,
    }));
    const expectedWorkerPaths = workerEntries.map((entry) => entry.absolutePath);
    const expectedLoosePaths = looseAnalysisEntries.map((entry) => entry.absolutePath);

    expect(context.projects).toHaveLength(101);
    expect(context.projects[100]).toMatchObject({
      currentName: "legacy-workspace-loose-files",
      sourcePaths: expectedLoosePaths,
    });
    expect(prompt.allowed_source_paths).toHaveLength(103);
    expect(prompt.detected_worker_app_paths).toHaveLength(100);
    expect(prompt.detected_worker_app_paths).toEqual(expectedWorkerPaths);
    expect(prompt.allowed_source_paths).toEqual([...expectedWorkerPaths, ...expectedLoosePaths]);

    const updated = applyMigrationAgentPlan(plan, {
      projects: [
        ...workerEntries.map((entry) => ({
          name: entry.name,
          description: `Worker app ${entry.name}.`,
          sourcePaths: [entry.absolutePath],
        })),
        {
          name: "random-data-analysis",
          description: "Loose notebook, CSV, and notes for exploratory data analysis.",
          sourcePaths: expectedLoosePaths,
        },
      ],
    });
    const assignedPaths = updated.projects.flatMap((project) => project.sourcePaths);

    expect(updated.projects).toHaveLength(101);
    expect(new Set(assignedPaths).size).toBe(103);
    expect(assignedPaths.sort()).toEqual([...expectedWorkerPaths, ...expectedLoosePaths].sort());
    expect(updated.projects.slice(0, 100).every((project) => project.sourcePaths.length === 1)).toBe(true);
  });

  it("rejects agent plans that group multiple Worker app roots", () => {
    expect(() => applyMigrationAgentPlan({
      projects: [
        {
          name: "worker-a",
          description: "Worker A.",
          sourcePaths: ["/home/claude/worker-a"],
        },
        {
          name: "worker-b",
          description: "Worker B.",
          sourcePaths: ["/home/claude/worker-b"],
        },
      ],
      workspaceFiles: [],
    }, {
      projects: [
        {
          name: "combined-workers",
          description: "Two workers incorrectly grouped together.",
          sourcePaths: ["/home/claude/worker-a", "/home/claude/worker-b"],
        },
      ],
    }, {
      workerAppSourcePaths: ["/home/claude/worker-a", "/home/claude/worker-b"],
    })).toThrow("Migration planning agent grouped multiple Worker app source paths into one project");
  });

  it("rejects agent plans that attach loose paths to a Worker app root", () => {
    expect(() => applyMigrationAgentPlan({
      projects: [
        {
          name: "worker-a",
          description: "Worker A.",
          sourcePaths: ["/home/claude/worker-a"],
        },
        {
          name: "loose-files",
          description: "Loose files.",
          sourcePaths: ["/home/claude/report.csv"],
        },
      ],
      workspaceFiles: [],
    }, {
      projects: [
        {
          name: "worker-a",
          description: "Worker A plus unrelated output.",
          sourcePaths: ["/home/claude/worker-a", "/home/claude/report.csv"],
        },
      ],
    }, {
      workerAppSourcePaths: ["/home/claude/worker-a"],
    })).toThrow("Migration planning agent grouped Worker app source paths with extra source paths");
  });

  it("uses a structured output JSON schema text format for migration planning", () => {
    const textFormat = buildMigrationPlanningTextFormat(["/home/claude/app"]);

    expect(textFormat).toMatchObject({
      type: "json_schema",
      name: "legacy_workspace_migration_plan",
      strict: true,
      schema: {
        type: "object",
      },
    });
    const schema = textFormat.schema as {
      properties: {
        projects: {
          items: {
            required: string[];
            properties: {
              sourcePaths: {
                items: {
                  enum: string[];
                };
              };
            };
          };
        };
      };
    };
    expect(schema.properties.projects.items.required).toEqual([
      "name",
      "description",
      "sourcePaths",
      "deployedApps",
      "reason",
    ]);
    expect(schema.properties.projects.items.properties.sourcePaths.items.enum).toEqual(["/home/claude/app"]);
  });

  it("builds a Cloudflare Responses API request for migration planning", () => {
    const request = buildMigrationPlanningResponsesRequest("Plan this workspace", ["/home/claude/app"]);

    expect(request).toMatchObject({
      model: "gpt-5.5",
      stream: true,
      input: "Plan this workspace",
      text: {
        format: {
          type: "json_schema",
          name: "legacy_workspace_migration_plan",
        },
      },
    });
    expect(request.instructions).toContain(
      "A source path containing wrangler.toml, wrangler.json, or wrangler.jsonc is a Worker app project boundary.",
    );
    expect(request.instructions).toContain(
      "The seed plan is discovery context, not the final project list. Cluster related loose files and avoid one-file projects for generated outputs.",
    );
  });

  it("reads streaming Responses API output for migration planning", async () => {
    const encoded = new TextEncoder().encode([
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "{\"projects\":[" })}\n\n`,
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "{\"name\":\"analysis\",\"description\":\"Notebook work\",\"sourcePaths\":[\"/home/claude/analysis\"]}" })}\n\n`,
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "]}" })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""));
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoded);
        controller.close();
      },
    }), {
      headers: { "content-type": "text/event-stream" },
    });

    const payload = await readMigrationPlanningResponsesPayload(response);
    expect(parseMigrationPlanningAiResult(payload)).toEqual({
      projects: [
        {
          name: "analysis",
          description: "Notebook work",
          sourcePaths: ["/home/claude/analysis"],
        },
      ],
    });
  });

  it("parses Responses API structured output migration planning AI results", () => {
    const plan = parseMigrationPlanningAiResult({
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                projects: [
                  {
                    name: "analysis",
                    description: "Notebook and CSV analysis.",
                    sourcePaths: ["/home/claude/analysis"],
                  },
                ],
              }),
            },
          ],
        },
      ],
    });

    expect(plan).toEqual({
      projects: [
        {
          name: "analysis",
          description: "Notebook and CSV analysis.",
          sourcePaths: ["/home/claude/analysis"],
        },
      ],
    });
  });

  it("parses output_text migration planning AI results", () => {
    const plan = parseMigrationPlanningAiResult({
      output_text: JSON.stringify({
        projects: [
          {
            name: "analysis",
            description: "Notebook and CSV analysis.",
            sourcePaths: ["/home/claude/analysis"],
          },
        ],
      }),
    });

    expect(plan).toEqual({
      projects: [
        {
          name: "analysis",
          description: "Notebook and CSV analysis.",
          sourcePaths: ["/home/claude/analysis"],
        },
      ],
    });
  });

  it("parses OpenAI-compatible message content migration planning AI results", () => {
    const plan = parseMigrationPlanningAiResult({
      choices: [
        {
          message: {
            content: JSON.stringify({
              projects: [
                {
                  name: "analysis",
                  description: "Notebook and CSV analysis.",
                  sourcePaths: ["/home/claude/analysis"],
                  deployedApps: [],
                  reason: "Single notebook project.",
                },
              ],
            }),
          },
        },
      ],
    });

    expect(plan).toEqual({
      projects: [
        {
          name: "analysis",
          description: "Notebook and CSV analysis.",
          sourcePaths: ["/home/claude/analysis"],
          deployedApps: [],
          reason: "Single notebook project.",
        },
      ],
    });
  });

  it("rejects migration planning AI results without structured output text", () => {
    expect(() => parseMigrationPlanningAiResult({
      choices: [
        {
          message: {
            tool_calls: [],
          },
        },
      ],
    })).toThrow("returned no structured output text");
  });

  it("reports when deployed apps exist but the legacy source scan is empty", () => {
    const diagnostics = buildLegacyWorkspaceMigrationDiagnostics({
      legacyRoot: "/home/claude",
      legacyFileCount: 0,
      deployedApps: [
        {
          scriptName: "simple-web-app",
          configPath: null,
          projectId: null,
          updatedAt: 1_700_000_000_000,
          isPublic: true,
        },
      ],
    });

    expect(diagnostics).toMatchObject({
      legacyRoot: "/home/claude",
      legacyFileCount: 0,
      deployedAppCount: 1,
      deployedAppNames: ["simple-web-app"],
      warnings: [
        expect.stringContaining("migration source is probably not connected to the legacy sandbox storage"),
      ],
    });
  });

  it("stores migration status and migrated project metadata in the workspace filesystem", async () => {
    const workspaceId = `migration-test-${crypto.randomUUID()}`;
    const workspace = new WorkspaceFilesystemClient(env, workspaceId);

    await expect(workspace.getLegacyWorkspaceMigrationState()).resolves.toMatchObject({
      workspaceId: expect.any(String),
      migrationVersion: CURRENT_LEGACY_WORKSPACE_MIGRATION_VERSION,
      status: "not_started",
      attempts: 0,
    });

    const state = await workspace.setLegacyWorkspaceMigrationState({
      status: "copying",
      orgId: "org-1",
      workflowId: "workflow-1",
      attempts: 1,
      plan: {
        projects: [
          {
            name: "web-app",
            description: "Migrated app",
            sourcePaths: ["/home/claude/web-app"],
          },
        ],
      },
    });
    expect(state).toMatchObject({
      workspaceId: expect.any(String),
      orgId: "org-1",
      migrationVersion: CURRENT_LEGACY_WORKSPACE_MIGRATION_VERSION,
      status: "copying",
      workflowId: "workflow-1",
      attempts: 1,
    });

    const project = await workspace.createProject({
      name: "web-app",
      description: "Migrated app",
      migratedFrom: {
        workspaceId,
        legacyRoot: "/home/claude",
        sourcePaths: ["/home/claude/web-app"],
        migratedAt: "2026-06-04T00:00:00.000Z",
      },
    });

    expect(project).toMatchObject({
      name: "web-app",
      description: "Migrated app",
      migratedFrom: {
        workspaceId,
        legacyRoot: "/",
        sourcePaths: ["/home/claude/web-app"],
      },
    });
  });

  it("deletes only migration-owned projects before a migration rerun", async () => {
    const workspaceId = `migration-cleanup-${crypto.randomUUID()}`;
    const workspace = new WorkspaceFilesystemClient(env, workspaceId);

    const migrated = await workspace.createProject({
      name: "old-migrated-project",
      description: "Old migrated project.",
      migratedFrom: {
        workspaceId,
        legacyRoot: "/home/claude",
        sourcePaths: ["/home/claude/old"],
        migratedAt: "2026-06-04T00:00:00.000Z",
      },
    });
    const manual = await workspace.createProject({
      name: "manual-project",
      description: "User-created project.",
    });

    const cleanup = await workspace.deleteMigratedProjectsForWorkspace();

    expect(cleanup.deleted.map((project) => project.name)).toEqual([migrated.name]);
    expect(cleanup.retained.map((project) => project.name)).toEqual([manual.name]);
    await expect(workspace.listProjects()).resolves.toEqual([
      expect.objectContaining({ name: manual.name }),
    ]);
  });

  it("clears stale migration errors when a later run succeeds", async () => {
    const workspaceId = `migration-error-clear-${crypto.randomUUID()}`;
    const workspace = new WorkspaceFilesystemClient(env, workspaceId);

    await workspace.setLegacyWorkspaceMigrationState({
      status: "failed",
      error: "old planning error",
      completedAt: "2026-06-04T00:00:00.000Z",
    });
    const queued = await workspace.setLegacyWorkspaceMigrationState({
      status: "queued",
      workflowId: "workflow-2",
    });
    expect(queued.error).toBeUndefined();
    expect(queued.completedAt).toBeUndefined();

    const complete = await workspace.setLegacyWorkspaceMigrationState({
      status: "dry_run_complete",
      plan: { projects: [] },
      completedAt: "2026-06-05T00:00:00.000Z",
    });
    expect(complete.error).toBeUndefined();
    expect(complete.completedAt).toBe("2026-06-05T00:00:00.000Z");
  });

  it("clears previous migration progress when queueing a rerun", async () => {
    const workspaceId = `migration-rerun-clear-${crypto.randomUUID()}`;
    const workspace = new WorkspaceFilesystemClient(env, workspaceId);

    await workspace.setLegacyWorkspaceMigrationState({
      status: "complete",
      plan: {
        projects: [
          {
            name: "bad-project",
            description: "Old bad plan",
            sourcePaths: ["/home/claude/bad-project"],
          },
        ],
      },
      createdProjects: ["bad-project"],
      copiedFiles: 10,
      copiedBytes: 1024,
      skippedPaths: ["/home/claude/.cache"],
      diagnostics: { legacyRoot: "/home/claude", legacyFileCount: 1 },
      startedAt: "2026-06-04T00:00:00.000Z",
      completedAt: "2026-06-05T00:00:00.000Z",
    });

    const queued = await workspace.setLegacyWorkspaceMigrationState({
      status: "queued",
      orgId: "org-1",
      workflowId: "workflow-rerun",
    });

    expect(queued).toMatchObject({
      status: "queued",
      orgId: "org-1",
      workflowId: "workflow-rerun",
    });
    expect(queued.plan).toBeUndefined();
    expect(queued.createdProjects).toBeUndefined();
    expect(queued.copiedFiles).toBeUndefined();
    expect(queued.copiedBytes).toBeUndefined();
    expect(queued.skippedPaths).toBeUndefined();
    expect(queued.diagnostics).toBeUndefined();
    expect(queued.startedAt).toBeUndefined();
    expect(queued.completedAt).toBeUndefined();
  });
});
