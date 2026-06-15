import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { ProjectRuntimeServiceVmBridge } from "../src/project-runtime-service-vm";

type PrototypeEnv = {
  PROJECT_RUNTIME_HOST?: Fetcher;
  RUN_SANDBOX_EVAL_PROTOTYPE?: string;
};

const prototypeEnv = env as unknown as PrototypeEnv;
const maybeIt = prototypeEnv.RUN_SANDBOX_EVAL_PROTOTYPE === "1" ? it : it.skip;

describe("EvalProjectRuntimeService prototype", () => {
  maybeIt(
    "runs the project runtime bridge against a Sandbox-backed local service",
    async () => {
      expect(prototypeEnv.PROJECT_RUNTIME_HOST).toBeDefined();

      const runId = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
      const projectName = `eval-prototype-${runId}`;
      const project = {
        id: `ca-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-${runId}`,
        name: projectName,
        description: "Sandbox-backed eval runtime prototype.",
        defaultVmId: "main",
        artifactRemote: `https://artifacts.camelai.internal/git/${projectName}.git`,
        artifactStatus: "ready",
        artifactDefaultBranch: "main",
        createdAt: "2026-06-08T00:00:00.000Z",
        updatedAt: "2026-06-08T00:00:00.000Z",
      };
      const projects = new Map<string, typeof project>([[project.name, project]]);

      const bridge = new ProjectRuntimeServiceVmBridge({
        env: {
          PROJECT_RUNTIME_HOST: prototypeEnv.PROJECT_RUNTIME_HOST,
          RUN_AGENT_EVALS: "1",
        },
        workspace: {
          getProjectByName: async (name: string) =>
            projects.get(name) ?? null,
          cloneProject: async ({ name, sourceProject }: { name?: string; sourceProject?: string }) => {
            const source = sourceProject ? projects.get(sourceProject) : null;
            if (!source || !name) throw new Error("Invalid clone test project");
            const clonedProject = {
              ...source,
              id: `${source.id}-clone`,
              name,
              description: "Sandbox-backed eval runtime clone.",
            };
            projects.set(name, clonedProject);
            return clonedProject;
          },
        } as never,
        commandEnv: {
          EVAL_ORG_ID: "eval-org",
          EVAL_WORKSPACE_ID: "eval-workspace",
          EVAL_USER_ID: "eval-user",
          EVAL_THREAD_ID: "eval-thread",
        },
      });

      await bridge.write({
        project: project.name,
        path: "/hello.txt",
        content: "sandbox runtime ok\n",
      });

      const exec = await bridge.exec({
        project: project.name,
        command: "cat /workspace/hello.txt",
      });

      expect(exec).toMatchObject({
        success: true,
        exitCode: 0,
      });
      expect(exec.stdout).toContain("sandbox runtime ok");

      const failedExec = await bridge.exec({
        project: project.name,
        command: "exit 7",
      });
      expect(failedExec.success).toBe(false);
      expect(failedExec.exitCode).not.toBe(0);
      expect(typeof failedExec.stderr).toBe("string");

      const read = await bridge.read({
        project: project.name,
        path: "/hello.txt",
      });

      expect((read as { text?: string }).text).toContain("sandbox runtime ok");

      const cloneProject = {
        ...project,
        id: `${project.id}-clone`,
        name: `${projectName}-clone`,
        description: "Sandbox-backed eval runtime clone.",
      };
      const clone = await bridge.cloneProject({
        sourceProject: project.name,
        name: cloneProject.name,
      });
      expect(clone).toMatchObject({
        success: true,
        project: cloneProject.name,
      });
      const cloneRead = await bridge.read({
        project: cloneProject.name,
        path: "/hello.txt",
      });
      expect((cloneRead as { text?: string }).text).toContain("sandbox runtime ok");

      const tools = await bridge.exec({
        project: project.name,
        command: "for tool in bun create-worker; do printf '%s=' \"$tool\"; command -v \"$tool\" || true; done",
      });
      expect(tools.stdout).toContain("bun=/usr/local/bin/bun");
      expect(tools.stdout).toContain("create-worker=/usr/local/bin/create-worker");

      const scaffold = await bridge.exec({
        project: project.name,
        command: [
          `create-worker ${projectName}-app --style nova --theme blue`,
          `test -f ${projectName}-app/package.json`,
          `test -f ${projectName}-app/wrangler.jsonc`,
          `grep -q '"name": "${projectName}-app"' ${projectName}-app/wrangler.jsonc`,
        ].join(" && "),
        timeoutMs: 120_000,
      });
      expect(scaffold).toMatchObject({ success: true, exitCode: 0 });

      const deployMock = await bridge.exec({
        project: project.name,
        command:
          'curl -fsS "$CLOUDFLARE_API_BASE_URL/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/dispatch/namespaces/chiridion/scripts/eval-smoke"',
      });
      expect(deployMock).toMatchObject({ success: true, exitCode: 0 });
      expect(deployMock.stdout).toContain('"success":true');

      const deployUpload = await bridge.exec({
        project: project.name,
        command: [
          'curl -fsS -X PUT',
          '-F metadata={}',
          '-F script=@/workspace/hello.txt',
          '"$CLOUDFLARE_API_BASE_URL/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/dispatch/namespaces/chiridion/scripts/eval-smoke?excludeScript=true&bindings_inherit=strict"',
        ].join(" "),
      });
      expect(deployUpload).toMatchObject({ success: true, exitCode: 0 });

      const deploys = await bridge.exec({
        project: project.name,
        command: "curl -fsS http://camelai-eval-cloudflare-api.internal/__eval/deploys",
      });
      expect(deploys).toMatchObject({ success: true, exitCode: 0 });
      const deploysJson = JSON.parse(deploys.stdout) as {
        apps?: Array<{ script_name?: string; workspace_id?: string; vanity_url?: string }>;
      };
      expect(deploysJson.apps?.some((app) =>
        app.script_name === "eval-smoke" &&
        app.workspace_id === "eval-workspace" &&
        app.vanity_url === "https://eval-smoke.eval.camelai.app",
      )).toBe(true);
    },
    120_000,
  );
});
