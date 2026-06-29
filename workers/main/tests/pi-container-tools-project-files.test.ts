import { describe, expect, it, vi } from "vitest";

import { PiContainerTools } from "../src/pi-container-tools";
import type { WorkspaceFileStoreLike, WorkspaceListEntry } from "../src/workspace-filesystem-do";

function fakeFileStore(files: Record<string, string>): WorkspaceFileStoreLike {
  const normalized = new Map(Object.entries(files).map(([path, content]) => [path.startsWith("/") ? path : `/${path}`, content]));
  return {
    exists: vi.fn(async (path: string) => ({
      exists: normalized.has(path),
      isFile: normalized.has(path),
      isDirectory: false,
      size: normalized.get(path)?.length,
    })),
    readFile: vi.fn(async (path: string) => {
      const content = normalized.get(path);
      return content == null
        ? { success: false, error: "File not found", code: "ENOENT" }
        : { success: true, content, encoding: "utf8" as const, isBinary: false, size: content.length };
    }),
    readFileStream: vi.fn(async () => ({ success: false, error: "not implemented" })),
    writeFile: vi.fn(async (path: string, content: string) => {
      normalized.set(path, content);
      return { success: true };
    }),
    writeBinaryFile: vi.fn(async () => ({ success: true })),
    listFiles: vi.fn(async (path: string) => {
      const root = path.replace(/\/+$/g, "") || "/";
      const entries: WorkspaceListEntry[] = [];
      for (const [absolutePath, content] of normalized.entries()) {
        if (root !== "/" && absolutePath !== root && !absolutePath.startsWith(`${root}/`)) continue;
        entries.push({
          name: absolutePath.split("/").filter(Boolean).pop() || "",
          type: "file",
          size: content.length,
          modifiedAt: new Date(0).toISOString(),
          relativePath: root === "/" ? absolutePath.replace(/^\/+/, "") : absolutePath.slice(root.length + 1),
          absolutePath,
        });
      }
      return { success: true, files: entries, count: entries.length, path: root };
    }),
    mkdir: vi.fn(async () => ({ success: true })),
    deleteFile: vi.fn(async (path: string) => {
      normalized.delete(path);
      return { success: true };
    }),
  };
}

describe("PiContainerTools with a project file store", () => {
  it("writes empty DO-backed project files without parsing or transform errors", async () => {
    const store = fakeFileStore({});
    const tools = new PiContainerTools(store);

    await expect(tools.callTool("write", {
      location: "project",
      project: "demo",
      path: "/public/.gitkeep",
      content: "",
    })).resolves.toMatchObject({ text: "Successfully wrote 0 bytes to /public/.gitkeep" });
    expect(store.writeFile).toHaveBeenCalledWith("/public/.gitkeep", "");
  });

  it("searches, finds, and deletes DO-backed project files", async () => {
    const store = fakeFileStore({
      "/src/index.ts": "export const greeting = 'hello project';\n",
      "/README.md": "hello docs\n",
    });
    const tools = new PiContainerTools(store);

    await expect(tools.callTool("grep", {
      location: "project",
      project: "demo",
      path: "/",
      pattern: "hello project",
      literal: true,
    })).resolves.toMatchObject({ text: "src/index.ts:1: export const greeting = 'hello project';" });

    await expect(tools.callTool("find", {
      location: "project",
      project: "demo",
      path: "/",
      pattern: "**/*.ts",
    })).resolves.toMatchObject({ text: "src/index.ts" });

    await expect(tools.callTool("delete", {
      location: "project",
      project: "demo",
      path: "/README.md",
    })).resolves.toMatchObject({ details: { path: "/README.md", deleted: true } });

    expect(store.deleteFile).toHaveBeenCalledWith("/README.md", { recursive: false, force: false });
  });
});
