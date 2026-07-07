import { getSandbox } from "@cloudflare/sandbox";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { projectBuildSandboxKey, runProjectAddDependency, runProjectBuild } from "../src/project-build-service";
import type { ProjectBuildSandboxLike } from "../src/project-worker-bundle";
import { ProjectFilesystemClient } from "../src/workspace-filesystem-do";

type ReproEnv = typeof env & {
  RUN_PROJECT_BUILD_SANDBOX_REPRO?: string;
};

const testEnv = env as ReproEnv;
const maybeIt = testEnv.RUN_PROJECT_BUILD_SANDBOX_REPRO === "1" ? it : it.skip;

const DEPENDENCIES = [
  "clsx@^2.1.1",
  "is-number@^7.0.0",
  "is-odd@^3.0.1",
  "left-pad@^1.3.0",
  "nanoid@^5.1.6",
  "tslib@^2.8.1",
  "tiny-invariant@^1.3.3",
  "kleur@^4.1.5",
];

describe("real project build sandbox repro", () => {
  maybeIt("runs add_dependency followed immediately by build repeatedly", async () => {
    expect(testEnv.PROJECT_BUILD_SANDBOX).toBeDefined();
    const projectId = `repro-${Date.now().toString(36)}`;
    const sandbox = getSandbox(testEnv.PROJECT_BUILD_SANDBOX, projectBuildSandboxKey("repro-org"), {
      normalizeId: true,
      transport: "rpc",
    }) as unknown as ProjectBuildSandboxLike;
    const files = new ProjectFilesystemClient(testEnv as never, projectId);
    await expect(files.writeFile(
      "/package.json",
      JSON.stringify({
        type: "module",
        scripts: {
          build: "bun -e \"console.log('built')\"",
        },
      }, null, 2),
    )).resolves.toEqual({ success: true });
    await expect(files.writeFile("/src/index.ts", "export default {};\n")).resolves.toEqual({ success: true });

    for (let index = 0; index < DEPENDENCIES.length; index += 1) {
      const dependency = DEPENDENCIES[index];
      const add = await runProjectAddDependency({ projectId, files, sandbox, dependency });
      expect(add, `add_dependency attempt ${index}`).toMatchObject({ success: true, packageJsonPersisted: true });
      const build = await runProjectBuild({ projectId, files, sandbox });
      expect(build, `build_project attempt ${index}: ${build.stderr || build.stdout}`).toMatchObject({ success: true });
    }
  }, 180_000);
});
