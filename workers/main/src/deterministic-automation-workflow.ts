import {
  dispatchWorkflow,
  DynamicWorkflowBinding,
  type LoadWorkflowRunnerContext,
  type WorkflowRunner,
} from "@cloudflare/dynamic-workflows";
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
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

interface AutomationRunStatusTarget {
  cronStub: DurableObjectStub<WorkspaceCronDO>;
  workspaceId: string;
  automationId: string;
  instanceId: string;
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

function getWorkspaceCronStub(
  env: DeterministicAutomationWorkflowEnv,
  workspaceId: string,
): DurableObjectStub<WorkspaceCronDO> {
  if (!env.WORKSPACE_CRON) {
    throw new Error("WORKSPACE_CRON binding is not configured");
  }

  return env.WORKSPACE_CRON.get(
    env.WORKSPACE_CRON.idFromName(workspaceId),
  ) as DurableObjectStub<WorkspaceCronDO>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function recordWorkflowRunStatus(
  target: AutomationRunStatusTarget | null,
  status: "success" | "error",
  error?: unknown,
): Promise<void> {
  if (!target) return;
  try {
    const recorded =
      await target.cronStub.recordDeterministicAutomationRunResult({
        workspaceId: target.workspaceId,
        automationId: target.automationId,
        instanceId: target.instanceId,
        status,
        error: status === "error" ? errorMessage(error) : null,
      });
    if (!recorded) {
      console.warn("[DeterministicAutomationWorkflow] run status not recorded", {
        workspaceId: target.workspaceId,
        automationId: target.automationId,
        instanceId: target.instanceId,
        status,
      });
    }
  } catch (recordError) {
    console.error(
      "[DeterministicAutomationWorkflow] failed to record run status",
      {
        workspaceId: target.workspaceId,
        automationId: target.automationId,
        instanceId: target.instanceId,
        status,
        error: errorMessage(recordError),
      },
    );
  }
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

async function loadDeterministicAutomationRunner(
  input: LoadWorkflowRunnerContext<DeterministicAutomationWorkflowEnv> & {
    onStatusTarget?: (
      target: Omit<AutomationRunStatusTarget, "instanceId">,
    ) => void;
  },
): Promise<WorkflowRunner<unknown, unknown>> {
  const typedMetadata = input.metadata as DeterministicAutomationMetadata;
  const workspaceId = requireMetadataString(typedMetadata, "workspaceId");
  const automationId = requireMetadataString(typedMetadata, "automationId");
  const cronStub = getWorkspaceCronStub(input.env, workspaceId);
  input.onStatusTarget?.({ cronStub, workspaceId, automationId });
  const sourceVersion = requireSourceVersion(typedMetadata);

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

  const workspace = await cronStub.getWorkspaceInfoForAutomation(workspaceId);
  const worker = loadAutomationWorker({
    env: input.env,
    source: snapshot.source,
    cacheKey: `automation-${workspaceId}-${automationId}-${sourceVersion}`,
    workflowEnv: createDeterministicAutomationRuntimeBindings({
      ctx: input.ctx,
      orgId: workspace.org_id,
      workspaceId,
      userId: snapshot.created_by,
    }),
  });

  return worker.getEntrypoint(
    AUTOMATION_WORKFLOW_ENTRYPOINT,
  ) as unknown as WorkflowRunner<unknown, unknown>;
}

export class DeterministicAutomationWorkflow extends WorkflowEntrypoint<
  DeterministicAutomationWorkflowEnv,
  unknown
> {
  override async run(
    event: WorkflowEvent<unknown>,
    step: WorkflowStep,
  ): Promise<unknown> {
    let statusTarget: AutomationRunStatusTarget | null = null;

    try {
      const result = await dispatchWorkflow<
        DeterministicAutomationWorkflowEnv,
        unknown,
        unknown
      >({ env: this.env, ctx: this.ctx }, event, step, async (context) =>
        loadDeterministicAutomationRunner({
          ...context,
          onStatusTarget: (target) => {
            statusTarget = {
              ...target,
              instanceId: event.instanceId,
            };
          },
        }),
      );
      await recordWorkflowRunStatus(statusTarget, "success");
      return result;
    } catch (error) {
      await recordWorkflowRunStatus(statusTarget, "error", error);
      throw error;
    }
  }
}
