import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectRuntimeServiceVmBridge } from "../src/project-runtime-service-vm";
import {
  classifyMigrationFiles,
  migrateVmProject,
  migrateWorkspaceVmProjects,
  shouldSkipMigrationPath,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_PROJECT_BYTES,
  RPC_SAFE_FILE_BYTES,
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
  /** Override the size reported by /fs/list (to simulate a large file cheaply). */
  size?: number;
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
          size: file.size ?? new TextEncoder().encode(file.content).byteLength,
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
  const adopted: Array<{ path: string; expectedSize: number; streamed: number; contentType?: string }> = [];
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

  const stored = new Map<string, string>();
  const fileStore = {
    writeBinaryFile: vi.fn(async (path: string, base64: string) => {
      writes.push({ path, content: atob(base64) });
      stored.set(path, base64);
      return { success: true };
    }),
    adoptR2File: vi.fn(
      async (path: string, stream: ReadableStream<Uint8Array>, expectedSize: number, contentType?: string) => {
        // Drain the stream the way R2 would, then report the source-reported
        // size back (the real DO cross-checks this against R2's object size).
        let streamed = 0;
        const reader = stream.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          streamed += value.byteLength;
        }
        adopted.push({ path, expectedSize, streamed, contentType });
        return { success: true, size: expectedSize };
      },
    ),
    readFile: vi.fn(async (path: string) => {
      const base64 = stored.get(path);
      if (base64 === undefined) return { success: false, error: `not found: ${path}` };
      return { success: true, content: base64, encoding: "base64" };
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
    adopted,
    snapshots,
    backendFlips,
    workspaceFs,
    fileStore,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("migration size caps", () => {
  it("raises the per-file and per-project defaults for large files", () => {
    expect(DEFAULT_MAX_FILE_BYTES).toBe(1024 * 1024 * 1024);
    expect(DEFAULT_MAX_PROJECT_BYTES).toBe(4 * 1024 * 1024 * 1024);
    // The RPC/base64 write path stays well under the 32 MiB DO RPC ceiling.
    expect(RPC_SAFE_FILE_BYTES).toBeLessThan(23 * 1024 * 1024);
  });
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
    expect(result.appRoots).toEqual([""]);
    expect(result.verifiedFiles).toBeGreaterThan(0);
    expect(writes.map((write) => write.path).sort()).toEqual(["/.dev.vars", "/package.json", "/src/app.tsx"]);
    expect(snapshots).toHaveLength(1);
    expect(backendFlips).toEqual([{ projectId: project.id, backend: "do-r2" }]);
  });

  it("streams large files through the R2 adopt path and keeps small files on RPC", async () => {
    const project = makeProject();
    const bigSize = 40 * 1024 * 1024; // 40 MiB, above the ~20 MiB RPC threshold
    stubRuntimeFs([
      { relativePath: "package.json", content: JSON.stringify({ scripts: { build: "vite build" } }) },
      { relativePath: "src/app.tsx", content: "export const App = () => null;" },
      // Report a large size via /fs/list; the streamed bytes stay tiny in the fake.
      { relativePath: "assets/model.bin", content: "BINARY", size: bigSize },
    ]);
    const { deps, writes, adopted, backendFlips } = makeDeps(project);

    const result = await migrateVmProject(deps, project);

    expect(result.status).toBe("migrated");
    expect(result.filesCopied).toBe(3);
    // Small files went through writeBinaryFile...
    expect(writes.map((write) => write.path).sort()).toEqual(["/package.json", "/src/app.tsx"]);
    // ...and the big file went through the streamed adopt path.
    expect(adopted).toHaveLength(1);
    expect(adopted[0]!.path).toBe("/assets/model.bin");
    expect(adopted[0]!.expectedSize).toBe(bigSize);
    expect(adopted[0]!.contentType).toBe("application/octet-stream");
    // bytesCopied reflects the adopted (reported) size, not the tiny fixture body.
    expect(result.bytesCopied).toBeGreaterThanOrEqual(bigSize);
    // Big files are never read back through RPC for verification.
    expect(result.verifiedFiles).toBeGreaterThan(0);
    expect(backendFlips).toEqual([{ projectId: project.id, backend: "do-r2" }]);
  });

  it("fails without flipping when adopting a large file mismatches its size", async () => {
    const project = makeProject();
    stubRuntimeFs([{ relativePath: "assets/model.bin", content: "BINARY", size: 30 * 1024 * 1024 }]);
    const { deps, fileStore, backendFlips } = makeDeps(project);
    (fileStore as Record<string, unknown>).adoptR2File = vi.fn(async () => ({
      success: false,
      error: "Adopted object size 6 does not match the reported source size 31457280",
      code: "ESIZE",
    }));

    const result = await migrateVmProject(deps, project);

    expect(result.status).toBe("failed");
    expect(result.error).toContain("does not match the reported source size");
    expect(backendFlips).toHaveLength(0);
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

  it("fails without flipping when a DO write persistently fails", async () => {
    const project = makeProject();
    stubRuntimeFs([{ relativePath: "src/app.tsx", content: "code" }]);
    const { deps, fileStore, backendFlips } = makeDeps(project);
    fileStore.writeBinaryFile.mockResolvedValue({ success: false, error: "boom" });

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

describe("collectAppRoots via migration results", () => {
  it("surfaces multiple app roots for multi-app VM projects", async () => {
    const project = makeProject();
    stubRuntimeFs([
      { relativePath: "package.json", content: "{}" },
      { relativePath: "app-two/package.json", content: "{}" },
      { relativePath: "app-two/wrangler.jsonc", content: "{}" },
    ]);
    const { deps } = makeDeps(project);

    const result = await migrateVmProject(deps, project, { dryRun: true });

    expect(result.appRoots).toEqual(["", "app-two"]);
    expect(result.wranglerConfigs).toEqual(["app-two/wrangler.jsonc"]);
  });
});

describe("nested root lift", () => {
  it("lifts a single nested app directory to the project root", async () => {
    const project = makeProject();
    stubRuntimeFs([
      { relativePath: "period-tracker/package.json", content: JSON.stringify({ scripts: { build: "vite build" } }) },
      { relativePath: "period-tracker/src/app.tsx", content: "app" },
      { relativePath: "period-tracker/wrangler.jsonc", content: "{}" },
      { relativePath: "notes.md", content: "loose sibling file" },
    ]);
    const { deps, writes, backendFlips } = makeDeps(project);

    const result = await migrateVmProject(deps, project);

    expect(result.status).toBe("migrated");
    expect(result.liftedRoot).toBe("period-tracker");
    expect(result.classification).toBe("package-build");
    expect(result.appRoots).toEqual([""]);
    expect(writes.map((write) => write.path).sort()).toEqual([
      "/notes.md",
      "/package.json",
      "/src/app.tsx",
      "/wrangler.jsonc",
    ]);
    expect(backendFlips).toHaveLength(1);
  });

  it("does not lift multi-app projects or when a root package.json exists", async () => {
    const project = makeProject();
    stubRuntimeFs([
      { relativePath: "app-one/package.json", content: "{}" },
      { relativePath: "app-two/package.json", content: "{}" },
    ]);
    const { deps } = makeDeps(project);

    const result = await migrateVmProject(deps, project, { dryRun: true });

    expect(result.liftedRoot).toBeNull();
    expect(result.classification).toBe("nested-package");
    expect(result.appRoots).toEqual(["app-one", "app-two"]);
  });

  it("force re-migrates a do-r2 project after clearing the tree", async () => {
    const project = makeProject({ backend: "do-r2" });
    stubRuntimeFs([
      { relativePath: "app/package.json", content: JSON.stringify({ scripts: { build: "b" } }) },
    ]);
    const { deps, fileStore, writes } = makeDeps(project);
    (fileStore as Record<string, unknown>).listFiles = vi.fn(async () => ({
      success: true,
      files: [
        { name: "app", type: "directory" },
        { name: "stale.txt", type: "file" },
      ],
    }));
    (fileStore as Record<string, unknown>).deleteFile = vi.fn(async () => ({ success: true }));

    const result = await migrateVmProject(deps, project, { force: true });

    expect(result.status).toBe("migrated");
    expect(result.liftedRoot).toBe("app");
    const deleteMock = (fileStore as { deleteFile: ReturnType<typeof vi.fn> }).deleteFile;
    expect(deleteMock).toHaveBeenCalledWith("/app", { recursive: true, force: true });
    expect(deleteMock).toHaveBeenCalledWith("/stale.txt", { recursive: true, force: true });
    expect(deleteMock).not.toHaveBeenCalledWith("/", expect.anything());
    expect(writes.map((write) => write.path)).toEqual(["/package.json"]);
  });
});
