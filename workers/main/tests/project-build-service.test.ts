import { describe, expect, it, vi } from "vitest";

import { projectBuildSandboxKey, runProjectAddDependency, runProjectBuild } from "../src/project-build-service";
import type { ProjectBuildSandboxLike } from "../src/project-worker-bundle";
import type { WorkspaceFileStoreLike, WorkspaceListEntry } from "../src/workspace-filesystem-do";

function fakeFileStore(files: Record<string, string>): WorkspaceFileStoreLike {
  const entries: WorkspaceListEntry[] = Object.entries(files).map(([path, content]) => {
    const absolutePath = path.startsWith("/") ? path : `/${path}`;
    return {
      name: absolutePath.split("/").filter(Boolean).pop() || "",
      type: "file",
      size: content.length,
      modifiedAt: new Date(0).toISOString(),
      relativePath: absolutePath.replace(/^\/+/, ""),
      absolutePath,
    };
  });
  return {
    exists: vi.fn(async () => ({ exists: true })),
    readFile: vi.fn(async (path: string) => {
      const content = files[path] ?? files[path.replace(/^\/+/, "")];
      return content == null
        ? { success: false, error: "File not found" }
        : { success: true, content, encoding: "utf8" as const, isBinary: false, size: content.length };
    }),
    readFileStream: vi.fn(async () => ({ success: false })),
    writeFile: vi.fn(async () => ({ success: true })),
    writeBinaryFile: vi.fn(async () => ({ success: true })),
    listFiles: vi.fn(async () => ({ success: true, files: entries, count: entries.length, path: "/" })),
    mkdir: vi.fn(async () => ({ success: true })),
    deleteFile: vi.fn(async () => ({ success: true })),
  };
}

function fakeSandbox(): ProjectBuildSandboxLike & {
  exec: ReturnType<typeof vi.fn>;
  mkdir: ReturnType<typeof vi.fn>;
  writeFile: ReturnType<typeof vi.fn>;
} {
  return {
    exec: vi.fn(async (command: string) => command.includes("bun run build")
      ? { success: true, stdout: "built", stderr: "", exitCode: 0 }
      : { success: true, stdout: "", stderr: "", exitCode: 0 }),
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
  };
}

describe("runProjectBuild", () => {
  it("materializes source-only files and runs the fixed build pipeline", async () => {
    const files = fakeFileStore({
      "/package.json": JSON.stringify({ scripts: { build: "vite build" } }),
      "/src/index.ts": "export default {};",
      "/node_modules/pkg/index.js": "ignored",
      "/build/server/index.js": "ignored",
      "/.git/config": "ignored",
    });
    const sandbox = fakeSandbox();

    const result = await runProjectBuild({
      projectId: "Demo_Project",
      files,
      sandbox,
      timeoutMs: 15_000,
    });

    expect(result).toMatchObject({
      success: true,
      projectId: "demo-project",
      workdir: "/workspace/demo-project",
      stdout: "built",
      exitCode: 0,
      fileCount: 2,
    });
    expect(sandbox.mkdir).toHaveBeenCalledWith("/workspace/demo-project", { recursive: true });
    expect(sandbox.exec).toHaveBeenCalledWith(expect.stringContaining("rm -rf"), { cwd: "/workspace" });
    expect(sandbox.exec).toHaveBeenCalledWith("bun install && bun run build", {
      cwd: "/workspace/demo-project",
      timeoutMs: 15_000,
      env: {
        CI: "1",
        WRANGLER_SEND_METRICS: "false",
        CAMELAI_PROJECT_ID: "demo-project",
        CAMELAI_BUILD_TIMEOUT_MS: "15000",
      },
    });
    expect(sandbox.writeFile).toHaveBeenCalledTimes(2);
    expect(sandbox.writeFile.mock.calls.map((call) => call[0])).toEqual([
      "/workspace/demo-project/package.json",
      "/workspace/demo-project/src/index.ts",
    ]);
    expect(sandbox.mkdir).toHaveBeenCalledWith("/workspace/demo-project/src", { recursive: true });
  });

  it("returns structured failures from the build command", async () => {
    const files = fakeFileStore({ "/package.json": JSON.stringify({ scripts: { build: "vite build" } }) });
    const sandbox = fakeSandbox();
    sandbox.exec.mockResolvedValueOnce({ success: true, exitCode: 0, stdout: "", stderr: "" });
    sandbox.exec.mockResolvedValueOnce({ success: false, exitCode: 1, stdout: "", stderr: "missing build" });

    await expect(runProjectBuild({ projectId: "demo", files, sandbox })).resolves.toMatchObject({
      success: false,
      exitCode: 1,
      error: "missing build",
    });
  });

  it("fails fast when package.json has no build script", async () => {
    const files = fakeFileStore({ "/package.json": "{}" });
    const sandbox = fakeSandbox();

    await expect(runProjectBuild({ projectId: "demo", files, sandbox })).resolves.toMatchObject({
      success: false,
      exitCode: 1,
      lockfilePersisted: false,
      error: expect.stringContaining("Project package.json must define scripts.build"),
    });
    expect(sandbox.mkdir).not.toHaveBeenCalled();
    expect(sandbox.exec).not.toHaveBeenCalled();
  });

  it("persists bun.lock back to the project file store after a successful build", async () => {
    const files = fakeFileStore({
      "/package.json": JSON.stringify({ scripts: { build: "vite build" } }),
    });
    const sandbox = {
      ...fakeSandbox(),
      readFile: vi.fn(async () => ({ content: Buffer.from("# lockfile\n").toString("base64") })),
    };

    await expect(runProjectBuild({ projectId: "demo", files, sandbox })).resolves.toMatchObject({
      success: true,
      lockfilePersisted: true,
    });
    expect(files.writeFile).toHaveBeenCalledWith("/bun.lock", "# lockfile\n");
    expect(sandbox.readFile).toHaveBeenCalledWith("/workspace/demo/bun.lock", { encoding: "base64" });
  });
});

describe("runProjectAddDependency", () => {
  it("runs a fixed bun add command and persists package.json plus bun.lock", async () => {
    const files = fakeFileStore({
      "/package.json": JSON.stringify({ scripts: { build: "vite build" } }),
      "/src/index.ts": "export default {};",
    });
    const updatedPackageJson = JSON.stringify({
      scripts: { build: "vite build" },
      devDependencies: { "@types/node": "^22" },
    }, null, 2);
    const sandbox = {
      ...fakeSandbox(),
      readFile: vi.fn(async (path: string) => {
        if (path.endsWith("/package.json")) return { content: Buffer.from(updatedPackageJson).toString("base64") };
        if (path.endsWith("/bun.lock")) return { content: Buffer.from("# lockfile\n").toString("base64") };
        throw new Error(`missing ${path}`);
      }),
    };

    const result = await runProjectAddDependency({
      projectId: "Demo_Project",
      files,
      sandbox,
      dependency: "@types/node@^22",
      dev: true,
    });

    expect(result).toMatchObject({
      success: true,
      projectId: "demo-project",
      dependency: "@types/node@^22",
      dev: true,
      packageJsonPersisted: true,
      lockfilePersisted: true,
      fileCount: 2,
    });
    expect(sandbox.exec).toHaveBeenCalledWith("bun add -d '@types/node@^22'", {
      cwd: "/workspace/demo-project",
      timeoutMs: 120_000,
      env: {
        CI: "1",
        WRANGLER_SEND_METRICS: "false",
        CAMELAI_PROJECT_ID: "demo-project",
      },
    });
    expect(files.writeFile).toHaveBeenCalledWith("/package.json", updatedPackageJson);
    expect(files.writeFile).toHaveBeenCalledWith("/bun.lock", "# lockfile\n");
  });

  it("returns structured failures from bun add", async () => {
    const files = fakeFileStore({ "/package.json": "{}" });
    const sandbox = fakeSandbox();
    sandbox.exec.mockResolvedValueOnce({ success: true, exitCode: 0, stdout: "", stderr: "" });
    sandbox.exec.mockResolvedValueOnce({ success: false, exitCode: 1, stdout: "", stderr: "not found" });

    await expect(runProjectAddDependency({
      projectId: "demo",
      files,
      sandbox,
      dependency: "missing-package",
    })).resolves.toMatchObject({
      success: false,
      exitCode: 1,
      error: "not found",
      packageJsonPersisted: false,
      lockfilePersisted: false,
    });
    expect(files.writeFile).not.toHaveBeenCalled();
  });

  it("rejects non-registry or shell-like dependency specs", async () => {
    const files = fakeFileStore({ "/package.json": "{}" });
    const sandbox = fakeSandbox();

    await expect(runProjectAddDependency({
      projectId: "demo",
      files,
      sandbox,
      dependency: "react;rm-rf",
    })).rejects.toThrow("dependency must be an npm package spec");
    await expect(runProjectAddDependency({
      projectId: "demo",
      files,
      sandbox,
      dependency: "file:../local",
    })).rejects.toThrow("dependency must be an npm registry package spec");
    expect(sandbox.exec).not.toHaveBeenCalled();
  });
});

describe("projectBuildSandboxKey", () => {
  it("isolates build sandboxes by org and project", () => {
    expect(projectBuildSandboxKey("Org A", "Demo_Project")).toBe("org-a-demo-project");
    expect(projectBuildSandboxKey("Org B", "Demo_Project")).toBe("org-b-demo-project");
  });

  it("keeps long org/project sandbox keys within the Cloudflare container id limit", () => {
    const key = projectBuildSandboxKey(
      "local-dev-org",
      "ca-ded88355a4284af7bb641b8729105ca8-deploy-test-2-193q",
    );

    expect(key.length).toBeLessThanOrEqual(63);
    expect(key).toMatch(/^local-dev-org-ca-ded88355a4284af7bb641b8729105ca8-[a-z0-9-]*[a-f0-9]{8}$/);
    expect(projectBuildSandboxKey(
      "local-dev-org",
      "ca-ded88355a4284af7bb641b8729105ca8-deploy-test-2-other",
    )).not.toBe(key);
  });
});
