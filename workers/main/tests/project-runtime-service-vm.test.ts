import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectRuntimeServiceVmBridge } from "../src/project-runtime-service-vm";
import { inlineImageMaxBase64Chars } from "../src/image-tool-content";

describe("ProjectRuntimeServiceVmBridge", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("executes user commands from /workspace by default", async () => {
    const project = {
      id: "ca-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-web-app",
      name: "web-app",
      description: "Web app.",
      defaultVmId: "main",
      artifactRemote: "https://artifacts.camelai.internal/git/web-app.git",
      artifactStatus: "ready",
      artifactDefaultBranch: "main",
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:00.000Z",
    };
    const fetchMock = vi.fn(async () =>
      Response.json({
        success: true,
        stdout: "",
        stderr: "",
        exitCode: 0,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const bridge = new ProjectRuntimeServiceVmBridge({
      env: {
        PROJECT_RUNTIME_SERVICE_URL: "http://runtime.test",
      },
      workspace: {
        getProjectByName: vi.fn(async (name: string) =>
          name === "web-app" ? project : null
        ),
      } as never,
    });

    await bridge.exec({ project: "web-app", command: "pwd" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const userExecBody = JSON.parse(
      String(fetchMock.mock.calls[1]![1]!.body),
    );
    expect(userExecBody).toMatchObject({
      cmd: ["bash", "-lc", "pwd"],
      cwd: "/workspace",
      env: {
        CAMELAI_CONNECTIONS_RPC_URL: "http://host.docker.internal:8089/p/camelai-connections-rpc/rpc/connections",
      },
    });
  });

  it("does not prepare Git checkout for VM source transfer reads", async () => {
    const project = {
      id: "ca-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-web-app",
      name: "web-app",
      description: "Web app.",
      defaultVmId: "main",
      artifactRemote: "https://artifacts.camelai.internal/git/web-app.git",
      artifactStatus: "ready",
      artifactDefaultBranch: "main",
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:00.000Z",
    };
    const bytes = new TextEncoder().encode("artifact");
    const fetchMock = vi.fn(async () => new Response(bytes, {
      headers: { "content-type": "text/plain" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const bridge = new ProjectRuntimeServiceVmBridge({
      env: {
        PROJECT_RUNTIME_SERVICE_URL: "http://runtime.test",
      },
      workspace: {
        getProjectByName: vi.fn(async (name: string) =>
          name === "web-app" ? project : null
        ),
      } as never,
    });

    const result = await bridge.readFileBytesForTransfer({ project: "web-app", path: "/workspace/out.txt" });

    expect(new TextDecoder().decode(result.bytes)).toBe("artifact");
    expect(result.contentType).toBe("text/plain");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.pathname).toBe("/v1/projects/ca-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-web-app/fs/read");
    expect(url.searchParams.get("path")).toBe("/workspace/out.txt");
  });

  it("returns project VM images as image tool content", async () => {
    const project = {
      id: "ca-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-web-app",
      name: "web-app",
      description: "Web app.",
      defaultVmId: "main",
      artifactRemote: "https://artifacts.camelai.internal/git/web-app.git",
      artifactStatus: "ready",
      artifactDefaultBranch: "main",
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:00.000Z",
    };
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01,
      0x00, 0x00, 0x00, 0x01,
    ]);
    const imageResponse = new Response(pngBytes, {
      headers: { "content-length": String(pngBytes.byteLength) },
    });
    const arrayBuffer = vi.spyOn(imageResponse, "arrayBuffer");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(imageResponse);
    vi.stubGlobal("fetch", fetchMock);
    const output = vi.fn(async () => ({
      contentType: () => "image/png",
      image: () => new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("transformed-base64"));
          controller.close();
        },
      }),
    }));
    const transform = vi.fn(() => ({ output }));
    const images = {
      info: vi.fn(async () => ({ format: "image/png", fileSize: pngBytes.byteLength, width: 1, height: 1 })),
      input: vi.fn(() => ({
        transform,
        output,
      })),
    };

    const bridge = new ProjectRuntimeServiceVmBridge({
      env: {
        PROJECT_RUNTIME_SERVICE_URL: "http://runtime.test",
        IMAGES: images,
      } as never,
      workspace: {
        getProjectByName: vi.fn(async (name: string) =>
          name === "web-app" ? project : null
        ),
      } as never,
    });

    const result = await bridge.read({ project: "web-app", path: "/workspace/chart.png" }) as any;

    expect(result.text).toContain("Read image file [image/png]");
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(images.info).not.toHaveBeenCalled();
    expect(images.input).toHaveBeenCalled();
    expect(transform).toHaveBeenCalledWith({ width: 2000, height: 2000, fit: "scale-down" });
    expect(output).toHaveBeenCalledWith({ format: "image/png", quality: 80, anim: false });
    expect(result.content).toEqual([
      { type: "text", text: result.text },
      { type: "image", data: "transformed-base64", mimeType: "image/png" },
    ]);
    expect(result.text).toContain("optimized for inline model context");
    expect(result.details).toMatchObject({
      provider: "project-runtime-service",
      path: "/workspace/chart.png",
      image: true,
      mimeType: "image/png",
      inlineImage: true,
      optimizedForInlineView: true,
      maxInlineDimension: 2000,
      usedImagesBinding: true,
    });
  });

  it("retries VM image optimization at a smaller size when transformed base64 exceeds the inline cap", async () => {
    const project = {
      id: "ca-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-web-app",
      name: "web-app",
      description: "Web app.",
      defaultVmId: "main",
      artifactRemote: "https://artifacts.camelai.internal/git/web-app.git",
      artifactStatus: "ready",
      artifactDefaultBranch: "main",
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:00.000Z",
    };
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01,
      0x00, 0x00, 0x00, 0x01,
    ]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(pngBytes, {
        headers: { "content-length": String(pngBytes.byteLength) },
      }))
      .mockResolvedValueOnce(new Response(pngBytes, {
        headers: { "content-length": String(pngBytes.byteLength) },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const output = vi
      .fn()
      .mockResolvedValueOnce({
        contentType: () => "image/png",
        image: () => new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("x".repeat(inlineImageMaxBase64Chars() + 1)));
          },
        }),
      })
      .mockResolvedValueOnce({
        contentType: () => "image/png",
        image: () => new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("small-base64"));
            controller.close();
          },
        }),
      });
    const transform = vi.fn(() => ({ output }));
    const images = {
      input: vi.fn(() => ({ transform, output })),
    };

    const bridge = new ProjectRuntimeServiceVmBridge({
      env: {
        PROJECT_RUNTIME_SERVICE_URL: "http://runtime.test",
        IMAGES: images,
      } as never,
      workspace: {
        getProjectByName: vi.fn(async (name: string) =>
          name === "web-app" ? project : null
        ),
      } as never,
    });

    const result = await bridge.read({ project: "web-app", path: "/workspace/retry.png" }) as any;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(transform).toHaveBeenNthCalledWith(1, { width: 2000, height: 2000, fit: "scale-down" });
    expect(transform).toHaveBeenNthCalledWith(2, { width: 1500, height: 1500, fit: "scale-down" });
    expect(output).toHaveBeenCalledTimes(2);
    expect(result.content).toEqual([
      { type: "text", text: result.text },
      { type: "image", data: "small-base64", mimeType: "image/png" },
    ]);
    expect(result.details).toMatchObject({
      inlineImage: true,
      optimizedForInlineView: true,
      maxInlineDimension: 1500,
      base64Chars: "small-base64".length,
    });
  });

  it("omits optimized VM images once transformed base64 exceeds the inline cap", async () => {
    const project = {
      id: "ca-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-web-app",
      name: "web-app",
      description: "Web app.",
      defaultVmId: "main",
      artifactRemote: "https://artifacts.camelai.internal/git/web-app.git",
      artifactStatus: "ready",
      artifactDefaultBranch: "main",
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:00.000Z",
    };
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01,
      0x00, 0x00, 0x00, 0x01,
    ]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(pngBytes, {
        headers: { "content-length": String(pngBytes.byteLength) },
      }));
    vi.stubGlobal("fetch", fetchMock);
    let cancelled = false;
    const output = vi.fn(async () => ({
      contentType: () => "image/png",
      image: () => new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("x".repeat(inlineImageMaxBase64Chars() + 1)));
        },
        cancel() {
          cancelled = true;
        },
      }),
    }));
    const transform = vi.fn(() => ({ output }));
    const images = {
      input: vi.fn(() => ({ transform, output })),
    };

    const bridge = new ProjectRuntimeServiceVmBridge({
      env: {
        PROJECT_RUNTIME_SERVICE_URL: "http://runtime.test",
        IMAGES: images,
      } as never,
      workspace: {
        getProjectByName: vi.fn(async (name: string) =>
          name === "web-app" ? project : null
        ),
      } as never,
    });

    const result = await bridge.read({ project: "web-app", path: "/workspace/huge.png" }) as any;

    expect(cancelled).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: result.text }]);
    expect(result.text).toContain("Image omitted");
    expect(result.details).toMatchObject({
      image: true,
      inlineImage: false,
      optimizedForInlineView: false,
      base64Chars: null,
    });
  });

  it("collects VM directory transfer files relative to directory contents", async () => {
    const project = {
      id: "ca-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-web-app",
      name: "web-app",
      description: "Web app.",
      defaultVmId: "main",
      artifactRemote: "https://artifacts.camelai.internal/git/web-app.git",
      artifactStatus: "ready",
      artifactDefaultBranch: "main",
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:00.000Z",
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/exec")) {
        return Response.json({ success: true, stdout: "", stderr: "", exitCode: 0 });
      }
      if (url.pathname.endsWith("/fs/exists")) {
        expect(url.searchParams.get("path")).toBe("/workspace/dist");
        return Response.json({ exists: true, isDirectory: true });
      }
      if (url.pathname.endsWith("/fs/list")) {
        expect(url.searchParams.get("path")).toBe("/workspace/dist");
        expect(url.searchParams.get("recursive")).toBe("1");
        return Response.json({
          files: [
            {
              name: "app.js",
              relativePath: "app.js",
              absolutePath: "/workspace/dist/app.js",
              type: "file",
              size: 10,
              modifiedAt: "2026-06-06T00:00:00.000Z",
            },
            {
              name: "logo.png",
              relativePath: "assets/logo.png",
              absolutePath: "/workspace/dist/assets/logo.png",
              type: "file",
              size: 20,
              modifiedAt: "2026-06-06T00:00:00.000Z",
            },
          ],
          count: 2,
          path: "/workspace/dist",
          recursive: true,
        });
      }
      throw new Error(`Unexpected runtime request: ${url.toString()}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const bridge = new ProjectRuntimeServiceVmBridge({
      env: {
        PROJECT_RUNTIME_SERVICE_URL: "http://runtime.test",
      },
      workspace: {
        getProjectByName: vi.fn(async (name: string) =>
          name === "web-app" ? project : null
        ),
      } as never,
    });

    const files = await bridge.collectFilesForTransfer({ project: "web-app", path: "/workspace/dist" });

    expect(files).toEqual([
      { path: "/workspace/dist/app.js", relativePath: "app.js", size: 10 },
      { path: "/workspace/dist/assets/logo.png", relativePath: "assets/logo.png", size: 20 },
    ]);
  });

  it("resolves explicit cwd relative to the project checkout", async () => {
    const project = {
      id: "ca-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-web-app",
      name: "web-app",
      description: "Web app.",
      defaultVmId: "main",
      artifactRemote: "https://artifacts.camelai.internal/git/web-app.git",
      artifactStatus: "ready",
      artifactDefaultBranch: "main",
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:00.000Z",
    };
    const fetchMock = vi.fn(async () =>
      Response.json({
        success: true,
        stdout: "",
        stderr: "",
        exitCode: 0,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const bridge = new ProjectRuntimeServiceVmBridge({
      env: {
        PROJECT_RUNTIME_SERVICE_URL: "http://runtime.test",
      },
      workspace: {
        getProjectByName: vi.fn(async (name: string) =>
          name === "web-app" ? project : null
        ),
      } as never,
    });

    await bridge.exec({ project: "web-app", command: "pwd", cwd: "/src" });

    const userExecBody = JSON.parse(
      String(fetchMock.mock.calls[1]![1]!.body),
    );
    expect(userExecBody.cwd).toBe("/workspace/src");
  });
});
