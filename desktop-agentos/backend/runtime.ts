import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import commonSoftware from "@rivet-dev/agent-os-common";
import AgentOsPi from "@rivet-dev/agent-os-pi";
import {
  AgentOs,
  createHostDirBackend,
  type JsonRpcNotification,
  type PermissionRequest,
} from "@rivet-dev/agent-os-core";
import type { DesktopRuntimeStatus } from "../../desktop/shared/protocol";
import type { DesktopProviderDefinition } from "./provider-types";
import { logDesktop } from "../../desktop/backend/log";
import { buildAgentOsPiSettings, readHostPiAuthFileContents } from "./agentos";
import AgentOsPiLocal from "./agentos-pi-local";

const DEFAULT_RUNTIME_DIRECTORY = resolve(process.cwd(), "desktop-agentos/.local/runtime");
const DEFAULT_WORKSPACE_DIRECTORY = resolve(process.cwd());
const VM_WORKSPACE_PATH = "/workspace";
const VM_PI_HOME_PATH = "/home/user/.pi";
const VM_PI_THREAD_SESSIONS_PATH = `${VM_PI_HOME_PATH}/thread-sessions`;

function getPiAgentSoftware() {
  return process.env.DESKTOP_AGENTOS_PI_ADAPTER?.trim() === "upstream"
    ? AgentOsPi
    : AgentOsPiLocal;
}

function normalizeTimestamp(value: unknown): number {
  return typeof value === "number" ? Math.trunc(value) : 0;
}

function createNormalizedHostDirBackend(options: Parameters<typeof createHostDirBackend>[0]) {
  const backend = createHostDirBackend(options);
  type HostDirBackend = ReturnType<typeof createHostDirBackend>;
  type VirtualStat = Awaited<ReturnType<HostDirBackend["stat"]>>;

  const normalizeStat = (stat: VirtualStat): VirtualStat => {
    const record = stat as unknown as Record<string, unknown>;
    return {
      ...record,
      atimeMs: normalizeTimestamp(record.atimeMs),
      mtimeMs: normalizeTimestamp(record.mtimeMs),
      ctimeMs: normalizeTimestamp(record.ctimeMs),
      birthtimeMs: normalizeTimestamp(record.birthtimeMs),
    } as VirtualStat;
  };

  return {
    ...backend,
    async stat(path: string) {
      return normalizeStat(await backend.stat(path));
    },
    async lstat(path: string) {
      return normalizeStat(await backend.lstat(path));
    },
  } satisfies HostDirBackend;
}

export interface StreamAgentOsPromptOptions {
  provider: DesktopProviderDefinition;
  threadId: string;
  content: string;
  model: string;
  sessionId?: string | null;
  onSessionId?: (sessionId: string) => void;
  onDelta?: (delta: string) => void;
  onRuntimeEvent?: (event: JsonRpcNotification | { type: "permission_request"; request: PermissionRequest }) => void;
}

export interface StreamAgentOsPromptResult {
  finalText: string;
  model: string;
  sessionId: string;
}

function getSessionUpdate(
  event: JsonRpcNotification,
): Record<string, unknown> | null {
  const params =
    event.params && typeof event.params === "object"
      ? (event.params as Record<string, unknown>)
      : null;
  if (!params) {
    return null;
  }
  const update =
    params.update && typeof params.update === "object"
      ? (params.update as Record<string, unknown>)
      : params;
  return update && typeof update === "object" ? update : null;
}

function getPromptErrorMessage(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  return String(error);
}

function getPromptResponseErrorMessage(
  error: { message?: unknown; data?: unknown } | undefined,
): string {
  const message =
    typeof error?.message === "string"
      ? error.message
      : "AgentOS prompt failed.";
  const data =
    error?.data && typeof error.data === "object"
      ? (error.data as Record<string, unknown>)
      : null;
  const stderr =
    typeof data?.stderr === "string" && data.stderr.trim()
      ? data.stderr.trim()
      : null;

  return stderr ? `${message} (${stderr})` : message;
}

function getVmPiSessionDir(threadId: string, providerId: string): string {
  return `${VM_PI_THREAD_SESSIONS_PATH}/${providerId}/${threadId}`;
}

export class AgentOsRuntimeManager {
  private vm: AgentOs | null = null;
  private lastRuntimeStatus: DesktopRuntimeStatus | null = null;
  private runtimeStartupPromise: Promise<DesktopRuntimeStatus> | null = null;
  private readonly runtimeDirectory =
    process.env.DESKTOP_RUNTIME_DIR || DEFAULT_RUNTIME_DIRECTORY;
  private readonly workspaceDirectory =
    process.env.DESKTOP_AGENTOS_WORKSPACE_DIR || DEFAULT_WORKSPACE_DIRECTORY;
  private readonly piHomeDirectory = resolve(this.runtimeDirectory, "pi-home", ".pi");
  private readonly piAgentDirectory = resolve(this.piHomeDirectory, "agent");
  private readonly piAuthPath = resolve(this.piAgentDirectory, "auth.json");
  private readonly piSettingsPath = resolve(this.piAgentDirectory, "settings.json");

  getCachedStatus(): DesktopRuntimeStatus {
    return (
      this.lastRuntimeStatus ?? {
        state: "stopped",
        detail: "AgentOS runtime is idle.",
        helperPath: null,
        runtimeDirectory: this.runtimeDirectory,
      }
    );
  }

  dispose(): void {
    const currentVm = this.vm;
    this.vm = null;
    this.lastRuntimeStatus = {
      state: "stopped",
      detail: "AgentOS runtime stopped.",
      helperPath: null,
      runtimeDirectory: this.runtimeDirectory,
    };
    if (currentVm) {
      void currentVm.dispose();
    }
  }

  async ensureRuntime(
    onStatus?: (status: DesktopRuntimeStatus) => void,
  ): Promise<DesktopRuntimeStatus> {
    if (this.vm) {
      const status: DesktopRuntimeStatus = {
        state: "running",
        detail: `AgentOS runtime ready for ${this.workspaceDirectory}.`,
        helperPath: null,
        runtimeDirectory: this.runtimeDirectory,
      };
      this.lastRuntimeStatus = status;
      onStatus?.(status);
      return status;
    }

    if (this.runtimeStartupPromise) {
      return this.runtimeStartupPromise;
    }

    this.runtimeStartupPromise = (async () => {
      const startingStatus: DesktopRuntimeStatus = {
        state: "starting",
        detail: "Booting the local AgentOS VM.",
        helperPath: null,
        runtimeDirectory: this.runtimeDirectory,
      };
      this.lastRuntimeStatus = startingStatus;
      onStatus?.(startingStatus);

      try {
        mkdirSync(this.piAgentDirectory, { recursive: true });
        this.syncPiAuthFile();
        const mounts = [
          {
            path: VM_WORKSPACE_PATH,
            driver: createNormalizedHostDirBackend({
              hostPath: this.workspaceDirectory,
              readOnly: false,
            }),
          },
          {
            path: VM_PI_HOME_PATH,
            driver: createNormalizedHostDirBackend({
              hostPath: this.piHomeDirectory,
              readOnly: false,
            }),
          },
        ];

        this.vm = await AgentOs.create({
          moduleAccessCwd: process.cwd(),
          mounts,
          software: [...commonSoftware, getPiAgentSoftware()],
        });

        const readyStatus: DesktopRuntimeStatus = {
          state: "running",
          detail: `AgentOS runtime ready for ${this.workspaceDirectory}.`,
          helperPath: null,
          runtimeDirectory: this.runtimeDirectory,
        };
        this.lastRuntimeStatus = readyStatus;
        onStatus?.(readyStatus);
        return readyStatus;
      } catch (error) {
        const failedStatus: DesktopRuntimeStatus = {
          state: "error",
          detail: `Failed to start AgentOS: ${getPromptErrorMessage(error)}`,
          helperPath: null,
          runtimeDirectory: this.runtimeDirectory,
        };
        this.lastRuntimeStatus = failedStatus;
        onStatus?.(failedStatus);
        throw error;
      } finally {
        this.runtimeStartupPromise = null;
      }
    })();

    return this.runtimeStartupPromise;
  }

  private writePiSettings(model: string, thoughtLevel: string): void {
    mkdirSync(this.piAgentDirectory, { recursive: true });
    writeFileSync(
      this.piSettingsPath,
      `${JSON.stringify(buildAgentOsPiSettings(model, thoughtLevel), null, 2)}\n`,
      "utf8",
    );
  }

  private syncPiAuthFile(): void {
    mkdirSync(this.piAgentDirectory, { recursive: true });
    const authContents = readHostPiAuthFileContents();
    if (authContents === null) {
      rmSync(this.piAuthPath, { force: true });
      return;
    }
    writeFileSync(this.piAuthPath, authContents, "utf8");
  }

  private async ensureSession(
    provider: DesktopProviderDefinition,
    threadId: string,
    model: string,
    sessionId?: string | null,
  ): Promise<string> {
    const vm = this.vm;
    if (!vm) {
      throw new Error("AgentOS runtime is not available.");
    }

    let resolvedSessionId = sessionId?.trim() || "";
    if (resolvedSessionId) {
      try {
        vm.resumeSession(resolvedSessionId);
      } catch {
        resolvedSessionId = "";
      }
    }

    if (!resolvedSessionId) {
      this.syncPiAuthFile();
      this.writePiSettings(model, provider.getThoughtLevel());
      const env = {
        ...provider.buildSessionEnv(model),
        PI_SESSION_DIR: getVmPiSessionDir(threadId, provider.id),
      };
      const created = await vm.createSession("pi", {
        cwd: VM_WORKSPACE_PATH,
        env,
      });
      resolvedSessionId = created.sessionId;
    }

    await vm
      .setSessionMode(resolvedSessionId, provider.getThoughtLevel())
      .catch(() => undefined);

    return resolvedSessionId;
  }

  async streamPrompt({
    provider,
    threadId,
    content,
    model,
    sessionId,
    onSessionId,
    onDelta,
    onRuntimeEvent,
  }: StreamAgentOsPromptOptions): Promise<StreamAgentOsPromptResult> {
    await this.ensureRuntime();

    const vm = this.vm;
    if (!vm) {
      throw new Error("AgentOS runtime failed to initialize.");
    }

    const resolvedSessionId = await this.ensureSession(provider, threadId, model, sessionId);
    onSessionId?.(resolvedSessionId);
    let accumulatedText = "";

    const unsubscribeSessionEvents = vm.onSessionEvent(
      resolvedSessionId,
      (event) => {
        const update = getSessionUpdate(event);
        if (
          update?.sessionUpdate === "agent_message_chunk" &&
          update.content &&
          typeof update.content === "object" &&
          (update.content as { type?: unknown }).type === "text" &&
          typeof (update.content as { text?: unknown }).text === "string"
        ) {
          const delta = (update.content as { text: string }).text;
          accumulatedText += delta;
          onDelta?.(delta);
        }
        onRuntimeEvent?.(event);
      },
    );

    const unsubscribePermissions = vm.onPermissionRequest(
      resolvedSessionId,
      (request) => {
        onRuntimeEvent?.({
          type: "permission_request",
          request,
        });
        void vm.respondPermission(resolvedSessionId, request.permissionId, "once").catch((error) => {
          logDesktop(
            "agentos-runtime",
            "permission:auto_allow_failed",
            {
              threadId,
              sessionId: resolvedSessionId,
              permissionId: request.permissionId,
              error,
            },
            "warn",
          );
        });
      },
    );

    try {
      const result = await vm.prompt(resolvedSessionId, content);
      // Pi can resolve the prompt response before all ACP session/update
      // notifications have drained through AgentOS, so keep the subscription
      // alive briefly and prefer streamed text over the empty result payload.
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      if (result.response?.error) {
        throw new Error(getPromptResponseErrorMessage(result.response.error));
      }

      return {
        finalText: accumulatedText || result.text,
        model,
        sessionId: resolvedSessionId,
      };
    } finally {
      unsubscribeSessionEvents();
      unsubscribePermissions();
    }
  }
}
