import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";

import {
  __testing,
  ProjectFilesystemClient,
  WorkspaceFilesystemClient,
} from "../src/workspace-filesystem-do";

function namespaceFor(stub: Record<string, unknown>) {
  return {
    idFromName: vi.fn((name: string) => `id:${name}`),
    get: vi.fn(() => stub),
  };
}

describe("ProjectFilesystemClient", () => {
  it("uses project-scoped DO instances and project file RPC methods", async () => {
    const stub = {
      projectWriteFile: vi.fn(async () => ({ success: true })),
      projectReadFile: vi.fn(async () => ({ success: true, content: "hello", encoding: "utf8" })),
      projectListFiles: vi.fn(async () => ({ success: true, files: [], count: 0, path: "/" })),
      projectCreateSourceSnapshot: vi.fn(async () => ({ id: "snapshot-1", createdAt: "2026-01-01T00:00:00.000Z", fileCount: 1, totalBytes: 5, entries: [] })),
      projectRestoreSourceSnapshot: vi.fn(async () => ({ id: "snapshot-1", createdAt: "2026-01-01T00:00:00.000Z", fileCount: 1, totalBytes: 5, entries: [] })),
      projectListSourceSnapshots: vi.fn(async () => []),
    };
    const workspaces = namespaceFor(stub);
    const client = new ProjectFilesystemClient(
      { WORKSPACE_FS: workspaces } as never,
      "CA_AAAAAAAA-AAAAAAAA-AAAAAAAA-AAAAAAAA-demo app",
    );

    await expect(client.writeFile("/src/index.ts", "hello")).resolves.toEqual({ success: true });
    await expect(client.readFile("/src/index.ts")).resolves.toMatchObject({ content: "hello" });
    await client.listFiles("/", { recursive: true });
    await expect(client.createSourceSnapshot({ message: "deploy" })).resolves.toMatchObject({ id: "snapshot-1" });
    await expect(client.restoreSourceSnapshot("snapshot-1")).resolves.toMatchObject({ id: "snapshot-1" });
    await client.listSourceSnapshots(5);

    expect(workspaces.idFromName).toHaveBeenCalledWith("ca-aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa-demo-app");
    expect(stub.projectWriteFile).toHaveBeenCalledWith("/src/index.ts", "hello");
    expect(stub.projectReadFile).toHaveBeenCalledWith("/src/index.ts");
    expect(stub.projectListFiles).toHaveBeenCalledWith("/", { recursive: true });
    expect(stub.projectCreateSourceSnapshot).toHaveBeenCalledWith({ message: "deploy" });
    expect(stub.projectRestoreSourceSnapshot).toHaveBeenCalledWith("snapshot-1");
    expect(stub.projectListSourceSnapshots).toHaveBeenCalledWith(5);
    expect(stub).not.toHaveProperty("writeFile.mock");
  });

  it("keeps the workspace client on workspace-scoped file RPC methods", async () => {
    const stub = {
      writeFile: vi.fn(async () => ({ success: true })),
      readFile: vi.fn(async () => ({ success: true, content: "workspace", encoding: "utf8" })),
      createProject: vi.fn(async () => ({ id: "project-1", name: "demo", description: "Demo", defaultVmId: "main", backend: "do-r2" })),
      setProjectBackend: vi.fn(async () => ({ id: "project-1", name: "demo", description: "Demo", defaultVmId: "main", backend: "do-r2" })),
    };
    const workspaces = namespaceFor(stub);
    const client = new WorkspaceFilesystemClient({ WORKSPACE_FS: workspaces } as never, "workspace-1");

    await client.writeFile("/notes.md", "workspace");
    await expect(client.readFile("/notes.md")).resolves.toMatchObject({ content: "workspace" });

    expect(workspaces.idFromName).toHaveBeenCalledWith("workspace-1");
    expect(stub.writeFile).toHaveBeenCalledWith("/notes.md", "workspace");
    expect(stub.readFile).toHaveBeenCalledWith("/notes.md");
    expect(stub).not.toHaveProperty("projectWriteFile.mock");

    await expect(client.createProject({ name: "demo", description: "Demo", backend: "do-r2" })).resolves.toMatchObject({ backend: "do-r2" });
    expect(stub.createProject).toHaveBeenCalledWith({ name: "demo", description: "Demo", backend: "do-r2", workspaceId: "workspace-1" });

    await expect(client.setProjectBackend({ project: "demo", backend: "do-r2" })).resolves.toMatchObject({ backend: "do-r2" });
    expect(stub.setProjectBackend).toHaveBeenCalledWith({ project: "demo", backend: "do-r2" });
  });

  it("uses a distinct R2 prefix for project source blobs", () => {
    expect(__testing.fileStoreR2Prefix("workspace", "do-123")).toBe("workspace-fs/do-123");
    expect(__testing.fileStoreR2Prefix("project", "do-123")).toBe("project-fs/do-123");
  });

  it("recognizes local unavailable Artifacts bindings", () => {
    expect(__testing.isArtifactsBindingUnavailableError("Binding ARTIFACTS needs to be run remotely")).toBe(true);
    expect(__testing.isArtifactsBindingUnavailableError("network timeout")).toBe(false);
  });

  it("creates deterministic project source snapshots from real DO-backed files", async () => {
    const client = new ProjectFilesystemClient(env as never, `project-${crypto.randomUUID()}`);
    await expect(client.writeFile("/package.json", JSON.stringify({ scripts: { build: "vite build" } }))).resolves.toEqual({ success: true });
    await expect(client.writeFile("/src/index.ts", "export const value = 1;\n")).resolves.toEqual({ success: true });
    await expect(client.writeFile("/node_modules/ignored.js", "ignored\n")).resolves.toEqual({ success: true });

    const first = await client.createSourceSnapshot({ message: "deploy" });
    const second = await client.createSourceSnapshot({ message: "deploy again" });

    expect(first.id).toMatch(/^[a-f0-9]{64}$/);
    expect(second.id).toBe(first.id);
    expect(first.message).toBe("deploy");
    expect(first.fileCount).toBe(2);
    expect(first.entries.map((entry) => entry.path)).toEqual(["package.json", "src/index.ts"]);
    expect(first.entries.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256))).toBe(true);
    expect(first.entries.every((entry) => entry.blobKey.startsWith("project-source-snapshots/"))).toBe(true);
    await expect(client.listSourceSnapshots(10)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.id, fileCount: 2 }),
    ]));

    await expect(client.writeFile("/src/index.ts", "export const value = 2;\n")).resolves.toEqual({ success: true });
    await expect(client.writeFile("/src/extra.ts", "export const extra = true;\n")).resolves.toEqual({ success: true });
    await expect(client.restoreSourceSnapshot(first.id)).resolves.toMatchObject({ id: first.id, fileCount: 2 });
    await expect(client.readFile("/src/index.ts")).resolves.toMatchObject({ content: "export const value = 1;\n" });
    await expect(client.readFile("/src/extra.ts")).resolves.toMatchObject({ success: false, code: "ENOENT" });
  });
});
