import { describe, expect, it, vi } from "vitest";

import {
  collectProjectSourceFiles,
  materializeProjectSourceFiles,
  shellQuote,
  validateDoSqliteApiUsage,
  validatePackageJson,
  validatePackageJsonBuildScript,
  type ProjectSourceFile,
} from "../src/project-build-source";
import type { ProjectBuildSandboxLike } from "../src/project-worker-bundle";
import type {
  WorkspaceFileStoreLike,
  WorkspaceListEntry,
} from "../src/workspace-filesystem-do";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function sourceFile(path: string, content: string, sha256 = SHA_A): ProjectSourceFile {
  return { path, bytes: new TextEncoder().encode(content), sha256 };
}

function fakeFiles(contents: Record<string, { content: string; encoding?: "utf8" | "base64" }>): WorkspaceFileStoreLike {
  const entries: WorkspaceListEntry[] = Object.keys(contents).map((path) => ({
    name: path.split("/").at(-1) ?? path,
    type: "file",
    size: contents[path]!.content.length,
    modifiedAt: new Date(0).toISOString(),
    relativePath: path.replace(/^\/+/, ""),
    absolutePath: path.startsWith("/") ? path : `/${path}`,
  }));
  return {
    exists: vi.fn(async () => ({ exists: true })),
    readFile: vi.fn(async (path: string) => {
      const value = contents[path] ?? contents[path.replace(/^\/+/, "")];
      return value
        ? { success: true, content: value.content, encoding: value.encoding ?? "utf8" }
        : { success: false, error: "missing" };
    }),
    readFileStream: vi.fn(async () => ({ success: false })),
    writeFile: vi.fn(async () => ({ success: true })),
    writeBinaryFile: vi.fn(async () => ({ success: true })),
    listFiles: vi.fn(async () => ({ success: true, files: entries, count: entries.length, path: "/" })),
    mkdir: vi.fn(async () => ({ success: true })),
    deleteFile: vi.fn(async () => ({ success: true })),
  };
}

describe("project build source owner", () => {
  it("collects, decodes, hashes, sorts, and excludes generated source trees", async () => {
    const files = fakeFiles({
      "/src/z.ts": { content: "z" },
      "/src/a.bin": { content: "AAEC", encoding: "base64" },
      "/package.json": { content: "{}" },
      "/node_modules/pkg/index.js": { content: "ignored" },
      "/.camelai/tmp/build.log": { content: "ignored" },
      "/build/output.js": { content: "ignored" },
    });

    const collected = await collectProjectSourceFiles(files);

    expect(collected.files.map((file) => file.path)).toEqual([
      "package.json",
      "src/a.bin",
      "src/z.ts",
    ]);
    expect(collected.files.find((file) => file.path === "src/a.bin")?.bytes)
      .toEqual(new Uint8Array([0, 1, 2]));
    expect(collected.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
    expect(collected.totalBytes).toBe(6);
  });

  it("owns package and Durable Object SQLite source admission", () => {
    const packageJson = sourceFile("package.json", JSON.stringify({ scripts: { build: "vite build" } }));
    expect(validatePackageJson([packageJson])).toBeNull();
    expect(validatePackageJsonBuildScript([packageJson])).toBeNull();
    expect(validatePackageJsonBuildScript([sourceFile("package.json", "{}")]))
      .toContain("must define scripts.build");
    expect(validateDoSqliteApiUsage([
      sourceFile("src/tasks.ts", [
        "function list() {",
        '  return this.ctx.storage.sql.prepare("SELECT 1").all();',
        "}",
      ].join("\n")),
    ])).toContain("src/tasks.ts:2 calls .prepare()");
    expect(validateDoSqliteApiUsage([
      sourceFile("src/tasks.ts", 'this.ctx.storage.sql.exec("SELECT 1").toArray();'),
      sourceFile("src/mysql.ts", "mysql.prepare(query);"),
    ])).toBeNull();
  });

  it("materializes only changed files against the persisted source manifest", async () => {
    const previousManifest = {
      schemaVersion: 1,
      files: [
        { path: "package.json", size: 2, sha256: SHA_A },
        { path: "src/removed.ts", size: 3, sha256: SHA_A },
      ],
    };
    const sandbox = {
      mkdir: vi.fn(async () => undefined),
      exists: vi.fn(async () => ({ exists: true })),
      readFile: vi.fn(async () => ({
        content: Buffer.from(JSON.stringify(previousManifest)).toString("base64"),
      })),
      writeFile: vi.fn(async () => undefined),
      exec: vi.fn(async () => ({ success: true, stdout: "", stderr: "", exitCode: 0 })),
    } as unknown as ProjectBuildSandboxLike & {
      writeFile: ReturnType<typeof vi.fn>;
      exec: ReturnType<typeof vi.fn>;
    };

    const timings = await materializeProjectSourceFiles(sandbox, "/workspace/demo", [
      sourceFile("package.json", "{}", SHA_A),
      sourceFile("src/new.ts", "new", SHA_B),
    ]);

    expect(sandbox.writeFile).toHaveBeenCalledTimes(2);
    expect(sandbox.writeFile.mock.calls.map((call) => call[0])).toEqual([
      "/workspace/demo.source.tar",
      "/workspace/demo.next-source-manifest.json",
    ]);
    expect(sandbox.exec).toHaveBeenCalledWith(expect.any(String), { cwd: "/workspace" });
    const command = sandbox.exec.mock.calls[0]?.[0] as string;
    expect(command).toContain("CAMELAI_FORCE_CLEAN=0");
    expect(command).toContain("tar -xf '/workspace/demo.source.tar'");
    expect(timings).toEqual(expect.objectContaining({
      materializeMs: expect.any(Number),
      archiveCreateMs: expect.any(Number),
      materializeExecMs: expect.any(Number),
    }));
  });

  it("quotes shell values without exposing a second command", () => {
    expect(shellQuote("@scope/pkg@^1")).toBe("'@scope/pkg@^1'");
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
  });
});
