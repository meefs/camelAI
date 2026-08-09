import { describe, expect, it, vi } from "vitest";

import {
  CODE_MODE_PI_PASSTHROUGH_TOOL_DEFINITIONS,
  CODE_MODE_TOOL_DEFINITIONS,
  CodeModeToolsBinding,
} from "../src/code-mode-tools";
import { createPiSystemPrompt } from "../src/pi-system-prompt";

describe("archive tool discovery", () => {
  it("advertises inspect and extract as top-level analysis tools", () => {
    for (const name of ["inspect_archive", "extract_archive"]) {
      const definition = CODE_MODE_TOOL_DEFINITIONS.find((tool) => tool.name === name);
      const passthrough = CODE_MODE_PI_PASSTHROUGH_TOOL_DEFINITIONS.find(
        (tool) => tool.name === name,
      );
      expect(definition).toMatchObject({ name, category: "analysis" });
      expect(passthrough).toMatchObject({ name, category: "analysis" });
    }
  });

  it("maps an upload reference to the read-only sandbox mount for inspection", async () => {
    const exec = vi.fn(async () => ({
      ok: true,
      stdout: JSON.stringify({ ok: true, action: "read", entry: "package.json" }),
      stderr: "",
      durationMs: 5,
      changedFiles: [],
      removedFiles: [],
      skippedOversize: [],
    }));
    const binding = Object.create(CodeModeToolsBinding.prototype) as Record<string, unknown>;
    binding.ctx = { props: { orgId: "org-1", workspaceId: "workspace-1" } };
    binding.analysisService = () => ({ exec });
    const methods = CodeModeToolsBinding.prototype as unknown as {
      inspectArchive(this: unknown, args: Record<string, unknown>): Promise<Record<string, unknown>>;
    };

    await expect(methods.inspectArchive.call(binding, {
      path: "uploads/source.zip",
      entry: "package.json",
    })).resolves.toMatchObject({
      ok: true,
      action: "read",
      path: "uploads/source.zip",
      entry: "package.json",
      durationMs: 5,
    });
    expect(exec).toHaveBeenCalledWith({
      command: "python /usr/local/bin/camelai-archive",
      env: {
        CAMELAI_ARCHIVE_ACTION: "read",
        CAMELAI_ARCHIVE_PATH: "/uploads/source.zip",
        CAMELAI_ARCHIVE_ENTRY: "package.json",
      },
    });
  });

  it("extracts through a project-scoped analysis run and validates the destination", async () => {
    const exec = vi.fn(async () => ({
      ok: true,
      stdout: JSON.stringify({ ok: true, action: "extract", destination: "src" }),
      stderr: "",
      durationMs: 7,
      changedFiles: ["src/index.ts"],
      removedFiles: [],
      skippedOversize: [],
    }));
    const binding = Object.create(CodeModeToolsBinding.prototype) as Record<string, unknown>;
    binding.ctx = { props: { orgId: "org-1", workspaceId: "workspace-1" } };
    binding.analysisService = () => ({ exec });
    binding.resolveDoBackedProjectForAction = async () => ({ id: "project-id", name: "website" });
    const methods = CodeModeToolsBinding.prototype as unknown as {
      extractArchive(this: unknown, args: Record<string, unknown>): Promise<Record<string, unknown>>;
    };

    await expect(methods.extractArchive.call(binding, {
      path: "uploads/source.zip",
      project: "website",
      destination: "src",
    })).resolves.toMatchObject({
      ok: true,
      action: "extract",
      path: "uploads/source.zip",
      project: "website",
      changedFiles: ["src/index.ts"],
    });
    expect(exec).toHaveBeenCalledWith({
      projectId: "project-id",
      command: "python /usr/local/bin/camelai-archive",
      env: {
        CAMELAI_ARCHIVE_ACTION: "extract",
        CAMELAI_ARCHIVE_PATH: "/uploads/source.zip",
        CAMELAI_ARCHIVE_DESTINATION: "src",
      },
    });
    await expect(methods.extractArchive.call(binding, {
      path: "uploads/source.zip",
      project: "website",
      destination: "../outside",
    })).rejects.toThrow("archive destination must not contain '..'");
  });

  it("tells the agent to inspect ZIP contents before safe extraction", () => {
    const prompt = createPiSystemPrompt(
      { threadId: "thread-1", workspaceId: "workspace-1", orgId: "org-1" },
      { skillNames: [] },
    );
    expect(prompt).toContain("use `inspect_archive` to list entries");
    expect(prompt).toContain("then `extract_archive`");
    expect(prompt).toContain("do not read a ZIP as text");
  });
});
