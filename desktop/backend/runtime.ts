import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DesktopRuntimeStatus } from "../shared/protocol";
import type { DesktopProviderDefinition } from "./provider-types";
import { logDesktop } from "./log";

const backendDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(backendDirectory, "..");
const DEFAULT_RUNTIME_DIRECTORY = resolve(desktopDirectory, ".local/runtime");
const DEFAULT_HELPER_PATH = resolve(
  desktopDirectory,
  "runtime-helper/.build/debug/camelai-runtime-helper",
);
const DEFAULT_RUNTIME_KERNEL_PATH = resolve(
  desktopDirectory,
  "runtime-helper/assets/vmlinux",
);
const DEFAULT_INSTANCE_NAME =
  process.env.DESKTOP_RUNTIME_INSTANCE_NAME || "camelai-desktop";
const DEFAULT_RUNTIME_CONTROL_PLANE_PORT = Number(
  process.env.DESKTOP_RUNTIME_CONTROL_PLANE_PORT || 4317,
);
const DEFAULT_RUNTIME_BOOT_TIMEOUT_MS = Number(
  process.env.DESKTOP_RUNTIME_BOOT_TIMEOUT_MS || 120000,
);
const DEFAULT_CONTROL_PLANE_HEALTH_TIMEOUT_MS = Number(
  process.env.DESKTOP_CONTROL_PLANE_HEALTH_TIMEOUT_MS || 300000,
);
const DEFAULT_CONTROL_PLANE_HEALTH_REQUEST_TIMEOUT_MS = Number(
  process.env.DESKTOP_CONTROL_PLANE_HEALTH_REQUEST_TIMEOUT_MS || 2000,
);
const DEFAULT_HELPER_SOCKET_TIMEOUT_MS = Number(
  process.env.DESKTOP_RUNTIME_HELPER_SOCKET_TIMEOUT_MS || 5000,
);
const DEFAULT_HELPER_PREPARE_TIMEOUT_MS = Number(
  process.env.DESKTOP_RUNTIME_HELPER_PREPARE_TIMEOUT_MS || 15 * 60 * 1000,
);
const DEFAULT_HELPER_START_TIMEOUT_MS = Number(
  process.env.DESKTOP_RUNTIME_HELPER_START_TIMEOUT_MS || 10 * 60 * 1000,
);
const DEFAULT_HELPER_STOP_TIMEOUT_MS = Number(
  process.env.DESKTOP_RUNTIME_HELPER_STOP_TIMEOUT_MS || 30000,
);
const KEEP_RUNTIME_ON_DISPOSE =
  process.env.DESKTOP_RUNTIME_SHUTDOWN_ON_EXIT !== "1";
const LOCAL_CONTROL_PLANE_BASENAME = "control-plane.mjs";
const HOST_CA_BUNDLE_CANDIDATES = [
  process.env.SSL_CERT_FILE?.trim() || "",
  "/etc/ssl/cert.pem",
  "/private/etc/ssl/cert.pem",
  "/etc/ssl/certs/ca-certificates.crt",
].filter(Boolean);

interface RuntimeHelperResponse {
  state?: DesktopRuntimeStatus["state"];
  detail?: string;
  helperPath?: string | null;
  prepared?: boolean;
  runtimeDirectory?: string | null;
  containerID?: string | null;
  controlPlaneAddress?: string | null;
  controlPlanePort?: number | null;
  imageReference?: string | null;
}

interface RuntimeHelperDaemonRequest {
  id: string;
  command: "status" | "prepare" | "start" | "stop";
}

interface RuntimeHelperDaemonResponse {
  id?: string | null;
  ok?: boolean;
  result?: RuntimeHelperResponse;
  error?: string | null;
}

interface RuntimeHelperMetadata {
  pid?: number;
  helperPath?: string | null;
  helperMtimeMs?: number | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function elapsedMs(startedAt: number): number {
  return Date.now() - startedAt;
}

function makePathWritableForContainerUser(targetPath: string): void {
  let stats;
  try {
    stats = lstatSync(targetPath);
  } catch {
    return;
  }

  if (stats.isSymbolicLink()) {
    return;
  }

  try {
    const existingMode = stats.mode & 0o777;
    let writableMode = existingMode | 0o666;
    if (stats.isDirectory()) {
      writableMode |= 0o111;
    } else if ((existingMode & 0o111) !== 0) {
      writableMode |= 0o111;
    }
    chmodSync(targetPath, writableMode);
  } catch {
    // Best effort only.
  }

  if (!stats.isDirectory()) {
    return;
  }

  let entries: string[];
  try {
    entries = readdirSync(targetPath);
  } catch {
    return;
  }

  for (const entry of entries) {
    makePathWritableForContainerUser(resolve(targetPath, entry));
  }
}

export class RuntimeManager {
  private readonly helperPath: string;
  private readonly instanceName: string;
  private readonly controlPlanePort: number;
  private readonly runtimeDirectory: string;
  private readonly runtimeKernelPath: string;
  private helperDaemonProcess: ReturnType<typeof spawn> | null = null;
  private helperRequestCounter = 0;
  private helperDaemonReadyPromise: Promise<void> | null = null;
  private lastControlPlaneError = "";
  private lastRuntimeStatus: DesktopRuntimeStatus | null = null;
  private lastReportedRuntimeStatusKey: string | null = null;

  constructor(
    helperPath =
      process.env.DESKTOP_RUNTIME_HELPER_PATH || DEFAULT_HELPER_PATH,
  ) {
    this.helperPath = helperPath;
    this.instanceName = DEFAULT_INSTANCE_NAME;
    this.controlPlanePort = DEFAULT_RUNTIME_CONTROL_PLANE_PORT;
    this.runtimeDirectory =
      process.env.DESKTOP_RUNTIME_DIR || DEFAULT_RUNTIME_DIRECTORY;
    this.runtimeKernelPath =
      process.env.DESKTOP_RUNTIME_KERNEL_PATH || DEFAULT_RUNTIME_KERNEL_PATH;
  }

  getHelperPath(): string {
    return this.helperPath;
  }

  dispose(): void {
    if (!KEEP_RUNTIME_ON_DISPOSE) {
      this.helperDaemonProcess?.kill("SIGTERM");
    }
    this.helperDaemonProcess = null;
    this.helperDaemonReadyPromise = null;
  }

  getControlPlaneHttpUrl(): string {
    const host = this.lastRuntimeStatus?.controlPlaneAddress;
    const port =
      this.lastRuntimeStatus?.controlPlanePort ?? this.controlPlanePort;
    if (!host) {
      throw new Error(
        "The control-plane container has not published a reachable address yet.",
      );
    }
    return `http://${host}:${port}`;
  }

  private getHelperEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      DESKTOP_RUNTIME_DIR: this.runtimeDirectory,
      DESKTOP_RUNTIME_INSTANCE_NAME: this.instanceName,
      DESKTOP_RUNTIME_CONTROL_PLANE_PORT: String(this.controlPlanePort),
      DESKTOP_RUNTIME_KERNEL_PATH: this.runtimeKernelPath,
    };
  }

  private getHelperSocketPath(): string {
    return resolve(this.runtimeDirectory, "artifacts/helper.sock");
  }

  private getHelperPIDPath(): string {
    return resolve(this.runtimeDirectory, "artifacts/helper.pid");
  }

  private getHelperMetadataPath(): string {
    return resolve(this.runtimeDirectory, "artifacts/helper-metadata.json");
  }

  private getSharedRootPath(): string {
    return resolve(this.runtimeDirectory, "shared");
  }

  private getRuntimeRootPath(): string {
    return resolve(this.getSharedRootPath(), "runtime");
  }

  private getControlPlaneEnvPath(): string {
    return resolve(this.getRuntimeRootPath(), "control-plane-env.sh");
  }

  private getControlPlaneHomePath(): string {
    return resolve(this.getRuntimeRootPath(), "container-home");
  }

  private getRuntimeCABundlePath(): string {
    return resolve(this.getRuntimeRootPath(), "ca-certificates.pem");
  }

  getCachedStatus(): DesktopRuntimeStatus {
    if (!existsSync(this.helperPath)) {
      return {
        state: "unavailable",
        detail:
          "Runtime helper is not built yet. Run `bun run desktop:runtime-helper:build` to compile the Swift helper.",
        helperPath: this.helperPath,
      };
    }

    if (!existsSync(this.runtimeKernelPath)) {
      return {
        state: "unavailable",
        detail:
          "Runtime kernel is not available yet. Run `bun run desktop:runtime-helper:build` to fetch and stage it.",
        helperPath: this.helperPath,
      };
    }

    return {
      state: "stopped",
      detail:
        "Runtime inputs are ready locally. The desktop app can start the control-plane container image.",
      helperPath: this.helperPath,
    };
  }

  async getStatus(): Promise<DesktopRuntimeStatus> {
    return this.sendHelperCommand("status");
  }

  async startRuntime(): Promise<DesktopRuntimeStatus> {
    const status = await this.sendHelperCommand("start");
    this.lastRuntimeStatus = status;
    return status;
  }

  async stopRuntime(): Promise<DesktopRuntimeStatus> {
    const status = await this.sendHelperCommand("stop");
    this.lastRuntimeStatus = status;
    return status;
  }

  async getRuntimeObservedStatus(): Promise<DesktopRuntimeStatus> {
    const status = await this.getStatus();
    if (status.state !== "running") {
      return status;
    }

    if (await this.isControlPlaneHealthReachable()) {
      return status;
    }

    return {
      ...status,
      state: "starting",
      detail: `The control-plane container is running. Waiting for GET /health on http://${status.controlPlaneAddress}:${status.controlPlanePort ?? this.controlPlanePort} to respond.`,
    };
  }

  async ensureControlPlaneRuntime(
    provider: DesktopProviderDefinition,
    model: string,
    onStatus?: (status: DesktopRuntimeStatus) => void,
  ): Promise<DesktopRuntimeStatus> {
    const startedAt = Date.now();
    const phaseTimings: Record<string, number> = {};

    logDesktop(
      "runtime",
      "ensure_control_plane_runtime:start",
      {
        provider: provider.id,
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

    if (status.state === "unavailable" || status.state === "error") {
      throw new Error(status.detail);
    }

    phaseStartedAt = Date.now();
    const initialHealthReachable =
      status.state === "running"
        ? await this.probeControlPlaneHealthReachable(status, 3, 500)
        : false;
    phaseTimings.initialHealthProbeMs = elapsedMs(phaseStartedAt);

    phaseStartedAt = Date.now();
    this.prepareRuntimeDirectories();
    this.stageHostCertificates();
    this.writeControlPlaneEnv(provider, model);
    this.syncLocalControlPlaneOverride();
    provider.stageRuntimeHome(this.getControlPlaneHomePath());
    makePathWritableForContainerUser(this.getControlPlaneHomePath());
    phaseTimings.stageRuntimeInputsMs = elapsedMs(phaseStartedAt);

    this.reportStatus(
      {
        ...status,
        state: "starting",
        detail:
          `Prepared the runtime workspace, synced ${provider.label} auth, and wrote the container environment. Starting the container next.`,
      },
      onStatus,
    );

    if (status.state === "running" && !initialHealthReachable) {
      logDesktop("runtime", "control_plane_health:restart_required", {
        provider: provider.id,
        model,
        state: status.state,
        detail: status.detail,
        controlPlaneAddress: status.controlPlaneAddress,
        controlPlanePort: status.controlPlanePort,
      });
      this.reportStatus(
        {
          ...status,
          state: "starting",
          detail:
            "The existing local runtime did not answer GET /health. Restarting the control-plane container.",
        },
        onStatus,
      );

      phaseStartedAt = Date.now();
      status = await this.stopRuntime();
      phaseTimings.restartStopMs = elapsedMs(phaseStartedAt);
      this.reportStatus(status, onStatus);

      if (status.state === "unavailable" || status.state === "error") {
        throw new Error(status.detail);
      }

      phaseStartedAt = Date.now();
      status = await this.sendHelperCommand("start");
      phaseTimings.restartStartMs = elapsedMs(phaseStartedAt);
      this.reportStatus(status, onStatus);

      if (status.state === "unavailable" || status.state === "error") {
        throw new Error(status.detail);
      }
    } else if (status.state !== "running") {
      phaseStartedAt = Date.now();
      status = await this.sendHelperCommand("start");
      phaseTimings.startCommandMs = elapsedMs(phaseStartedAt);
      this.reportStatus(status, onStatus);

      if (status.state === "unavailable" || status.state === "error") {
        throw new Error(status.detail);
      }
    }

    phaseStartedAt = Date.now();
    await this.waitForRuntimeRunning(onStatus);
    phaseTimings.waitForRuntimeRunningMs = elapsedMs(phaseStartedAt);

    phaseStartedAt = Date.now();
    await this.waitForControlPlaneHealth(onStatus);
    phaseTimings.waitForControlPlaneHealthMs = elapsedMs(phaseStartedAt);

    phaseStartedAt = Date.now();
    const finalStatus = await this.getRuntimeObservedStatus();
    phaseTimings.finalObservedStatusMs = elapsedMs(phaseStartedAt);
    this.reportStatus(finalStatus, onStatus);

    logDesktop("runtime", "ensure_control_plane_runtime:success", {
      provider: provider.id,
      model,
      elapsedMs: elapsedMs(startedAt),
      state: finalStatus.state,
      detail: finalStatus.detail,
      phaseTimings,
    });

    return finalStatus;
  }

  private prepareRuntimeDirectories(): void {
    const writableDirectories = [
      resolve(this.getSharedRootPath(), "logs"),
      resolve(this.getRuntimeRootPath()),
      resolve(this.getControlPlaneHomePath()),
      resolve(this.getSharedRootPath(), "workspace"),
    ];

    for (const directory of writableDirectories) {
      mkdirSync(directory, { recursive: true });
      makePathWritableForContainerUser(directory);
    }
  }

  private writeControlPlaneEnv(
    provider: DesktopProviderDefinition,
    model: string,
  ): void {
    const lines = provider.buildControlPlaneEnv(model, this.controlPlanePort);
    writeFileSync(this.getControlPlaneEnvPath(), `${lines.join("\n")}\n`, "utf8");
    makePathWritableForContainerUser(this.getControlPlaneEnvPath());
  }

  private stageHostCertificates(): void {
    const sourcePath = HOST_CA_BUNDLE_CANDIDATES.find((candidate) =>
      existsSync(candidate),
    );
    if (!sourcePath) {
      return;
    }

    const destinationPath = this.getRuntimeCABundlePath();
    mkdirSync(dirname(destinationPath), { recursive: true });
    cpSync(sourcePath, destinationPath, { force: true });
    makePathWritableForContainerUser(destinationPath);
  }

  private syncLocalControlPlaneOverride(): void {
    const sourcePath =
      process.env.DESKTOP_RUNTIME_LOCAL_CONTROL_PLANE_SOURCE?.trim();
    const overrideDirectory = resolve(this.getRuntimeRootPath(), "dev-control-plane");
    const overrideTargetPath = resolve(
      overrideDirectory,
      LOCAL_CONTROL_PLANE_BASENAME,
    );

    if (!sourcePath) {
      rmSync(overrideDirectory, { recursive: true, force: true });
      return;
    }

    if (!existsSync(sourcePath)) {
      throw new Error(
        `Local desktop control-plane override was configured but not found: ${sourcePath}`,
      );
    }

    mkdirSync(overrideDirectory, { recursive: true });
    cpSync(sourcePath, overrideTargetPath, { force: true });

    const sourceDirectory = dirname(sourcePath);
    for (const companionName of ["package.json", "package-lock.json", "node_modules"] as const) {
      const companionSourcePath = resolve(sourceDirectory, companionName);
      if (!existsSync(companionSourcePath)) {
        continue;
      }
      rmSync(resolve(overrideDirectory, companionName), {
        recursive: true,
        force: true,
      });
      cpSync(
        companionSourcePath,
        resolve(overrideDirectory, companionName),
        { force: true, recursive: true },
      );
    }

    makePathWritableForContainerUser(overrideDirectory);
  }

  private async waitForRuntimeRunning(
    onStatus?: (status: DesktopRuntimeStatus) => void,
  ): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < DEFAULT_RUNTIME_BOOT_TIMEOUT_MS) {
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
    throw new Error("Timed out waiting for the local runtime to start.");
  }

  private async waitForControlPlaneHealth(
    onStatus?: (status: DesktopRuntimeStatus) => void,
  ): Promise<void> {
    const startedAt = Date.now();
    let lastProgressLogAt = 0;

    while (Date.now() - startedAt < DEFAULT_CONTROL_PLANE_HEALTH_TIMEOUT_MS) {
      const observedStatus = await this.getRuntimeObservedStatus();
      this.reportStatus(observedStatus, onStatus);

      if (
        observedStatus.state === "error" ||
        observedStatus.state === "unavailable"
      ) {
        throw new Error(observedStatus.detail);
      }
      if (observedStatus.state === "running") {
        return;
      }

      if (Date.now() - lastProgressLogAt >= 5000) {
        lastProgressLogAt = Date.now();
        logDesktop("runtime", "control_plane_health:waiting", {
          elapsedMs: elapsedMs(startedAt),
          state: observedStatus.state,
          detail: observedStatus.detail,
          controlPlaneAddress: observedStatus.controlPlaneAddress,
        });
      }

      await sleep(500);
    }

    const latestRuntimeStatus = await this.getStatus().catch(() => null);
    throw new Error(
      latestRuntimeStatus?.detail ||
        this.lastControlPlaneError ||
        "Timed out waiting for the control-plane health check.",
    );
  }

  private async sendHelperCommand(
    command: RuntimeHelperDaemonRequest["command"],
  ): Promise<DesktopRuntimeStatus> {
    if (!existsSync(this.helperPath)) {
      return {
        state: "unavailable",
        detail:
          "Runtime helper is not built yet. Run `bun run desktop:runtime-helper:build` to compile the Swift helper.",
        helperPath: this.helperPath,
      };
    }

    await this.ensureHelperDaemon();

    const request: RuntimeHelperDaemonRequest = {
      id: `helper-${++this.helperRequestCounter}`,
      command,
    };

    try {
      const response = await this.requestHelperDaemon(
        request,
        this.getHelperCommandTimeout(command),
      );
      const status = this.parseHelperResponse(response);
      this.lastRuntimeStatus = status;
      return status;
    } catch (error) {
      logDesktop("runtime", "helper_command:error", {
        requestId: request.id,
        command,
        error,
      });
      throw error;
    }
  }

  private getHelperCommandTimeout(
    command: RuntimeHelperDaemonRequest["command"],
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
      if (this.helperDaemonMatchesCurrentBuild()) {
        return;
      }
      this.resetExistingHelperDaemon();
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

  private helperDaemonMatchesCurrentBuild(): boolean {
    const metadata = this.readHelperMetadata();
    if (!metadata) {
      return false;
    }

    const expectedHelperPath = this.helperPath;
    const expectedHelperMtimeMs = existsSync(expectedHelperPath)
      ? Math.trunc(statSync(expectedHelperPath).mtimeMs)
      : null;

    return (
      metadata.helperPath === expectedHelperPath &&
      metadata.helperMtimeMs === expectedHelperMtimeMs
    );
  }

  private readHelperMetadata(): RuntimeHelperMetadata | null {
    const metadataPath = this.getHelperMetadataPath();
    if (!existsSync(metadataPath)) {
      return null;
    }

    try {
      return JSON.parse(readFileSync(metadataPath, "utf8")) as RuntimeHelperMetadata;
    } catch {
      return null;
    }
  }

  private resetExistingHelperDaemon(): void {
    const pidPath = this.getHelperPIDPath();
    const socketPath = this.getHelperSocketPath();

    if (existsSync(pidPath)) {
      try {
        const pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
        if (Number.isFinite(pid)) {
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            // Best effort only.
          }
        }
      } catch {
        // Ignore unreadable pid files.
      }
    }

    rmSync(socketPath, { force: true });
    rmSync(this.getHelperMetadataPath(), { force: true });
    this.helperDaemonProcess = null;
  }

  private async startHelperDaemon(): Promise<void> {
    rmSync(this.getHelperSocketPath(), { force: true });

    const child = spawn(this.helperPath, ["daemon", "--json"], {
      stdio: ["ignore", "ignore", "pipe"],
      env: this.getHelperEnv(),
      detached: KEEP_RUNTIME_ON_DISPOSE,
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.lastControlPlaneError = chunk.trim();
      logDesktop(
        "runtime",
        "helper_daemon:stderr",
        { chunk: chunk.trim() },
        "debug",
      );
    });

    child.on("close", (code, signal) => {
      if (this.helperDaemonProcess === child) {
        this.helperDaemonProcess = null;
      }
      logDesktop("runtime", "helper_daemon:exit", { code, signal });
    });

    if (KEEP_RUNTIME_ON_DISPOSE) {
      child.unref();
    }

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
          `Runtime helper daemon exited before it became reachable: code=${this.helperDaemonProcess.exitCode ?? "null"}`,
        );
      }

      await sleep(100);
    }

    throw new Error("Timed out waiting for the runtime helper daemon socket.");
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
    request: RuntimeHelperDaemonRequest,
    timeoutMs: number,
  ): Promise<RuntimeHelperResponse> {
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

      const succeed = (response: RuntimeHelperResponse) => {
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
          fail(new Error("Runtime helper daemon returned an empty response."));
          return;
        }

        try {
          const parsed = JSON.parse(line) as RuntimeHelperDaemonResponse;
          if (!parsed.ok || !parsed.result) {
            fail(
              new Error(parsed.error || "Runtime helper daemon returned an error."),
            );
            return;
          }
          succeed(parsed.result);
        } catch (error) {
          fail(
            error instanceof Error
              ? error
              : new Error("Failed to parse runtime helper daemon response."),
          );
        }
      });
      socket.once("error", (error) => {
        fail(
          error instanceof Error
            ? error
            : new Error("Failed to reach the runtime helper daemon."),
        );
      });
      socket.once("end", () => {
        if (!settled) {
          fail(new Error("Runtime helper daemon closed the connection unexpectedly."));
        }
      });
      socket.setTimeout(timeoutMs, () => {
        fail(new Error("Timed out waiting for the runtime helper daemon response."));
      });
    });
  }

  private async probeControlPlaneHealthReachable(
    status: DesktopRuntimeStatus | null = this.lastRuntimeStatus,
    attempts = 1,
    delayMs = 0,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (await this.isControlPlaneHealthReachable(status)) {
        return true;
      }
      if (attempt < attempts - 1 && delayMs > 0) {
        await sleep(delayMs);
      }
    }
    return false;
  }

  private async isControlPlaneHealthReachable(
    status: DesktopRuntimeStatus | null = this.lastRuntimeStatus,
  ): Promise<boolean> {
    const address = status?.controlPlaneAddress;
    const port = status?.controlPlanePort ?? this.controlPlanePort;
    if (!address) {
      return false;
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      DEFAULT_CONTROL_PLANE_HEALTH_REQUEST_TIMEOUT_MS,
    );

    try {
      const response = await fetch(`http://${address}:${port}/health`, {
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  private reportStatus(
    status: DesktopRuntimeStatus,
    onStatus?: (status: DesktopRuntimeStatus) => void,
  ): void {
    this.lastRuntimeStatus = status;
    const statusKey = [
      status.state,
      status.detail,
      status.controlPlaneAddress ?? "none",
      status.controlPlanePort ?? "none",
    ].join("|");

    if (statusKey !== this.lastReportedRuntimeStatusKey) {
      this.lastReportedRuntimeStatusKey = statusKey;
      logDesktop("runtime", "status:update", {
        state: status.state,
        detail: status.detail,
        controlPlaneAddress: status.controlPlaneAddress,
        controlPlanePort: status.controlPlanePort,
      });
    }

    onStatus?.(status);
  }

  private parseHelperResponse(parsed: RuntimeHelperResponse): DesktopRuntimeStatus {
    return {
      state: parsed.state ?? "unavailable",
      detail: parsed.detail ?? "Runtime helper returned no detail.",
      helperPath: parsed.helperPath ?? this.helperPath,
      prepared: parsed.prepared ?? false,
      runtimeDirectory: parsed.runtimeDirectory ?? null,
      containerID: parsed.containerID ?? null,
      controlPlaneAddress: parsed.controlPlaneAddress ?? null,
      controlPlanePort: parsed.controlPlanePort ?? null,
      imageReference: parsed.imageReference ?? null,
    };
  }
}
