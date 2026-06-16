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

  it("sniffs workspace binary image bytes even when mime type and extension are missing", async () => {
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01,
      0x00, 0x00, 0x00, 0x01,
    ]);
    const readFile = vi.fn(async () => ({
      success: true,
      content: Buffer.from(pngBytes).toString("base64"),
      size: pngBytes.byteLength,
      isBinary: true,
    }));
    const output = vi.fn(async () => ({
      contentType: () => "image/png",
      image: () => new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("optimized-base64"));
          controller.close();
        },
      }),
    }));
    const transform = vi.fn(() => ({ output }));
    const images = { input: vi.fn(() => ({ transform, output })) };
    const workspace = { readFile } as unknown as WorkspaceFilesystemLike;
    const tools = new PiContainerTools(workspace, { images: images as never });

    const result = await tools.callTool("read", { path: "/workspace/blob" });

    expect(result.text).toContain("Read image file [image/png]");
    expect(result.content).toEqual([
      { type: "text", text: result.text },
      { type: "image", data: "optimized-base64", mimeType: "image/png" },
    ]);
    expect(result.details).toMatchObject({
      image: true,
      inlineImage: true,
      originalMimeType: "image/png",
      maxInlineDimension: 2000,
    });
  });
});
