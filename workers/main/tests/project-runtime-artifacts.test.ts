import { afterEach, describe, expect, it, vi } from "vitest";
import { handleProjectRuntimeArtifactsProxy } from "../src/routes/project-runtime-artifacts";

function request(url: string, init?: RequestInit, cf?: unknown): Request {
  const req = new Request(url, init);
  if (cf) {
    Object.defineProperty(req, "cf", {
      value: cf,
      configurable: true,
    });
  }
  return req;
}

function routeContext(req: Request, env: Record<string, unknown>) {
  return {
    req,
    env: env as never,
    ctx: { waitUntil: vi.fn() } as never,
    url: new URL(req.url),
    match: [] as unknown as RegExpMatchArray,
  };
}

describe("project runtime Artifacts proxy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mints tokens from internal project metadata and proxies to the real Artifacts remote", async () => {
    const projectId = "ca-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-web-app";
    const remoteProjectId = "ca-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-source";
    const mintProjectArtifactToken = vi.fn(async () => ({
      project: {
        id: projectId,
        name: "web-app",
        description: "Web app.",
        defaultVmId: "main",
        artifactRemote: "https://artifacts.camelai.internal/git/source.git",
        createdAt: "2026-06-05T00:00:00.000Z",
        updatedAt: "2026-06-05T00:00:00.000Z",
      },
      token: "artifact-token",
      artifactRemote: `https://artifacts.cloudflare.test/git/${remoteProjectId}.git`,
      artifactRemoteProjectId: remoteProjectId,
    }));
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);

    const req = request(
      "https://camelai.dev/api/internal/project-runtime/artifacts/git/origin.git/info/refs?service=git-upload-pack",
      {
        headers: {
          "X-Project-Runtime-Secret": "runtime-secret",
          "X-Project-Runtime-Project": projectId,
          "X-Project-Runtime-Debug": "strip-me",
        },
      },
    );

    const res = await handleProjectRuntimeArtifactsProxy(routeContext(req, {
      PROJECT_RUNTIME_PROXY_SECRET: "runtime-secret",
      WORKSPACE_FS: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => ({ mintProjectArtifactToken })),
      },
    }));

    expect(res.status).toBe(200);
    expect(mintProjectArtifactToken).toHaveBeenCalledWith(projectId, "read", 600);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const forwarded = fetchMock.mock.calls[0]![0] as Request;
    expect(forwarded.url).toBe(
      `https://artifacts.cloudflare.test/git/${remoteProjectId}.git/info/refs?service=git-upload-pack`,
    );
    expect(forwarded.headers.get("Authorization")).toBe("Bearer artifact-token");
    expect(forwarded.headers.has("X-Project-Runtime-Debug")).toBe(false);
  });

  it("accepts Cloudflare-verified mTLS without a shared secret", async () => {
    const projectId = "ca-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-web-app";
    const remoteProjectId = "ca-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-source";
    const mintProjectArtifactToken = vi.fn(async () => ({
      project: {
        id: projectId,
        name: "web-app",
        description: "Web app.",
        defaultVmId: "main",
        artifactRemote: "https://artifacts.camelai.internal/git/source.git",
        createdAt: "2026-06-05T00:00:00.000Z",
        updatedAt: "2026-06-05T00:00:00.000Z",
      },
      token: "artifact-token",
      artifactRemote: `https://artifacts.cloudflare.test/git/${remoteProjectId}.git`,
      artifactRemoteProjectId: remoteProjectId,
    }));
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);

    const req = request(
      "https://camelai.dev/api/internal/project-runtime/artifacts/git/origin.git/info/refs?service=git-upload-pack",
      {
        headers: {
          "X-Project-Runtime-Project": projectId,
        },
      },
      {
        tlsClientAuth: {
          certVerified: "SUCCESS",
        },
      },
    );

    const res = await handleProjectRuntimeArtifactsProxy(routeContext(req, {
      WORKSPACE_FS: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => ({ mintProjectArtifactToken })),
      },
    }));

    expect(res.status).toBe(200);
    expect(mintProjectArtifactToken).toHaveBeenCalledWith(projectId, "read", 600);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects unauthenticated requests", async () => {
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);

    const req = request(
      "https://camelai.dev/api/internal/project-runtime/artifacts/git/origin.git/info/refs?service=git-upload-pack",
      {
        headers: {
          "X-Project-Runtime-Project": "ca-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-web-app",
        },
      },
    );

    const res = await handleProjectRuntimeArtifactsProxy(routeContext(req, {
      PROJECT_RUNTIME_PROXY_SECRET: "runtime-secret",
      WORKSPACE_FS: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => ({ mintProjectArtifactToken: vi.fn() })),
      },
    }));

    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Forbidden");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
