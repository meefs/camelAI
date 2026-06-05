import { describe, expect, it, vi } from "vitest";
import { PiContainerTools } from "../src/pi-container-tools";
import type { WorkspaceFilesystemLike } from "../src/workspace-filesystem-do";

describe("PiContainerTools", () => {
  it("writes files through the workspace filesystem", async () => {
    const writeFile = vi.fn(async () => ({ success: true }));
    const workspace = { writeFile } as unknown as WorkspaceFilesystemLike;
    const tools = new PiContainerTools(workspace);

    const result = await tools.callTool("write", {
      path: "/tmp/example.txt",
      content: "hello from container",
    });

    expect(result.text).toBe("Successfully wrote 20 bytes to /tmp/example.txt");
    expect(writeFile).toHaveBeenCalledWith("/tmp/example.txt", "hello from container");
  });

  it("reads files through the workspace filesystem", async () => {
    const readFile = vi.fn(async () => ({
      success: true,
      content: "hello",
      size: 5,
      isBinary: false,
      mimeType: "text/plain",
    }));
    const workspace = { readFile } as unknown as WorkspaceFilesystemLike;
    const tools = new PiContainerTools(workspace);

    const result = await tools.callTool("read", { path: "notes.txt" });

    expect(result.text).toBe("hello");
    expect(readFile).toHaveBeenCalledWith("/workspace/notes.txt");
  });
});
