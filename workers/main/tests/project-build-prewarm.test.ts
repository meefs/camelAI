import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture the (namespace, key, opts) getSandbox is called with and hand back a
// fake sandbox whose exec we can drive per-test. Mocked at module load so the
// prewarm helpers never touch a real Cloudflare Container.
const execMock = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
const getSandboxMock = vi.fn(() => ({ exec: execMock }));

vi.mock("@cloudflare/sandbox", () => ({
  getSandbox: (...args: unknown[]) => getSandboxMock(...args),
}));

import {
  ProjectBuildService,
  prewarmProjectBuildSandbox,
  prewarmWorkspaceBuildSandboxes,
  projectBuildSandboxKey,
} from "../src/project-build-service";

const SANDBOX_NS = { __brand: "sandbox-namespace" } as never;

function fakeWorkspaceEnv(projects: Array<{ id: string; backend?: string }>) {
  const stub = { listProjects: vi.fn(async () => projects) };
  return {
    env: {
      PROJECT_BUILD_SANDBOX: SANDBOX_NS,
      WORKSPACE_FS: {
        idFromName: (name: string) => name,
        get: () => stub,
      } as never,
      R2_BUCKET: {} as never,
    },
    listProjects: stub.listProjects,
  };
}

beforeEach(() => {
  execMock.mockClear();
  execMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
  getSandboxMock.mockClear();
});

describe("prewarmProjectBuildSandbox", () => {
  it("boots the per-org container with a no-op command", async () => {
    const result = await prewarmProjectBuildSandbox({
      env: { PROJECT_BUILD_SANDBOX: SANDBOX_NS },
      orgId: "Org A",
    });

    expect(result).toBe(true);
    expect(getSandboxMock).toHaveBeenCalledTimes(1);
    // Reuses the exact org key runProjectBuild/deploy acquire, so the warm instance
    // is the one the build lands on.
    expect(getSandboxMock).toHaveBeenCalledWith(
      SANDBOX_NS,
      projectBuildSandboxKey("Org A"),
      expect.objectContaining({ normalizeId: true, transport: "rpc" }),
    );
    // @cloudflare/sandbox honors `timeout` (ms), not `timeoutMs`.
    expect(execMock).toHaveBeenCalledWith("true", expect.objectContaining({ timeout: expect.any(Number) }));
  });

  it("no-ops without the container binding and never touches getSandbox", async () => {
    const result = await prewarmProjectBuildSandbox({
      env: {},
      orgId: "org",
    });

    expect(result).toBe(false);
    expect(getSandboxMock).not.toHaveBeenCalled();
  });

  it("returns false for a missing org scope", async () => {
    const result = await prewarmProjectBuildSandbox({
      env: { PROJECT_BUILD_SANDBOX: SANDBOX_NS },
      orgId: "   ",
    });

    expect(result).toBe(false);
    expect(getSandboxMock).not.toHaveBeenCalled();
  });

  it("swallows container errors so a warm failure can't break the turn", async () => {
    execMock.mockRejectedValueOnce(new Error("container busy"));

    const result = await prewarmProjectBuildSandbox({
      env: { PROJECT_BUILD_SANDBOX: SANDBOX_NS },
      orgId: "org",
    });

    expect(result).toBe(false);
  });

  it("clamps tiny timeouts to one second", async () => {
    await expect(prewarmProjectBuildSandbox({
      env: { PROJECT_BUILD_SANDBOX: SANDBOX_NS },
      orgId: "org",
      timeoutMs: 12,
    })).resolves.toBe(true);

    expect(execMock).toHaveBeenCalledWith("true", { timeout: 1_000 });
  });
});

describe("ProjectBuildService admission", () => {
  it("exposes only the two WorkerEntrypoint RPC methods", () => {
    expect(Object.getOwnPropertyNames(ProjectBuildService.prototype).sort()).toEqual([
      "addDependency",
      "buildProject",
      "constructor",
    ]);
  });

  it("keeps the binding and org-scope validation errors at the WorkerEntrypoint boundary", async () => {
    await expect(ProjectBuildService.prototype.buildProject.call({
      env: {},
      ctx: { props: { orgId: "org" } },
    } as never, { projectId: "demo" })).rejects.toThrow(
      "PROJECT_BUILD_SANDBOX container binding is not configured",
    );
    await expect(ProjectBuildService.prototype.addDependency.call({
      env: { PROJECT_BUILD_SANDBOX: SANDBOX_NS },
      ctx: { props: { orgId: "" } },
    } as never, { projectId: "demo", dependency: "react" })).rejects.toThrow(
      "Project build service requires org scope",
    );
    expect(getSandboxMock).not.toHaveBeenCalled();
  });
});

describe("prewarmWorkspaceBuildSandboxes", () => {
  it("warms the org build sandbox even before any DO-backed projects exist", async () => {
    const { env } = fakeWorkspaceEnv([
      { id: "legacy", backend: "vm" },
      { id: "unset" }, // defaults to vm
    ]);

    const warmed = await prewarmWorkspaceBuildSandboxes(env, "acme", "ws-1");

    expect(warmed).toBe(1);
    expect(getSandboxMock).toHaveBeenCalledTimes(1);
    const keys = getSandboxMock.mock.calls.map((call) => call[1]);
    expect(keys).toEqual([projectBuildSandboxKey("acme")]);
  });

  it("does not list workspace projects because one org sandbox covers every project", async () => {
    const stub = {
      listProjects: vi.fn(async () => [
        {
          id: "source",
          backend: "do-r2",
          clones: [
            { id: "clone-do", backend: "do-r2" },
            { id: "clone-vm", backend: "vm" },
          ],
        },
        { id: "legacy", backend: "vm", clones: [{ id: "clone-of-legacy", backend: "do-r2" }] },
      ]),
    };
    const env = {
      PROJECT_BUILD_SANDBOX: SANDBOX_NS,
      WORKSPACE_FS: { idFromName: (n: string) => n, get: () => stub } as never,
      R2_BUCKET: {} as never,
    };

    const warmed = await prewarmWorkspaceBuildSandboxes(env, "acme", "ws-1");

    expect(warmed).toBe(1);
    expect(stub.listProjects).not.toHaveBeenCalled();
    const keys = getSandboxMock.mock.calls.map((call) => call[1]);
    expect(keys).toEqual([projectBuildSandboxKey("acme")]);
  });

  it("still warms only one container for workspaces with many projects", async () => {
    const projects = Array.from({ length: 8 }, (_, i) => ({ id: `app-${i}`, backend: "do-r2" }));
    const { env } = fakeWorkspaceEnv(projects);

    const warmed = await prewarmWorkspaceBuildSandboxes(env, "acme", "ws-1", { maxTargets: 3 });

    expect(warmed).toBe(1);
    expect(getSandboxMock).toHaveBeenCalledTimes(1);
  });

  it("returns 0 without the container binding", async () => {
    const { env } = fakeWorkspaceEnv([{ id: "app-one", backend: "do-r2" }]);
    const warmed = await prewarmWorkspaceBuildSandboxes(
      { ...env, PROJECT_BUILD_SANDBOX: undefined },
      "acme",
      "ws-1",
    );

    expect(warmed).toBe(0);
    expect(getSandboxMock).not.toHaveBeenCalled();
  });

  it("returns 0 when prewarming is disabled by the runtime", async () => {
    const { env } = fakeWorkspaceEnv([{ id: "app-one", backend: "do-r2" }]);
    const warmed = await prewarmWorkspaceBuildSandboxes(
      { ...env, DISABLE_PROJECT_BUILD_SANDBOX_PREWARM: "1" },
      "acme",
      "ws-1",
    );

    expect(warmed).toBe(0);
    expect(getSandboxMock).not.toHaveBeenCalled();
  });
});
