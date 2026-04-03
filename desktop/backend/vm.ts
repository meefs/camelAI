import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DesktopVmStatus } from "../shared/protocol";
import { getHostClaudeCredentialsJson } from "./anthropic";
import { logDesktop } from "./log";

const backendDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(backendDirectory, "..");
const DEFAULT_VM_DIRECTORY = resolve(desktopDirectory, ".local/vm");
const DEFAULT_APPLIANCE_IMAGE_PATH = resolve(
  desktopDirectory,
  ".local/vm/disk.raw",
);
const DEFAULT_HELPER_PATH = resolve(
  desktopDirectory,
  "vm-helper/.build/debug/camelai-vm-helper",
);
const DEFAULT_INSTANCE_NAME =
  process.env.DESKTOP_VM_INSTANCE_NAME || "camelai-desktop";
const DEFAULT_GUEST_CONTROL_PLANE_PORT = Number(
  process.env.DESKTOP_GUEST_CONTROL_PLANE_PORT || 4317,
);
const DEFAULT_GUEST_BOOT_TIMEOUT_MS = Number(
  process.env.DESKTOP_VM_BOOT_TIMEOUT_MS || 120000,
);
const DEFAULT_GUEST_HEALTH_TIMEOUT_MS = Number(
  process.env.DESKTOP_GUEST_HEALTH_TIMEOUT_MS || 300000,
);
const DEFAULT_GUEST_HEALTH_REQUEST_TIMEOUT_MS = Number(
  process.env.DESKTOP_GUEST_HEALTH_REQUEST_TIMEOUT_MS || 2000,
);
const DEFAULT_HELPER_SOCKET_TIMEOUT_MS = Number(
  process.env.DESKTOP_VM_HELPER_SOCKET_TIMEOUT_MS || 5000,
);
const DEFAULT_HELPER_PREPARE_TIMEOUT_MS = Number(
  process.env.DESKTOP_VM_HELPER_PREPARE_TIMEOUT_MS || 15 * 60 * 1000,
);
const DEFAULT_HELPER_START_TIMEOUT_MS = Number(
  process.env.DESKTOP_VM_HELPER_START_TIMEOUT_MS || 5 * 60 * 1000,
);
const DEFAULT_HELPER_STOP_TIMEOUT_MS = Number(
  process.env.DESKTOP_VM_HELPER_STOP_TIMEOUT_MS || 30000,
);
const HOST_CLAUDE_SYNC_PATHS = [".claude.json"] as const;
const DEFAULT_GUEST_CONTROL_PLANE_IMAGE =
  process.env.DESKTOP_GUEST_CONTROL_PLANE_IMAGE?.trim() ||
  "vercantes/camelai-openwork:20260403-v2";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

interface VmHelperResponse {
  state?: DesktopVmStatus["state"];
  detail?: string;
  helperPath?: string | null;
  prepared?: boolean;
  vmDirectory?: string | null;
  diskPath?: string | null;
  instanceName?: string | null;
  localProxyPort?: number | null;
  guestIPAddress?: string | null;
}

interface VmHelperDaemonRequest {
  id: string;
  command: "status" | "prepare" | "start" | "stop";
}

interface VmHelperDaemonResponse {
  id?: string | null;
  ok?: boolean;
  result?: VmHelperResponse;
  error?: string | null;
  type?: string | null;
  protocolVersion?: number | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function elapsedMs(startedAt: number): number {
  return Date.now() - startedAt;
}

export class VmManager {
  private readonly helperPath: string;
  private readonly instanceName: string;
  private readonly guestControlPlanePort: number;
  private readonly vmDirectory: string;
  private helperDaemonProcess: ReturnType<typeof spawn> | null = null;
  private helperRequestCounter = 0;
  private helperDaemonReadyPromise: Promise<void> | null = null;
  private lastGuestControlPlaneError = "";
  private lastHostAuthSignature: string | null = null;
  private lastVmStatus: DesktopVmStatus | null = null;
  private lastReportedVmStatusKey: string | null = null;
  private warnedAboutApplianceBaked = false;
  private attemptedApplianceRecovery = false;

  constructor(
    helperPath = process.env.DESKTOP_VM_HELPER_PATH || DEFAULT_HELPER_PATH,
  ) {
    this.helperPath = helperPath;
    this.instanceName = DEFAULT_INSTANCE_NAME;
    this.guestControlPlanePort = DEFAULT_GUEST_CONTROL_PLANE_PORT;
    this.vmDirectory = process.env.DESKTOP_VM_DIR || DEFAULT_VM_DIRECTORY;
  }

  getHelperPath(): string {
    return this.helperPath;
  }

  dispose(): void {
    if (
      this.helperDaemonProcess &&
      this.helperDaemonProcess.exitCode === null
    ) {
      this.helperDaemonProcess.kill("SIGTERM");
    }
    this.helperDaemonProcess = null;
    this.helperDaemonReadyPromise = null;
  }

  getGuestControlPlaneHttpUrl(): string {
    const localPort = this.getResolvedLocalControlPlanePort();
    if (!localPort) {
      throw new Error(
        "The guest control-plane proxy port has not been assigned yet.",
      );
    }
    return `http://127.0.0.1:${localPort}`;
  }

  private getHelperEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      DESKTOP_VM_DIR: this.vmDirectory,
      DESKTOP_VM_APPLIANCE_IMAGE_PATH:
        process.env.DESKTOP_VM_APPLIANCE_IMAGE_PATH ||
        DEFAULT_APPLIANCE_IMAGE_PATH,
    };
  }

  private getHelperSocketPath(): string {
    return resolve(this.vmDirectory, "artifacts/helper.sock");
  }

  getCachedStatus(): DesktopVmStatus {
    if (!existsSync(this.helperPath)) {
      return {
        state: "unavailable",
        detail:
          "VM helper is not built yet. Run `bun run desktop:vm-helper:build` to compile the Swift scaffold.",
        helperPath: this.helperPath,
      };
    }

    return {
      state: "stopped",
      detail:
        "VM helper is available. The desktop app will start the local runtime automatically.",
      helperPath: this.helperPath,
    };
  }

  async getStatus(): Promise<DesktopVmStatus> {
    return this.sendHelperCommand("status");
  }

  async prepareRuntime(): Promise<DesktopVmStatus> {
    const status = await this.sendHelperCommand("prepare");
    this.lastVmStatus = status;
    return status;
  }

  async startRuntime(): Promise<DesktopVmStatus> {
    const status = await this.sendHelperCommand("start");
    this.lastVmStatus = status;
    return status;
  }

  async stopRuntime(): Promise<DesktopVmStatus> {
    const status = await this.sendHelperCommand("stop");
    this.lastVmStatus = status;
    return status;
  }

  async getRuntimeObservedStatus(): Promise<DesktopVmStatus> {
    const status = await this.getStatus();
    if (status.state !== "running") {
      return status;
    }

    if (await this.isGuestHealthReachable()) {
      return status;
    }

    return {
      ...status,
      state: "starting",
      detail:
        status.detail.includes("Guest status:")
          ? status.detail
          : "Starting the local runtime automatically.",
    };
  }

  async ensureGuestAgentRuntime(
    model: string,
    onStatus?: (status: DesktopVmStatus) => void,
  ): Promise<DesktopVmStatus> {
    const startedAt = Date.now();
    const phaseTimings: Record<string, number> = {};
    this.attemptedApplianceRecovery = false;
    logDesktop(
      "vm",
      "ensure_guest_runtime:start",
      {
        model,
        helperPath: this.helperPath,
        instanceName: this.instanceName,
      },
      "debug",
    );
    let phaseStartedAt = Date.now();
    let status = await this.getStatus();
    phaseTimings.initialStatusMs = elapsedMs(phaseStartedAt);
    this.reportStatus(status, onStatus);
    logDesktop(
      "vm",
      "ensure_guest_runtime:status_initial",
      {
        model,
        state: status.state,
        prepared: status.prepared,
        detail: status.detail,
      },
      "debug",
    );
    if (status.state === "unavailable" || status.state === "error") {
      throw new Error(status.detail);
    }

    if (!status.prepared) {
      logDesktop(
        "vm",
        "ensure_guest_runtime:prepare_needed",
        {
          model,
        },
        "debug",
      );
      phaseStartedAt = Date.now();
      status = await this.sendHelperCommand("prepare");
      phaseTimings.prepareMs = elapsedMs(phaseStartedAt);
      this.reportStatus(status, onStatus);
      if (status.state === "unavailable" || status.state === "error") {
        throw new Error(status.detail);
      }
    }

    const hostCredentialsJson = getHostClaudeCredentialsJson();
    const hostAuthPaths = this.getExistingHostClaudeAuthPaths(hostCredentialsJson);
    const hostAuthSignature = this.computeHostAuthSignature(
      hostAuthPaths,
      homedir(),
      hostCredentialsJson,
    );
    const authChanged = this.lastHostAuthSignature !== hostAuthSignature;

    // Stage the guest runtime inputs before boot so the VM can consume them
    // on first mount instead of racing a live shared-directory sync.
    phaseStartedAt = Date.now();
    this.writeGuestControlPlaneEnv(model);
    phaseTimings.stageGuestInputsMs = elapsedMs(phaseStartedAt);
    if (authChanged) {
      logDesktop(
        "vm",
        "ensure_guest_runtime:preboot_bootstrap_needed",
        {
          model,
          authChanged,
        },
        "debug",
      );
      phaseStartedAt = Date.now();
      await this.bootstrapGuestRuntime({
        hostAuthPaths,
        hostAuthSignature,
        hostCredentialsJson,
      });
      phaseTimings.bootstrapGuestRuntimeMs = elapsedMs(phaseStartedAt);
    }

    if (status.state !== "running") {
      logDesktop(
        "vm",
        "ensure_guest_runtime:start_needed",
        {
          model,
          state: status.state,
        },
        "debug",
      );
      phaseStartedAt = Date.now();
      status = await this.sendHelperCommand("start");
      phaseTimings.startCommandMs = elapsedMs(phaseStartedAt);
      this.reportStatus(status, onStatus);
      if (status.state === "unavailable" || status.state === "error") {
        throw new Error(status.detail);
      }
    }

    logDesktop(
      "vm",
      "ensure_guest_runtime:wait_for_vm_running:start",
      {
        model,
      },
      "debug",
    );
    phaseStartedAt = Date.now();
    await this.waitForVmRunning(onStatus);
    phaseTimings.waitForVmRunningMs = elapsedMs(phaseStartedAt);
    phaseStartedAt = Date.now();
    await this.waitForGuestHealth(onStatus);
    phaseTimings.waitForGuestHealthMs = elapsedMs(phaseStartedAt);

    phaseStartedAt = Date.now();
    const finalStatus = await this.getRuntimeObservedStatus();
    phaseTimings.finalObservedStatusMs = elapsedMs(phaseStartedAt);
    this.reportStatus(finalStatus, onStatus);
    logDesktop("vm", "ensure_guest_runtime:success", {
      model,
      elapsedMs: Date.now() - startedAt,
      state: finalStatus.state,
      detail: finalStatus.detail,
      phaseTimings,
    });
    return finalStatus;
  }

  private async waitForVmRunning(
    onStatus?: (status: DesktopVmStatus) => void,
  ): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < DEFAULT_GUEST_BOOT_TIMEOUT_MS) {
      const status = await this.getStatus();
      this.reportStatus(status, onStatus);
      if (status.state === "running") {
        return;
      }
      if (status.state === "error" || status.state === "unavailable") {
        throw new Error(status.detail);
      }
      await sleep(1000);
    }
    throw new Error("Timed out waiting for the Linux guest to boot.");
  }

  private async sendHelperCommand(
    command: VmHelperDaemonRequest["command"],
  ): Promise<DesktopVmStatus> {
    if (!existsSync(this.helperPath)) {
      return {
        state: "unavailable",
        detail:
          "VM helper is not built yet. Run `bun run desktop:vm-helper:build` to compile the Swift scaffold.",
        helperPath: this.helperPath,
      };
    }

    await this.ensureHelperDaemon();

    const id = `helper-${++this.helperRequestCounter}`;
    const request: VmHelperDaemonRequest = { id, command };
    const startedAt = Date.now();
    logDesktop(
      "vm",
      "helper_command:send",
      {
        requestId: id,
        command,
      },
      "debug",
    );

    try {
      const response = await this.requestHelperDaemon(
        request,
        this.getHelperCommandTimeout(command),
      );
      const status = this.parseHelperResponse(response);
      this.lastVmStatus = status;
      logDesktop(
        "vm",
        "helper_command:result",
        {
          requestId: id,
          command,
          elapsedMs: Date.now() - startedAt,
          state: status.state,
          detail: status.detail,
        },
        "debug",
      );
      return status;
    } catch (error) {
      logDesktop("vm", "helper_command:error", {
        requestId: id,
        command,
        elapsedMs: Date.now() - startedAt,
        error,
      });
      throw error;
    }
  }

  private getHelperCommandTimeout(
    command: VmHelperDaemonRequest["command"],
  ): number {
    switch (command) {
      case "prepare":
        return DEFAULT_HELPER_PREPARE_TIMEOUT_MS;
      case "start":
        return DEFAULT_HELPER_START_TIMEOUT_MS;
      case "stop":
        return DEFAULT_HELPER_STOP_TIMEOUT_MS;
      case "status":
      default:
        return DEFAULT_HELPER_SOCKET_TIMEOUT_MS;
    }
  }

  private async ensureHelperDaemon(): Promise<void> {
    if (await this.isHelperDaemonReachable()) {
      return;
    }

    if (this.helperDaemonReadyPromise) {
      await this.helperDaemonReadyPromise;
      return;
    }

    this.helperDaemonReadyPromise = this.startHelperDaemon();
    try {
      await this.helperDaemonReadyPromise;
    } finally {
      this.helperDaemonReadyPromise = null;
    }
  }

  private async bootstrapGuestRuntime(options: {
    hostAuthPaths: string[];
    hostAuthSignature: string;
    hostCredentialsJson: string | null;
  }): Promise<void> {
    const shouldSyncHostAuth =
      this.lastHostAuthSignature !== options.hostAuthSignature;
    logDesktop(
      "vm",
      "bootstrap_guest_runtime:start",
      {
        shouldSyncHostAuth,
        authFileCount: options.hostAuthPaths.length,
      },
      "debug",
    );

    if (!shouldSyncHostAuth) {
      return;
    }

    if (shouldSyncHostAuth) {
      logDesktop("vm", "bootstrap_guest_runtime:sync_auth", {}, "debug");
      this.syncHostClaudeConfigToSharedDirectory(
        options.hostAuthPaths,
        options.hostCredentialsJson,
      );
      this.lastHostAuthSignature = options.hostAuthSignature;
    }
  }

  private async startHelperDaemon(): Promise<void> {
    if (
      this.helperDaemonProcess &&
      this.helperDaemonProcess.exitCode === null
    ) {
      await this.waitForHelperDaemonReady();
      return;
    }

    rmSync(this.getHelperSocketPath(), { force: true });

    const child = spawn(this.helperPath, ["daemon", "--json"], {
      stdio: ["ignore", "ignore", "pipe"],
      env: this.getHelperEnv(),
    });
    logDesktop(
      "vm",
      "helper_daemon:spawn",
      {
        helperPath: this.helperPath,
        pid: child.pid,
        socketPath: this.getHelperSocketPath(),
      },
      "debug",
    );

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.lastGuestControlPlaneError = chunk.trim();
      logDesktop(
        "vm",
        "helper_daemon:stderr",
        {
          chunk: chunk.trim(),
        },
        "debug",
      );
    });

    child.on("close", (code, signal) => {
      if (this.helperDaemonProcess === child) {
        this.helperDaemonProcess = null;
      }
      logDesktop("vm", "helper_daemon:exit", {
        code,
        signal,
      });
    });

    this.helperDaemonProcess = child;
    await this.waitForHelperDaemonReady();
  }

  private async waitForHelperDaemonReady(): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < DEFAULT_HELPER_SOCKET_TIMEOUT_MS) {
      if (await this.isHelperDaemonReachable()) {
        return;
      }

      if (
        this.helperDaemonProcess &&
        this.helperDaemonProcess.exitCode !== null
      ) {
        throw new Error(
          `VM helper daemon exited before it became reachable: code=${this.helperDaemonProcess.exitCode ?? "null"}`,
        );
      }
      await sleep(100);
    }

    throw new Error("Timed out waiting for the VM helper daemon socket.");
  }

  private async isHelperDaemonReachable(): Promise<boolean> {
    const socketPath = this.getHelperSocketPath();
    if (!existsSync(socketPath)) {
      return false;
    }

    return new Promise((resolve) => {
      let settled = false;
      const socket = createConnection(socketPath);

      const finish = (value: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();
        resolve(value);
      };

      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      setTimeout(() => finish(false), 250);
    });
  }

  private async requestHelperDaemon(
    request: VmHelperDaemonRequest,
    timeoutMs: number,
  ): Promise<VmHelperResponse> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let buffer = "";
      const socket = createConnection(this.getHelperSocketPath());

      const fail = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();
        reject(error);
      };

      const succeed = (response: VmHelperResponse) => {
        if (settled) {
          return;
        }
        settled = true;
        socket.end();
        resolve(response);
      };

      socket.setEncoding("utf8");
      socket.once("connect", () => {
        socket.write(`${JSON.stringify(request)}\n`);
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) {
          return;
        }

        const line = buffer.slice(0, newlineIndex).trim();
        if (!line) {
          fail(new Error("VM helper daemon returned an empty response."));
          return;
        }

        try {
          const parsed = JSON.parse(line) as VmHelperDaemonResponse;
          if (!parsed.ok || !parsed.result) {
            fail(
              new Error(parsed.error || "VM helper daemon returned an error."),
            );
            return;
          }
          succeed(parsed.result);
        } catch (error) {
          fail(
            error instanceof Error
              ? error
              : new Error("Failed to parse VM helper daemon response."),
          );
        }
      });
      socket.once("error", (error) => {
        fail(
          error instanceof Error
            ? error
            : new Error("Failed to reach the VM helper daemon."),
        );
      });
      socket.once("end", () => {
        if (!settled) {
          fail(new Error("VM helper daemon closed the connection unexpectedly."));
        }
      });
      socket.setTimeout(timeoutMs, () => {
        fail(new Error("Timed out waiting for the VM helper daemon response."));
      });
    });
  }

  private writeGuestControlPlaneEnv(model: string): void {
    this.prepareGuestSharedDirectories();
    const envFileLines = [
      `export DESKTOP_ANTHROPIC_MODEL=${shellQuote(model)}`,
      `export DESKTOP_GUEST_CONTROL_PLANE_PORT=${shellQuote(String(this.guestControlPlanePort))}`,
      "export DESKTOP_GUEST_SDK_DEBUG_FILE='/mnt/camelai-shared/logs/claude-sdk-debug.log'",
      "export HOME='/mnt/camelai-shared/runtime/container-home'",
      "export CLAUDE_CONFIG_DIR='/mnt/camelai-shared/runtime/container-home/.claude'",
      `export DESKTOP_GUEST_CONTROL_PLANE_IMAGE=${shellQuote(DEFAULT_GUEST_CONTROL_PLANE_IMAGE)}`,
    ];

    const anthropicApiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (anthropicApiKey) {
      envFileLines.push(`export ANTHROPIC_API_KEY=${shellQuote(anthropicApiKey)}`);
    }

    const envFile = [...envFileLines, ""].join("\n");
    const runtimeDirectory = resolve(this.vmDirectory, "shared", "runtime");
    mkdirSync(runtimeDirectory, { recursive: true });
    writeFileSync(resolve(runtimeDirectory, "guest-env.sh"), envFile, "utf8");
  }

  private prepareGuestSharedDirectories(): void {
    const sharedRoot = resolve(this.vmDirectory, "shared");
    const writableDirectories = [
      resolve(sharedRoot, "runtime"),
      resolve(sharedRoot, "runtime", "container-home"),
      resolve(sharedRoot, "logs"),
      resolve(sharedRoot, "workspace"),
    ];
    const authHomeDirectory = resolve(sharedRoot, "auth", "home");

    for (const directory of [...writableDirectories, authHomeDirectory]) {
      mkdirSync(directory, { recursive: true });
    }

    for (const directory of writableDirectories) {
      try {
        chmodSync(directory, 0o777);
      } catch {}
    }

    spawnSync(
      "chmod",
      ["-R", "u+rwX,go+rwX", ...writableDirectories],
      {
        env: process.env,
        stdio: "ignore",
      },
    );
  }


  private syncHostClaudeConfigToSharedDirectory(
    existingPaths: string[],
    hostCredentialsJson: string | null,
  ): void {
    const authRoot = resolve(this.vmDirectory, "shared", "auth");
    rmSync(authRoot, { recursive: true, force: true });
    mkdirSync(resolve(authRoot, "home"), { recursive: true });

    if (existingPaths.length > 0) {
      const hostHome = homedir();
      const tarResult = spawnSync(
        "tar",
        ["-C", hostHome, "-cf", "-", ...existingPaths],
        {
          encoding: null,
          env: process.env,
          maxBuffer: 1024 * 1024 * 16,
        },
      );

      if (tarResult.status !== 0 || !tarResult.stdout) {
        const stderr = Buffer.isBuffer(tarResult.stderr)
          ? tarResult.stderr.toString("utf8").trim()
          : String(tarResult.stderr ?? "").trim();
        throw new Error(
          stderr || "Failed to archive the host Claude auth files.",
        );
      }

      const extractResult = spawnSync(
        "tar",
        ["-xf", "-", "-C", resolve(authRoot, "home")],
        {
          encoding: null,
          env: process.env,
          input: tarResult.stdout,
          maxBuffer: 1024 * 1024 * 16,
        },
      );

      if (extractResult.status !== 0) {
        const stderr = Buffer.isBuffer(extractResult.stderr)
          ? extractResult.stderr.toString("utf8").trim()
          : String(extractResult.stderr ?? "").trim();
        throw new Error(
          stderr || "Failed to stage Claude auth files for the guest runtime.",
        );
      }
    }

    if (hostCredentialsJson) {
      const guestClaudeConfigDirectory = resolve(authRoot, "home", ".claude");
      mkdirSync(guestClaudeConfigDirectory, { recursive: true });
      writeFileSync(
        resolve(guestClaudeConfigDirectory, ".credentials.json"),
        hostCredentialsJson,
        "utf8",
      );
    }
  }

  private getExistingHostClaudeAuthPaths(
    hostCredentialsJson: string | null,
  ): string[] {
    const hostHome = homedir();
    const existingPaths = HOST_CLAUDE_SYNC_PATHS.filter((relativePath) =>
      existsSync(resolve(hostHome, relativePath)),
    );

    if (!hostCredentialsJson) {
      if (process.env.ANTHROPIC_API_KEY?.trim()) {
        return existingPaths;
      }
      throw new Error(
        "Claude Code auth was not found on the host. Run `claude auth login` or set ANTHROPIC_API_KEY before starting the desktop VM.",
      );
    }

    return existingPaths;
  }

  private computeHostAuthSignature(
    relativePaths: string[],
    rootDirectory: string,
    hostCredentialsJson: string | null,
  ): string {
    const entries = relativePaths
      .slice()
      .sort()
      .map((relativePath) => {
        const stats = statSync(resolve(rootDirectory, relativePath));
        return `${relativePath}:${stats.size}:${stats.mtimeMs}`;
      });

    entries.push(
      `host-credentials:${hostCredentialsJson ? createHash("sha256").update(hostCredentialsJson).digest("hex") : "missing"}`,
    );

    return createHash("sha256").update(entries.join("\n")).digest("hex");
  }


  private async waitForGuestHealth(
    onStatus?: (status: DesktopVmStatus) => void,
  ): Promise<void> {
    const startedAt = Date.now();
    let lastProgressLogAt = 0;
    while (Date.now() - startedAt < DEFAULT_GUEST_HEALTH_TIMEOUT_MS) {
      const observedStatus = await this.getRuntimeObservedStatus();
      this.reportStatus(observedStatus, onStatus);
      if (this.isTerminalGuestFailureStatus(observedStatus)) {
        logDesktop("vm", "guest_health:terminal_status", {
          elapsedMs: elapsedMs(startedAt),
          state: observedStatus.state,
          detail: observedStatus.detail,
        });
        throw new Error(observedStatus.detail);
      }
      if (this.isApplianceBakedStatus(observedStatus)) {
        if (this.attemptedApplianceRecovery) {
          throw new Error(
            "The guest runtime is stuck on appliance-baked even after re-preparing the local VM clone.",
          );
        }

      this.attemptedApplianceRecovery = true;
      const recoveryStartedAt = Date.now();
      logDesktop(
        "vm",
        "guest_health:recover_from_appliance_baked",
          {
            detail: observedStatus.detail,
            vmDirectory: this.vmDirectory,
        },
        "warn",
      );
      await this.recoverFromApplianceBaked(onStatus);
      logDesktop("vm", "guest_health:recover_from_appliance_baked_complete", {
        elapsedMs: elapsedMs(recoveryStartedAt),
        vmDirectory: this.vmDirectory,
      });
      continue;
    }
      if (observedStatus.state === "running") {
        logDesktop(
          "vm",
          "guest_health:reachable",
          {
            elapsedMs: Date.now() - startedAt,
            localPort: this.getResolvedLocalControlPlanePort(),
          },
          "debug",
        );
        return;
      }
      if (Date.now() - lastProgressLogAt >= 5000) {
        lastProgressLogAt = Date.now();
        logDesktop("vm", "guest_health:waiting", {
          elapsedMs: elapsedMs(startedAt),
          state: observedStatus.state,
          detail: observedStatus.detail,
          localPort: this.getResolvedLocalControlPlanePort(),
        });
      }
      await sleep(500);
    }
    const latestVmStatus = await this.getStatus().catch(() => null);
    logDesktop("vm", "guest_health:timeout", {
      elapsedMs: Date.now() - startedAt,
      lastGuestControlPlaneError: this.lastGuestControlPlaneError,
      latestVmStatus: latestVmStatus?.detail,
    });
    throw new Error(
      latestVmStatus?.detail ||
      this.lastGuestControlPlaneError ||
        "Timed out waiting for the guest Claude control plane health check.",
    );
  }

  private isApplianceBakedStatus(status: DesktopVmStatus): boolean {
    return /guest status:\s*appliance-baked/i.test(status.detail);
  }

  private isTerminalGuestFailureStatus(status: DesktopVmStatus): boolean {
    return /guest status:\s*(runtime-missing-image|runtime-dns-unavailable|runtime-network-unavailable|control-plane-exited)\b/i.test(
      status.detail,
    );
  }

  private async recoverFromApplianceBaked(
    onStatus?: (status: DesktopVmStatus) => void,
  ): Promise<void> {
    const stopped = await this.stopRuntime().catch(() => null);
    if (stopped) {
      this.reportStatus(stopped, onStatus);
    }

    const prepared = await this.prepareRuntime();
    this.reportStatus(prepared, onStatus);
    if (prepared.state === "error" || prepared.state === "unavailable") {
      throw new Error(prepared.detail);
    }

    const started = await this.startRuntime();
    this.reportStatus(started, onStatus);
    if (started.state === "error" || started.state === "unavailable") {
      throw new Error(started.detail);
    }
  }

  private async isGuestHealthReachable(): Promise<boolean> {
    const localPort = this.getResolvedLocalControlPlanePort();
    if (!localPort) {
      return false;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_GUEST_HEALTH_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`http://127.0.0.1:${localPort}/health`, {
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  private getResolvedLocalControlPlanePort(): number | null {
    return this.lastVmStatus?.localProxyPort ?? null;
  }

  private reportStatus(
    status: DesktopVmStatus,
    onStatus?: (status: DesktopVmStatus) => void,
  ): void {
    this.lastVmStatus = status;
    const statusKey = [
      status.state,
      status.detail,
      status.localProxyPort ?? "none",
      status.guestIPAddress ?? "none",
    ].join("|");

    if (statusKey !== this.lastReportedVmStatusKey) {
      this.lastReportedVmStatusKey = statusKey;
      logDesktop("vm", "status:update", {
        state: status.state,
        detail: status.detail,
        localProxyPort: status.localProxyPort,
        guestIPAddress: status.guestIPAddress,
      });
    }

    if (
      !this.warnedAboutApplianceBaked &&
      /guest status:\s*appliance-baked/i.test(status.detail)
    ) {
      this.warnedAboutApplianceBaked = true;
      logDesktop(
        "vm",
        "status:appliance_baked_seen_during_runtime",
        {
          state: status.state,
          detail: status.detail,
          hint:
            "Normal runtime should advance to runtime-ready and control-plane-ready. If it remains on appliance-baked, the guest is stuck after bake and needs investigation.",
        },
        "warn",
      );
    }

    if (!/guest status:\s*appliance-baked/i.test(status.detail)) {
      this.warnedAboutApplianceBaked = false;
    }

    onStatus?.(status);
  }

  private parseHelperResponse(parsed: VmHelperResponse): DesktopVmStatus {
    return {
      state: parsed.state ?? "unavailable",
      detail: parsed.detail ?? "VM helper returned no detail.",
      helperPath: parsed.helperPath ?? this.helperPath,
      prepared: parsed.prepared ?? false,
      vmDirectory: parsed.vmDirectory ?? null,
      diskPath: parsed.diskPath ?? null,
      instanceName: parsed.instanceName ?? null,
      localProxyPort: parsed.localProxyPort ?? null,
      guestIPAddress: parsed.guestIPAddress ?? null,
    };
  }

}
