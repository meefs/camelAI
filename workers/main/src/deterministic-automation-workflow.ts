import {
  createDynamicWorkflowEntrypoint,
  DynamicWorkflowBinding,
  type WorkflowRunner,
} from "@cloudflare/dynamic-workflows";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { AIVirtualBindingProps } from "./ai-virtual-binding";
import type { CodeModeToolsProps } from "./chat-thread-do";
import type { WorkspaceCronDO } from "./workspace-cron";

const AUTOMATION_WORKFLOW_ENTRYPOINT = "AutomationWorkflow";
const AUTOMATION_COMPATIBILITY_DATE = "2026-05-18";

export { DynamicWorkflowBinding };

interface DeterministicAutomationMetadata {
  workspaceId?: unknown;
  automationId?: unknown;
  sourceVersion?: unknown;
}

interface DeterministicAutomationWorkflowEnv {
  WORKSPACE_CRON?: DurableObjectNamespace<WorkspaceCronDO>;
  CODE_MODE_LOADER?: WorkerLoader;
}

interface ConnectionsServiceProps {
  orgId: string;
  workspaceId: string;
  userId?: string;
}

interface WorkflowExecutionContextLike {
  waitUntil?: (promise: Promise<unknown>) => void;
  exports?: WorkerEntrypointFactories;
}

interface WorkerEntrypointFactories {
  CodeModeToolsBinding?: (options: { props: CodeModeToolsProps }) => unknown;
  ConnectionsService?: (options: { props: ConnectionsServiceProps }) => unknown;
  AIVirtualBinding?: (options: { props: AIVirtualBindingProps }) => unknown;
  CamelAiService?: (options: { props: AIVirtualBindingProps }) => unknown;
}

function requireMetadataString(
  metadata: DeterministicAutomationMetadata,
  key: "workspaceId" | "automationId",
): string {
  const value = metadata[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Dynamic automation metadata is missing ${key}`);
  }
  return value.trim();
}

function requireSourceVersion(metadata: DeterministicAutomationMetadata): number {
  const value = metadata.sourceVersion;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    throw new Error("Dynamic automation metadata is missing sourceVersion");
  }
  return Math.floor(value);
}

function loadAutomationWorker(input: {
  env: DeterministicAutomationWorkflowEnv;
  workflowEnv: Record<string, unknown>;
  cacheKey: string;
  source: string;
}): WorkerStub {
  const loader = input.env.CODE_MODE_LOADER as
    | (WorkerLoader & { load?: (code: WorkerLoaderWorkerCode) => WorkerStub })
    | undefined;
  if (!loader) {
    throw new Error("CODE_MODE_LOADER binding is not configured");
  }

  const workerCode: WorkerLoaderWorkerCode = {
    compatibilityDate: AUTOMATION_COMPATIBILITY_DATE,
    mainModule: "index.js",
    modules: {
      "index.js": { js: input.source },
    },
    env: input.workflowEnv,
  };

  return typeof loader.load === "function"
    ? loader.load(workerCode)
    : loader.get(input.cacheKey, () => workerCode);
}

export function createDeterministicAutomationRuntimeBindings(input: {
  ctx: WorkflowExecutionContextLike;
  orgId: string;
  workspaceId: string;
  userId?: string;
}): Record<string, unknown> {
  const scopedProps = {
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    userId: input.userId,
  };
  const exports = input.ctx.exports;
  if (!exports) {
    return {
      AUTOMATION_CONTEXT: scopedProps,
    };
  }
  const {
    CodeModeToolsBinding,
    ConnectionsService,
    AIVirtualBinding,
    CamelAiService,
  } = exports;
  if (
    !CodeModeToolsBinding ||
    !ConnectionsService ||
    !AIVirtualBinding ||
    !CamelAiService
  ) {
    throw new Error("Automation runtime bindings are not exported");
  }
  return {
    TOOLS: CodeModeToolsBinding({ props: scopedProps }),
    CONNECTIONS: ConnectionsService({ props: scopedProps }),
    AI: AIVirtualBinding({ props: scopedProps }),
    CAMELAI: CamelAiService({ props: scopedProps }),
  };
}

export const DeterministicAutomationWorkflow =
  createDynamicWorkflowEntrypoint<DeterministicAutomationWorkflowEnv>(
    async ({ metadata, env, ctx }) => {
      const typedMetadata = metadata as DeterministicAutomationMetadata;
      const workspaceId = requireMetadataString(typedMetadata, "workspaceId");
      const automationId = requireMetadataString(typedMetadata, "automationId");
      const sourceVersion = requireSourceVersion(typedMetadata);

      if (!env.WORKSPACE_CRON) {
        throw new Error("WORKSPACE_CRON binding is not configured");
      }

      const cronStub = env.WORKSPACE_CRON.get(
        env.WORKSPACE_CRON.idFromName(workspaceId),
      ) as DurableObjectStub<WorkspaceCronDO>;
      const snapshot = await cronStub.getDeterministicAutomationSource(
        workspaceId,
        automationId,
        sourceVersion,
      );
      if (!snapshot) {
        throw new Error(
          `Deterministic automation source not found: ${automationId}@${sourceVersion}`,
        );
      }

      const workspace = await cronStub.getWorkspaceInfoForAutomation(
        workspaceId,
      );
      const worker = loadAutomationWorker({
        env,
        source: snapshot.source,
        cacheKey: `automation-${workspaceId}-${automationId}-${sourceVersion}`,
        workflowEnv: createDeterministicAutomationRuntimeBindings({
          ctx,
          orgId: workspace.org_id,
          workspaceId,
          userId: snapshot.created_by,
        }),
      });

      return worker.getEntrypoint(
        AUTOMATION_WORKFLOW_ENTRYPOINT,
      ) as unknown as WorkflowRunner<WorkflowEvent<unknown>, WorkflowStep>;
    },
  );
