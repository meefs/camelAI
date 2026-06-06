import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  applyMigrationAgentPlan,
  appendUnclassifiedMiscProject,
  buildLegacyWorkspaceMigrationDiagnostics,
  buildLegacyWorkspaceMigrationSeedPlan,
  detectWorkerAppSourcePaths,
  buildMigrationPlanningResponsesRequest,
  buildMigrationPlanningPrompt,
  buildLegacyWorkspaceNamingContext,
  parseMigrationPlanningAiResult,
  resetProjectsForWorkspaceMigration,
  type MigrationDeployedAppContext,
  type LegacyWorkspaceMigrationRuntimeReader,
  type RuntimeFileEntry,
} from "../src/legacy-workspace-migration-workflow";
import { CURRENT_LEGACY_WORKSPACE_MIGRATION_VERSION } from "../../../src/lib/legacy-workspace-migration-version";
import { getWorkspaceMigrationGate } from "../../../src/lib/workspace-migration-gate.server";
import {
  normalizeLegacyMigrationProjectReference,
  WorkspaceFilesystemClient,
} from "../src/workspace-filesystem-do";
import {
  cancelLegacyWorkspaceMigration,
  queueLegacyWorkspaceMigrationIfNeeded,
} from "../src/legacy-workspace-migration-queue";

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

  it("applies a migration AI plan while preserving source paths and unique slugs", () => {
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

  it("applies deployed app associations from a migration AI plan", () => {
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

  it("rejects migration AI plans that invent deployed apps", () => {
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

  it("builds non-streaming Responses requests with planning tools and structured output", () => {
    const request = buildMigrationPlanningResponsesRequest(
      "plan this workspace",
      ["/home/claude/app", "/home/claude/analysis.ipynb"],
      "resp_previous",
    );

    expect(request).toMatchObject({
      model: "gpt-5.5",
      stream: false,
      input: "plan this workspace",
      previous_response_id: "resp_previous",
    });
    expect(request.instructions).toEqual(expect.stringContaining("You may inspect the legacy filesystem with read-only tools."));
    expect(request.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "function", name: "list_legacy_path", strict: true }),
      expect.objectContaining({ type: "function", name: "read_legacy_text", strict: true }),
      expect.objectContaining({ type: "function", name: "list_deployed_apps", strict: true }),
    ]));
    expect(request.text).toMatchObject({
      format: {
        type: "json_schema",
        name: "legacy_workspace_migration_plan",
        strict: true,
      },
    });
    const schema = (request.text as { format: { schema: { properties: { projects: { items: { properties: { sourcePaths: { items: { enum: string[] } } } } } } } } }).format.schema;
    expect(schema.properties.projects.items.properties.sourcePaths.items.enum).toEqual([
      "/home/claude/app",
      "/home/claude/analysis.ipynb",
    ]);
  });

  it("parses non-streaming Responses structured output", () => {
    expect(parseMigrationPlanningAiResult({
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
                    description: "Notebook analysis.",
                    sourcePaths: ["/home/claude/analysis.ipynb"],
                  },
                ],
              }),
            },
          ],
        },
      ],
    })).toEqual({
      projects: [
        {
          name: "analysis",
          description: "Notebook analysis.",
          sourcePaths: ["/home/claude/analysis.ipynb"],
        },
      ],
    });
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

    const ensuredProject = await workspace.ensureLegacyMigrationProject({
      name: "notebook-analysis",
      description: "Migrated notebook analysis.",
      migratedFrom: {
        workspaceId,
        legacyRoot: "/home/claude",
        sourcePaths: ["/home/claude/notebook.ipynb"],
        migratedAt: "2026-06-04T00:00:00.000Z",
      },
    });

    expect(ensuredProject).toEqual({
      projectId: expect.stringContaining("migrationtest"),
      projectName: "notebook-analysis",
    });
  });

  it("normalizes migration project references before workflow step cloning", async () => {
    const rawProjectRef = {
      projectId: Promise.resolve("project-1"),
      projectName: Promise.resolve("Notebook analysis"),
    };
    expect(() => structuredClone(rawProjectRef)).toThrow();

    const projectRef = await normalizeLegacyMigrationProjectReference({
      projectId: Promise.resolve("project-1"),
      projectName: Promise.resolve("Notebook analysis"),
    });

    expect(projectRef).toEqual({
      projectId: "project-1",
      projectName: "Notebook analysis",
    });
    expect(structuredClone(projectRef)).toEqual(projectRef);
  });

  it("deletes all projects before a migration rerun", async () => {
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

    const cleanup = await workspace.deleteProjectsForWorkspace();

    expect(cleanup.deleted.map((project) => project.name)).toEqual([migrated.name, manual.name]);
    expect(cleanup.retained).toEqual([]);
    await expect(workspace.listProjects()).resolves.toEqual([]);
  });

  it("deletes all runtime projects before removing rerun metadata", async () => {
    const workspaceId = `migration-runtime-cleanup-${crypto.randomUUID()}`;
    const workspace = new WorkspaceFilesystemClient(env, workspaceId);
    const calls: string[] = [];

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

    const result = await resetProjectsForWorkspaceMigration({
      workspaceId,
      workspaceFs: {
        listProjectsForMigrationReset: async () => workspace.listProjectsForMigrationReset(),
        deleteProjectsForWorkspace: async (id) => {
          calls.push("metadata");
          return workspace.deleteProjectsForWorkspace(id);
        },
      },
      runtime: {
        deleteProject: async (projectId) => {
          calls.push(`runtime:${projectId}`);
        },
      },
    });

    expect(result.deletedProjectIds).toEqual([migrated.id, manual.id]);
    expect(calls.slice(0, 2).sort()).toEqual([`runtime:${manual.id}`, `runtime:${migrated.id}`].sort());
    expect(calls[2]).toBe("metadata");
    await expect(workspace.listProjects()).resolves.toEqual([]);
  });

  it("deletes cloned runtime projects before their sources during migration reset", async () => {
    const calls: string[] = [];

    const result = await resetProjectsForWorkspaceMigration({
      workspaceId: "workspace-1",
      workspaceFs: {
        listProjectsForMigrationReset: async () => [
          { id: "source" },
          { id: "clone", clonedFromProjectId: "source" },
          { id: "nested-clone", clonedFromProjectId: "clone" },
        ],
        deleteProjectsForWorkspace: async () => {
          calls.push("metadata");
          return {
            deleted: [{ id: "source" }, { id: "clone" }, { id: "nested-clone" }],
            retained: [],
          };
        },
      },
      runtime: {
        deleteProject: async (projectId) => {
          calls.push(`runtime:${projectId}`);
        },
      },
    });

    expect(result.deletedProjectIds).toEqual(["source", "clone", "nested-clone"]);
    expect(calls).toEqual([
      "runtime:nested-clone",
      "runtime:clone",
      "runtime:source",
      "metadata",
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

  it("migration gate queues any workspace that does not have a current completed migration", async () => {
    const workspaceId = `migration-gate-needed-${crypto.randomUUID()}`;
    const workflowCreateBatch = vi.fn().mockResolvedValue([{ id: "workflow-1" }]);

    const gate = await getWorkspaceMigrationGate({
      ...env,
      ENABLE_LEGACY_WORKSPACE_MIGRATION: "1",
      LEGACY_WORKSPACE_HOST: { fetch: vi.fn() },
      LEGACY_WORKSPACE_MIGRATIONS: {
        createBatch: workflowCreateBatch,
      },
    } as never, {
      id: workspaceId,
      org_id: "org-1",
    });

    expect(workflowCreateBatch).toHaveBeenCalledOnce();
    expect(workflowCreateBatch.mock.calls[0][0]).toEqual([
      {
        id: `legacy-migration-v${CURRENT_LEGACY_WORKSPACE_MIGRATION_VERSION}-${workspaceId}`,
        params: {
          workspaceId,
          orgId: "org-1",
          requestedBy: "workspace-page-gate",
          dryRun: false,
          force: false,
        },
      },
    ]);
    expect(gate).toEqual({
      workspaceId,
      status: "queued",
      reason: "active",
    });
  });

  it("migration gate treats an existing workflow instance as already queued", async () => {
    const workspaceId = `migration-gate-existing-${crypto.randomUUID()}`;
    const workflowCreateBatch = vi.fn().mockResolvedValue([]);

    const gate = await getWorkspaceMigrationGate({
      ...env,
      ENABLE_LEGACY_WORKSPACE_MIGRATION: "1",
      LEGACY_WORKSPACE_HOST: { fetch: vi.fn() },
      LEGACY_WORKSPACE_MIGRATIONS: {
        createBatch: workflowCreateBatch,
      },
    } as never, {
      id: workspaceId,
      org_id: "org-1",
    });

    expect(workflowCreateBatch).toHaveBeenCalledOnce();
    expect(gate).toEqual({
      workspaceId,
      status: "queued",
      reason: "active",
    });
  });

  it("migration gate does not queue when migration state is already active", async () => {
    const workspaceId = `migration-gate-active-${crypto.randomUUID()}`;
    const workspace = new WorkspaceFilesystemClient(env, workspaceId);
    await workspace.setLegacyWorkspaceMigrationState({
      status: "copying",
      workflowId: "stale-workflow",
    });
    const workflowCreateBatch = vi.fn();

    const gate = await getWorkspaceMigrationGate({
      ...env,
      ENABLE_LEGACY_WORKSPACE_MIGRATION: "1",
      LEGACY_WORKSPACE_HOST: { fetch: vi.fn() },
      LEGACY_WORKSPACE_MIGRATIONS: {
        createBatch: workflowCreateBatch,
      },
    } as never, {
      id: workspaceId,
      org_id: "org-1",
    });

    expect(workflowCreateBatch).not.toHaveBeenCalled();
    expect(gate).toEqual({
      workspaceId,
      status: "copying",
      reason: "active",
    });
  });

  it("migration gate does not queue a current completed migration", async () => {
    const workspaceId = `migration-gate-complete-${crypto.randomUUID()}`;
    const workspace = new WorkspaceFilesystemClient(env, workspaceId);
    await workspace.setLegacyWorkspaceMigrationState({
      status: "complete",
      completedAt: new Date().toISOString(),
    });
    const workflowCreateBatch = vi.fn();

    const gate = await getWorkspaceMigrationGate({
      ...env,
      ENABLE_LEGACY_WORKSPACE_MIGRATION: "1",
      LEGACY_WORKSPACE_HOST: { fetch: vi.fn() },
      LEGACY_WORKSPACE_MIGRATIONS: {
        createBatch: workflowCreateBatch,
      },
    } as never, {
      id: workspaceId,
      org_id: "org-1",
    });

    expect(workflowCreateBatch).not.toHaveBeenCalled();
    expect(gate).toBeNull();
  });

  it("migration gate keeps canceled migrations blocked until an admin reruns them", async () => {
    const workspaceId = `migration-gate-canceled-${crypto.randomUUID()}`;
    const workspace = new WorkspaceFilesystemClient(env, workspaceId);
    await workspace.setLegacyWorkspaceMigrationState({
      status: "canceled",
      error: "Migration canceled by admin",
      workflowId: "workflow-canceled",
      completedAt: new Date().toISOString(),
    });
    const workflowCreateBatch = vi.fn();

    const gate = await getWorkspaceMigrationGate({
      ...env,
      ENABLE_LEGACY_WORKSPACE_MIGRATION: "1",
      LEGACY_WORKSPACE_HOST: { fetch: vi.fn() },
      LEGACY_WORKSPACE_MIGRATIONS: {
        createBatch: workflowCreateBatch,
      },
    } as never, {
      id: workspaceId,
      org_id: "org-1",
    });

    expect(workflowCreateBatch).not.toHaveBeenCalled();
    expect(gate).toEqual({
      workspaceId,
      status: "canceled",
      reason: "active",
    });
  });

  it("admin cancellation terminates an active migration workflow and stores canceled state", async () => {
    const workspaceId = `migration-cancel-${crypto.randomUUID()}`;
    const workspace = new WorkspaceFilesystemClient(env, workspaceId);
    await workspace.setLegacyWorkspaceMigrationState({
      status: "copying",
      orgId: "org-1",
      workflowId: "workflow-active",
      leaseId: "lease-1",
    });
    const terminate = vi.fn().mockResolvedValue(undefined);
    const workflowGet = vi.fn().mockResolvedValue({
      status: vi.fn().mockResolvedValue({ status: "running" }),
      terminate,
    });
    const runtimeFetch = vi.fn().mockResolvedValue(new Response(""));

    const result = await cancelLegacyWorkspaceMigration({
      env: {
        ...env,
        PROJECT_RUNTIME_HOST: { fetch: runtimeFetch },
        LEGACY_WORKSPACE_MIGRATIONS: {
          get: workflowGet,
        },
      } as never,
      workspaceId,
      requestedBy: "test-admin",
    });

    expect(workflowGet).toHaveBeenCalledWith("workflow-active");
    expect(terminate).toHaveBeenCalledOnce();
    expect(runtimeFetch).toHaveBeenCalledOnce();
    expect(result.canceled).toBe(true);
    expect(result.workflowId).toBe("workflow-active");
    const state = await workspace.getLegacyWorkspaceMigrationState();
    expect(state).toMatchObject({
      status: "canceled",
      workflowId: "workflow-active",
      error: "Migration canceled by test-admin",
    });
    expect(state.leaseId).toBeUndefined();
  });

  it("forced migration reruns terminate the active migration before queueing a new one", async () => {
    const workspaceId = `migration-force-terminates-${crypto.randomUUID()}`;
    const workspace = new WorkspaceFilesystemClient(env, workspaceId);
    await workspace.setLegacyWorkspaceMigrationState({
      status: "copying",
      orgId: "org-1",
      workflowId: "workflow-active",
      leaseId: "lease-1",
    });
    const terminate = vi.fn().mockResolvedValue(undefined);
    const workflowGet = vi.fn().mockResolvedValue({
      status: vi.fn().mockResolvedValue({ status: "running" }),
      terminate,
    });
    const workflowCreateBatch = vi.fn().mockResolvedValue([{ id: "workflow-rerun" }]);
    const runtimeFetch = vi.fn().mockResolvedValue(new Response(""));

    const result = await queueLegacyWorkspaceMigrationIfNeeded({
      env: {
        ...env,
        PROJECT_RUNTIME_HOST: { fetch: runtimeFetch },
        LEGACY_WORKSPACE_MIGRATIONS: {
          get: workflowGet,
          createBatch: workflowCreateBatch,
        },
      } as never,
      workspaceId,
      orgId: "org-1",
      requestedBy: "test-admin",
      force: true,
    });

    expect(workflowGet).toHaveBeenCalledWith("workflow-active");
    expect(terminate).toHaveBeenCalledOnce();
    expect(runtimeFetch).toHaveBeenCalledOnce();
    expect(workflowCreateBatch).toHaveBeenCalledOnce();
    expect(workflowCreateBatch.mock.calls[0][0][0].id).toMatch(
      new RegExp(`^legacy-migration-v${CURRENT_LEGACY_WORKSPACE_MIGRATION_VERSION}-${workspaceId}-force-`),
    );
    expect(result.queued).toBe(true);
    expect(result.state.status).toBe("queued");
  });
});
