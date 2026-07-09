import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectRuntimeServiceVmBridge } from "../src/project-runtime-service-vm";
import {
  classifyMigrationFiles,
  migrateVmProject,
  migrateWorkspaceVmProjects,
  shouldSkipMigrationPath,
  DEFAULT_MAX_FILE_BYTES,
} from "../src/project-vm-migration";
import type { WorkspaceProject } from "../src/workspace-filesystem-do";

function makeProject(overrides: Partial<WorkspaceProject> = {}): WorkspaceProject {
  return {
    id: "ca-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-web-app",
    name: "web-app",
    description: "Web app.",
    defaultVmId: "main",
    artifactRemote: "https://artifacts.camelai.internal/git/web-app.git",
    artifactStatus: "ready",
    artifactDefaultBranch: "main",
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
    ...overrides,
  } as WorkspaceProject;
}

interface VmFixtureFile {
  relativePath: string;
  content: string;
}

/** Stub global fetch to emulate the runtime-service /fs endpoints. */
function stubRuntimeFs(files: VmFixtureFile[], options: { missingCheckout?: boolean } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname.endsWith("/fs/exists")) {
      if (options.missingCheckout) {
        return Response.json({ exists: false });
      }
      return Response.json({ exists: true, isFile: false, isDirectory: true });
    }
    if (url.pathname.endsWith("/fs/list")) {
      return Response.json({
        files: files.map((file) => ({
          name: file.relativePath.split("/").pop(),
          type: "file",
          size: new TextEncoder().encode(file.content).byteLength,
          relativePath: file.relativePath,
        })),
        count: files.length,
        path: url.searchParams.get("path"),
      });
    }
    if (url.pathname.endsWith("/fs/read")) {
      const path = url.searchParams.get("path") ?? "";
      const match = files.find((file) => path.endsWith(`/${file.relativePath}`));
      if (!match) return new Response("not found", { status: 404 });
      return new Response(new TextEncoder().encode(match.content), {
        headers: { "content-type": "application/octet-stream" },
      });
    }
    throw new Error(`Unexpected runtime fetch: ${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function makeDeps(project: WorkspaceProject) {
  const writes: Array<{ path: string; content: string }> = [];
  const snapshots: Array<{ message?: unknown }> = [];
  const backendFlips: Array<Record<string, unknown>> = [];

  const workspaceFs = {
    getProject: vi.fn(async (projectId: string) => (projectId === project.id ? project : null)),
    getProjectByName: vi.fn(async (name: string) => (name === project.name ? project : null)),
    listProjectsForMigrationReset: vi.fn(async () => [project]),
    setProjectBackend: vi.fn(async (input: Record<string, unknown>) => {
      backendFlips.push(input);
      return { ...project, backend: "do-r2" };
    }),
  };

  const fileStore = {
    writeBinaryFile: vi.fn(async (path: string, base64: string) => {
      writes.push({ path, content: atob(base64) });
      return { success: true };
    }),
    createSourceSnapshot: vi.fn(async (input?: { message?: unknown }) => {
      snapshots.push(input ?? {});
      return { id: "snap-1", createdAt: "2026-07-09T00:00:00.000Z", entries: [] };
    }),
  };

  const bridge = new ProjectRuntimeServiceVmBridge({
    env: { PROJECT_RUNTIME_SERVICE_URL: "http://runtime.test" },
    workspace: workspaceFs as never,
  });

  return {
    deps: {
      bridge,
      workspaceFs: workspaceFs as never,
      fileStoreForProject: () => fileStore as never,
    },
    writes,
    snapshots,
    backendFlips,
    workspaceFs,
    fileStore,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shouldSkipMigrationPath", () => {
  it("skips dependency, build, and container-home junk directories", () => {
    expect(shouldSkipMigrationPath("node_modules/react/index.js", 10, DEFAULT_MAX_FILE_BYTES)).toBe("excluded-dir");
    expect(shouldSkipMigrationPath(".bun/install/cache/pkg.tgz", 10, DEFAULT_MAX_FILE_BYTES)).toBe("excluded-dir");
    expect(shouldSkipMigrationPath(".git/HEAD", 10, DEFAULT_MAX_FILE_BYTES)).toBe("excluded-dir");
    expect(shouldSkipMigrationPath("docling-venv/lib/x.so", 10, DEFAULT_MAX_FILE_BYTES)).toBe("excluded-dir");
    expect(shouldSkipMigrationPath(".claude.json", 10, DEFAULT_MAX_FILE_BYTES)).toBe("excluded-file");
  });

  it("keeps source files, dotfiles, and .dev.vars", () => {
    expect(shouldSkipMigrationPath("src/app.tsx", 10, DEFAULT_MAX_FILE_BYTES)).toBeNull();
    expect(shouldSkipMigrationPath(".dev.vars", 10, DEFAULT_MAX_FILE_BYTES)).toBeNull();
    expect(shouldSkipMigrationPath(".gitignore", 10, DEFAULT_MAX_FILE_BYTES)).toBeNull();
    expect(shouldSkipMigrationPath("package.json", 10, DEFAULT_MAX_FILE_BYTES)).toBeNull();
  });

  it("skips oversized files", () => {
    expect(shouldSkipMigrationPath("data/huge.csv", DEFAULT_MAX_FILE_BYTES + 1, DEFAULT_MAX_FILE_BYTES)).toBe("file-too-large");
  });
});

describe("classifyMigrationFiles", () => {
  it("classifies by build shape", () => {
    expect(classifyMigrationFiles([], null)).toBe("empty");
    expect(
      classifyMigrationFiles([{ relativePath: "package.json" }], JSON.stringify({ scripts: { build: "vite build" } })),
    ).toBe("package-build");
    expect(classifyMigrationFiles([{ relativePath: "package.json" }], JSON.stringify({}))).toBe("package-no-build");
    expect(classifyMigrationFiles([{ relativePath: "app/package.json" }], null)).toBe("nested-package");
    expect(classifyMigrationFiles([{ relativePath: "analysis.ipynb" }], null)).toBe("notebook");
    expect(classifyMigrationFiles([{ relativePath: "index.html" }], null)).toBe("static-html");
    expect(classifyMigrationFiles([{ relativePath: "notes.md" }], null)).toBe("loose-files");
  });
});

describe("migrateVmProject", () => {
  it("copies filtered files, snapshots, and flips the backend", async () => {
    const project = makeProject();
    stubRuntimeFs([
      { relativePath: "package.json", content: JSON.stringify({ scripts: { build: "vite build" } }) },
      { relativePath: "src/app.tsx", content: "export const App = () => null;" },
      { relativePath: ".dev.vars", content: "SECRET=1" },
      { relativePath: "node_modules/react/index.js", content: "junk" },
      { relativePath: ".bun/install/cache/pkg.tgz", content: "junk" },
      { relativePath: ".claude.json", content: "junk" },
    ]);
    const { deps, writes, snapshots, backendFlips } = makeDeps(project);

    const result = await migrateVmProject(deps, project);

    expect(result.status).toBe("migrated");
    expect(result.classification).toBe("package-build");
    expect(result.filesCopied).toBe(3);
    expect(result.skipped.map((skip) => skip.reason).sort()).toEqual([
      "excluded-dir",
      "excluded-dir",
      "excluded-file",
    ]);
    expect(result.snapshotId).toBe("snap-1");
    expect(writes.map((write) => write.path).sort()).toEqual(["/.dev.vars", "/package.json", "/src/app.tsx"]);
    expect(snapshots).toHaveLength(1);
    expect(backendFlips).toEqual([{ projectId: project.id, backend: "do-r2" }]);
  });

  it("dry run copies nothing and flips nothing", async () => {
    const project = makeProject();
    stubRuntimeFs([
      { relativePath: "package.json", content: JSON.stringify({ scripts: { build: "vite build" } }) },
      { relativePath: "index.html", content: "<html></html>" },
    ]);
    const { deps, writes, snapshots, backendFlips } = makeDeps(project);

    const result = await migrateVmProject(deps, project, { dryRun: true });

    expect(result.status).toBe("dry-run");
    expect(result.classification).toBe("package-build");
    expect(result.filesCopied).toBe(2);
    expect(writes).toHaveLength(0);
    expect(snapshots).toHaveLength(0);
    expect(backendFlips).toHaveLength(0);
  });

  it("skips projects already on do-r2 without touching the VM", async () => {
    const project = makeProject({ backend: "do-r2" });
    const fetchMock = stubRuntimeFs([]);
    const { deps, backendFlips } = makeDeps(project);

    const result = await migrateVmProject(deps, project);

    expect(result.status).toBe("already-do-r2");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(backendFlips).toHaveLength(0);
  });

  it("migrates a project with no VM checkout as an empty do-r2 project", async () => {
    const project = makeProject();
    stubRuntimeFs([], { missingCheckout: true });
    const { deps, writes, backendFlips } = makeDeps(project);

    const result = await migrateVmProject(deps, project);

    expect(result.status).toBe("migrated");
    expect(result.missingVmCheckout).toBe(true);
    expect(result.classification).toBe("empty");
    expect(result.filesCopied).toBe(0);
    expect(result.snapshotId).toBeNull();
    expect(writes).toHaveLength(0);
    expect(backendFlips).toHaveLength(1);
  });

  it("fails without flipping when the project exceeds the byte cap", async () => {
    const project = makeProject();
    stubRuntimeFs([{ relativePath: "big.bin", content: "x".repeat(64) }]);
    const { deps, backendFlips } = makeDeps(project);

    const result = await migrateVmProject(deps, project, { maxProjectBytes: 16 });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("above the 16-byte cap");
    expect(backendFlips).toHaveLength(0);
  });

  it("fails without flipping when a DO write fails", async () => {
    const project = makeProject();
    stubRuntimeFs([{ relativePath: "src/app.tsx", content: "code" }]);
    const { deps, fileStore, backendFlips } = makeDeps(project);
    fileStore.writeBinaryFile.mockResolvedValueOnce({ success: false, error: "boom" });

    const result = await migrateVmProject(deps, project);

    expect(result.status).toBe("failed");
    expect(result.error).toContain("boom");
    expect(backendFlips).toHaveLength(0);
  });

  it("fails without flipping when the runtime service is unreachable", async () => {
    const project = makeProject();
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    }));
    const { deps, backendFlips } = makeDeps(project);

    const result = await migrateVmProject(deps, project);

    expect(result.status).toBe("failed");
    expect(result.error).toContain("ECONNREFUSED");
    expect(backendFlips).toHaveLength(0);
  });
});

describe("migrateWorkspaceVmProjects", () => {
  it("summarizes per-project results", async () => {
    const project = makeProject();
    stubRuntimeFs([{ relativePath: "index.html", content: "<html></html>" }]);
    const { deps } = makeDeps(project);

    const summary = await migrateWorkspaceVmProjects(deps, "ws-1");

    expect(summary.processed).toBe(1);
    expect(summary.migrated).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.results[0]!.classification).toBe("static-html");
  });

  it("throws for an unknown project name", async () => {
    const project = makeProject();
    stubRuntimeFs([]);
    const { deps } = makeDeps(project);

    await expect(migrateWorkspaceVmProjects(deps, "ws-1", { projectName: "nope" })).rejects.toThrow(
      "Project not found: nope",
    );
  });
});
