import Foundation
import Darwin
#if canImport(Virtualization)
import Virtualization
#endif

struct HelperConfig: Codable {
    let runtimeVersion: String
    let instanceName: String
    let cpuCount: Int
    let memoryMiB: Int
    let diskGiB: Int
    let sharedDirectory: String
    let diskPath: String
    let cloudInitImagePath: String
    let guestAddressPath: String
    let guestStatusPath: String
    let guestUser: String
}

struct HelperState: Codable {
    let prepared: Bool
    let preparedAt: String?
    let lastCommand: String
}

struct HelperResponse: Codable {
    let state: String
    let detail: String
    let helperPath: String?
    let prepared: Bool
    let vmDirectory: String?
    let diskPath: String?
    let instanceName: String?
    let localProxyPort: Int?
    let guestIPAddress: String?
}

struct HelperDaemonRequest: Decodable {
    let id: String
    let command: String
}

struct HelperDaemonResponse: Encodable {
    let id: String
    let ok: Bool
    let result: HelperResponse?
    let error: String?
}

enum HelperCommand: String {
    case status
    case prepare
    case start
    case stop
    case daemon
}

let diskSizeGiB = Int(ProcessInfo.processInfo.environment["DESKTOP_VM_DISK_GIB"] ?? "64") ?? 64
let memoryMiB = Int(ProcessInfo.processInfo.environment["DESKTOP_VM_MEMORY_MIB"] ?? "8192") ?? 8192
let requestedCpuCount = Int(ProcessInfo.processInfo.environment["DESKTOP_VM_CPUS"] ?? "4") ?? 4
let instanceName = ProcessInfo.processInfo.environment["DESKTOP_VM_INSTANCE_NAME"] ?? "camelai-desktop"
let guestUser = ProcessInfo.processInfo.environment["DESKTOP_VM_GUEST_USER"] ?? "camelai"
let sharedTag = "camelai-shared"
let bakeApplianceImage = ProcessInfo.processInfo.environment["DESKTOP_VM_BAKE_APPLIANCE"] == "1"
let helperRuntimeVersionBase = "20260402-avf-ubuntu-guest-appliance-runtime-v18"
let helperRuntimeVersion = bakeApplianceImage
    ? "\(helperRuntimeVersionBase)-bake"
    : helperRuntimeVersionBase
let guestControlPlanePort = Int(ProcessInfo.processInfo.environment["DESKTOP_GUEST_CONTROL_PLANE_PORT"] ?? "4317") ?? 4317
let localControlPlanePort = UInt16(Int(ProcessInfo.processInfo.environment["DESKTOP_GUEST_LOCAL_CONTROL_PLANE_PORT"] ?? "4381") ?? 4381)
func writeJSONLine<T: Encodable>(_ value: T, prettyPrinted: Bool) throws {
    let encoder = JSONEncoder()
    if prettyPrinted {
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    }
    let data = try encoder.encode(value)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func emitAndExit(_ response: HelperResponse) -> Never {
    try! writeJSONLine(response, prettyPrinted: true)
    exit(EXIT_SUCCESS)
}

func failure(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(EXIT_FAILURE)
}

func repoRoot() -> URL {
    URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
}

func vmDirectoryURL() -> URL {
    if let configured = ProcessInfo.processInfo.environment["DESKTOP_VM_DIR"], !configured.isEmpty {
        return URL(fileURLWithPath: configured, isDirectory: true)
    }
    return repoRoot()
        .appendingPathComponent("desktop", isDirectory: true)
        .appendingPathComponent(".local", isDirectory: true)
        .appendingPathComponent("vm", isDirectory: true)
}

func configURL() -> URL {
    vmDirectoryURL().appendingPathComponent("config.json")
}

func stateURL() -> URL {
    vmDirectoryURL().appendingPathComponent("state.json")
}

func diskURL() -> URL {
    vmDirectoryURL().appendingPathComponent("disk.raw")
}

func sharedDirectoryURL() -> URL {
    vmDirectoryURL().appendingPathComponent("shared", isDirectory: true)
}

func artifactsDirectoryURL() -> URL {
    vmDirectoryURL().appendingPathComponent("artifacts", isDirectory: true)
}

func cloudInitSeedDirectoryURL() -> URL {
    artifactsDirectoryURL().appendingPathComponent("cloud-init", isDirectory: true)
}

func cloudInitISOURL() -> URL {
    artifactsDirectoryURL().appendingPathComponent("cloud-init.iso")
}

func efiVariableStoreURL() -> URL {
    artifactsDirectoryURL().appendingPathComponent("efi-variable-store")
}

func machineIdentifierURL() -> URL {
    artifactsDirectoryURL().appendingPathComponent("machine-identifier")
}

func guestStateDirectoryURL() -> URL {
    sharedDirectoryURL().appendingPathComponent("runtime", isDirectory: true)
}

func guestAddressURL() -> URL {
    guestStateDirectoryURL().appendingPathComponent("guest-ip.txt")
}

func guestStatusURL() -> URL {
    guestStateDirectoryURL().appendingPathComponent("status.txt")
}

func serialConsoleLogURL() -> URL {
    artifactsDirectoryURL().appendingPathComponent("serial-console.log")
}

func helperPIDURL() -> URL {
    artifactsDirectoryURL().appendingPathComponent("helper.pid")
}

func helperSocketURL() -> URL {
    artifactsDirectoryURL().appendingPathComponent("helper.sock")
}

func ensureDirectory(_ url: URL) throws {
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
}

func persistJSON<T: Encodable>(_ value: T, to url: URL) throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    let data = try encoder.encode(value)
    try data.write(to: url, options: [.atomic])
}

func setNonBlocking(_ fileDescriptor: Int32) throws {
    let currentFlags = fcntl(fileDescriptor, F_GETFL)
    if currentFlags == -1 {
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    if fcntl(fileDescriptor, F_SETFL, currentFlags | O_NONBLOCK) == -1 {
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
}

@discardableResult
func writeAll(to fileDescriptor: Int32, buffer: UnsafeRawBufferPointer) throws -> Int {
    var totalWritten = 0
    while totalWritten < buffer.count {
        let written = Darwin.write(
            fileDescriptor,
            buffer.baseAddress!.advanced(by: totalWritten),
            buffer.count - totalWritten
        )
        if written > 0 {
            totalWritten += Int(written)
            continue
        }
        if written == -1 && (errno == EAGAIN || errno == EWOULDBLOCK) {
            usleep(1_000)
            continue
        }
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    return totalWritten
}

#if canImport(Virtualization)
@available(macOS 13.0, *)
final class VsockProxyConnection {
    let id = UUID()

    private enum Direction {
        case localToRemote
        case remoteToLocal
    }

    private let localFD: Int32
    private let remoteConnection: VZVirtioSocketConnection
    private let remoteFD: Int32
    private let queue: DispatchQueue
    private let onClose: (UUID) -> Void
    private var localSource: DispatchSourceRead?
    private var remoteSource: DispatchSourceRead?
    private var closed = false
    private var localReadClosed = false
    private var remoteReadClosed = false

    init(
        localFD: Int32,
        remoteConnection: VZVirtioSocketConnection,
        queue: DispatchQueue,
        onClose: @escaping (UUID) -> Void
    ) throws {
        self.localFD = localFD
        self.remoteConnection = remoteConnection
        self.remoteFD = remoteConnection.fileDescriptor
        self.queue = queue
        self.onClose = onClose
        try setNonBlocking(localFD)
        try setNonBlocking(remoteFD)
    }

    func start() {
        localSource = makeReadSource(
            sourceFD: localFD,
            targetFD: remoteFD,
            direction: .localToRemote
        )
        remoteSource = makeReadSource(
            sourceFD: remoteFD,
            targetFD: localFD,
            direction: .remoteToLocal
        )
        localSource?.resume()
        remoteSource?.resume()
    }

    func shutdown() {
        close()
    }

    private func makeReadSource(
        sourceFD: Int32,
        targetFD: Int32,
        direction: Direction
    ) -> DispatchSourceRead {
        let source = DispatchSource.makeReadSource(fileDescriptor: sourceFD, queue: queue)
        source.setEventHandler { [weak self] in
            self?.forward(from: sourceFD, to: targetFD, direction: direction)
        }
        source.setCancelHandler {}
        return source
    }

    private func forward(from sourceFD: Int32, to targetFD: Int32, direction: Direction) {
        var buffer = [UInt8](repeating: 0, count: 32 * 1024)
        let bytesRead = Darwin.read(sourceFD, &buffer, buffer.count)
        if bytesRead > 0 {
            do {
                try buffer.withUnsafeBytes { rawBuffer in
                    let slice = UnsafeRawBufferPointer(
                        start: rawBuffer.baseAddress,
                        count: Int(bytesRead)
                    )
                    _ = try writeAll(to: targetFD, buffer: slice)
                }
            } catch {
                close()
            }
            return
        }

        if bytesRead == 0 {
            handleEOF(direction: direction, targetFD: targetFD)
            return
        }

        if errno != EAGAIN && errno != EWOULDBLOCK {
            close()
        }
    }

    private func handleEOF(direction: Direction, targetFD: Int32) {
        switch direction {
        case .localToRemote:
            if localReadClosed {
                return
            }
            localReadClosed = true
            localSource?.cancel()
            localSource = nil
        case .remoteToLocal:
            if remoteReadClosed {
                return
            }
            remoteReadClosed = true
            remoteSource?.cancel()
            remoteSource = nil
        }

        _ = Darwin.shutdown(targetFD, SHUT_WR)

        if localReadClosed && remoteReadClosed {
            close()
        }
    }

    private func close() {
        if closed {
            return
        }
        closed = true
        localSource?.cancel()
        remoteSource?.cancel()
        localSource = nil
        remoteSource = nil
        Darwin.close(localFD)
        remoteConnection.close()
        onClose(id)
    }
}
#endif

func loadState() -> HelperState? {
    guard let data = try? Data(contentsOf: stateURL()) else {
        return nil
    }
    return try? JSONDecoder().decode(HelperState.self, from: data)
}

func loadConfig() -> HelperConfig? {
    guard let data = try? Data(contentsOf: configURL()) else {
        return nil
    }
    return try? JSONDecoder().decode(HelperConfig.self, from: data)
}

func runProcess(_ launchPath: String, _ arguments: [String], input: Data? = nil) throws -> (status: Int32, stdout: String, stderr: String) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: launchPath)
    process.arguments = arguments

    let stdoutPipe = Pipe()
    let stderrPipe = Pipe()
    process.standardOutput = stdoutPipe
    process.standardError = stderrPipe

    if let input {
        let stdinPipe = Pipe()
        process.standardInput = stdinPipe
        try process.run()
        stdinPipe.fileHandleForWriting.write(input)
        try stdinPipe.fileHandleForWriting.close()
    } else {
        try process.run()
    }

    process.waitUntilExit()

    let stdoutData = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
    let stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
    return (
        status: process.terminationStatus,
        stdout: String(decoding: stdoutData, as: UTF8.self),
        stderr: String(decoding: stderrData, as: UTF8.self)
    )
}

func which(_ name: String) -> String? {
    let paths = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map(String.init)
    for path in paths {
        let candidate = URL(fileURLWithPath: path).appendingPathComponent(name).path
        if FileManager.default.isExecutableFile(atPath: candidate) {
            return candidate
        }
    }
    return nil
}

func frameworkAvailable() -> Bool {
#if canImport(Virtualization)
    return true
#else
    return false
#endif
}

func preparedState() -> Bool {
    loadState()?.prepared == true
        && FileManager.default.fileExists(atPath: diskURL().path)
        && loadConfig()?.runtimeVersion == helperRuntimeVersion
}

func applianceImageURL() -> URL? {
    guard let appliancePath = ProcessInfo.processInfo.environment["DESKTOP_VM_APPLIANCE_IMAGE_PATH"]?
        .trimmingCharacters(in: .whitespacesAndNewlines),
        !appliancePath.isEmpty
    else {
        return nil
    }

    return URL(fileURLWithPath: appliancePath)
}

func buildConfig() -> HelperConfig {
    let availableCpus = max(1, ProcessInfo.processInfo.processorCount)
    let cpuCount = min(max(1, requestedCpuCount), availableCpus)
    return HelperConfig(
        runtimeVersion: helperRuntimeVersion,
        instanceName: instanceName,
        cpuCount: cpuCount,
        memoryMiB: max(2048, memoryMiB),
        diskGiB: max(16, diskSizeGiB),
        sharedDirectory: sharedDirectoryURL().path,
        diskPath: diskURL().path,
        cloudInitImagePath: cloudInitISOURL().path,
        guestAddressPath: guestAddressURL().path,
        guestStatusPath: guestStatusURL().path,
        guestUser: guestUser
    )
}

func writeText(_ string: String, to url: URL) throws {
    try string.write(to: url, atomically: true, encoding: .utf8)
}

func indent(_ text: String, spaces: Int) -> String {
    let padding = String(repeating: " ", count: spaces)
    return text
        .split(separator: "\n", omittingEmptySubsequences: false)
        .map { "\(padding)\($0)" }
        .joined(separator: "\n")
}

func readTrimmedText(at url: URL) -> String? {
    guard let data = try? Data(contentsOf: url), let string = String(data: data, encoding: .utf8) else {
        return nil
    }
    let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
}

func removeIfExists(_ url: URL) {
    try? FileManager.default.removeItem(at: url)
}

func existingConfigNeedsReset() -> Bool {
    guard let existingConfig = loadConfig() else {
        return false
    }
    return existingConfig.runtimeVersion != helperRuntimeVersion
}

func buildCloudInitUserData() -> String {
    let bakeWriteFiles = bakeApplianceImage
        ? """
- path: /usr/local/bin/camelai-bake-appliance
  permissions: '0755'
  owner: root:root
  content: |
    #!/bin/bash
    set -euxo pipefail
    echo appliance-baking > /mnt/camelai-shared/runtime/status.txt
    rm -f /mnt/camelai-shared/runtime/appliance-baked
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y docker.io ca-certificates curl xz-utils
    if command -v systemctl >/dev/null 2>&1; then
      systemctl enable docker >/dev/null 2>&1 || true
      systemctl start docker >/dev/null 2>&1 || true
      systemctl enable systemd-resolved >/dev/null 2>&1 || true
      systemctl restart systemd-resolved >/dev/null 2>&1 || true
      systemctl disable camelai-bake-appliance.service >/dev/null 2>&1 || true
    fi
    rm -f /usr/local/bin/camelai-bake-appliance
    rm -f /etc/systemd/system/camelai-bake-appliance.service
    if command -v cloud-init >/dev/null 2>&1; then
      cloud-init clean --logs --machine-id --seed >/dev/null 2>&1 || true
    fi
    rm -rf /var/lib/cloud/*
    truncate -s 0 /etc/machine-id >/dev/null 2>&1 || true
    sync
    touch /mnt/camelai-shared/runtime/appliance-baked
    echo appliance-baked > /mnt/camelai-shared/runtime/status.txt
- path: /etc/systemd/system/camelai-bake-appliance.service
  permissions: '0644'
  owner: root:root
  content: |
    [Unit]
    Description=camelAI appliance bake
    After=camelai-runtime-setup.service
    Wants=camelai-runtime-setup.service

    [Service]
    Type=oneshot
    ExecStart=/usr/local/bin/camelai-bake-appliance
    StandardOutput=journal+console
    StandardError=journal+console

    [Install]
    WantedBy=multi-user.target
"""
        : ""
    let normalBakeGuardWriteFiles = bakeApplianceImage
        ? ""
        : """
- path: /usr/local/bin/camelai-bake-appliance
  permissions: '0755'
  owner: root:root
  content: |
    #!/bin/bash
    set -eu
    echo "[$(date -Is)] camelai-bake-appliance: ignored on normal runtime boot" >> /mnt/camelai-shared/logs/guest-control-plane-service.log 2>/dev/null || true
    exit 0
- path: /etc/systemd/system/camelai-bake-appliance.service
  permissions: '0644'
  owner: root:root
  content: |
    [Unit]
    Description=camelAI appliance bake (disabled on normal runtime boots)

    [Service]
    Type=oneshot
    ExecStart=/usr/local/bin/camelai-bake-appliance
    StandardOutput=journal+console
    StandardError=journal+console
"""
    let bootCommands = bakeApplianceImage
        ? ""
        : """
  - mkdir -p /mnt/camelai-shared /mnt/camelai-shared/runtime
  - modprobe virtiofs >/dev/null 2>&1 || true
  - mount -t virtiofs \(sharedTag) /mnt/camelai-shared >/dev/null 2>&1 || true
  - rm -f /etc/systemd/system/multi-user.target.wants/camelai-bake-appliance.service
  - rm -f /etc/systemd/system/default.target.wants/camelai-bake-appliance.service
  - rm -f /usr/local/bin/camelai-bake-appliance
  - ln -sfn /dev/null /etc/systemd/system/camelai-bake-appliance.service
"""
    let bootCommandSection = bootCommands.isEmpty
        ? ""
        : """
bootcmd:
\(indent(bootCommands, spaces: 2))
"""
    let runCommands = bakeApplianceImage
        ? """
- systemctl daemon-reload
- systemctl enable camelai-runtime-setup.service camelai-guest-control-plane.service camelai-vsock-bridge.service camelai-bake-appliance.service
- systemctl restart camelai-runtime-setup.service || systemctl start camelai-runtime-setup.service
- systemctl restart camelai-bake-appliance.service || systemctl start camelai-bake-appliance.service
"""
        : """
- sh -lc 'mkdir -p /mnt/camelai-shared/logs && /usr/local/bin/camelai-runtime-setup >> /mnt/camelai-shared/logs/runtime-setup.log 2>&1'
- systemctl daemon-reload
- systemctl disable --now camelai-bake-appliance.service || true
- systemctl enable camelai-runtime-setup.service camelai-guest-control-plane.service camelai-vsock-bridge.service
- systemctl restart camelai-guest-control-plane.service || systemctl start camelai-guest-control-plane.service
- systemctl restart camelai-vsock-bridge.service || systemctl start camelai-vsock-bridge.service
"""
    return """
    #cloud-config
    users:
      - default
      - name: \(guestUser)
        shell: /bin/bash
        lock_passwd: true
        sudo: ALL=(ALL) NOPASSWD:ALL
    disable_root: true
    \(bootCommandSection)
    write_files:
      - path: /usr/local/bin/camelai-runtime-setup
        permissions: '0755'
        owner: root:root
        content: |
          #!/bin/bash
          set -euxo pipefail
          now_ms() {
            date +%s%3N
          }
          STARTED_AT_MS="$(now_ms)"
          echo runtime-setup-starting > /mnt/camelai-shared/runtime/status.txt
          mkdir -p /mnt/camelai-shared
          MOUNT_WAIT_STARTED_AT_MS="$(now_ms)"
          for _ in $(seq 1 120); do
            if mountpoint -q /mnt/camelai-shared; then
              break
            fi
            modprobe virtiofs >/dev/null 2>&1 || true
            mount -t virtiofs \(sharedTag) /mnt/camelai-shared >/dev/null 2>&1 && break || true
            sleep 1
          done
          if ! mountpoint -q /mnt/camelai-shared; then
            echo "camelAI runtime setup failed: /mnt/camelai-shared did not mount" >&2
            exit 1
          fi
          echo "[$(date -Is)] camelai-runtime-setup: shared mount ready elapsed_ms=$(( $(now_ms) - MOUNT_WAIT_STARTED_AT_MS ))"
          ENV_FILE=/mnt/camelai-shared/runtime/guest-env.sh
          mkdir -p /mnt/camelai-shared/runtime
          mkdir -p /mnt/camelai-shared/runtime/bin
          mkdir -p /mnt/camelai-shared/runtime/container-home
          mkdir -p /mnt/camelai-shared/logs
          mkdir -p /mnt/camelai-shared/workspace
          mkdir -p /mnt/camelai-shared/guest
          mkdir -p /mnt/camelai-shared/auth/home
          chmod 0777 /mnt/camelai-shared/logs /mnt/camelai-shared/runtime /mnt/camelai-shared/workspace /mnt/camelai-shared/guest /mnt/camelai-shared/auth /mnt/camelai-shared/auth/home || true
          if [ -f "$ENV_FILE" ]; then
            set -a
            # shellcheck disable=SC1090
            source "$ENV_FILE"
            set +a
          fi
          mkdir -p /etc/systemd/resolved.conf.d
          printf '%s\\n' \
            '[Resolve]' \
            'DNS=1.1.1.1 1.0.0.1 8.8.8.8 8.8.4.4' \
            'FallbackDNS=9.9.9.9 149.112.112.112' \
            'Domains=~.' \
            'DNSStubListener=yes' \
            >/etc/systemd/resolved.conf.d/camelai-dns.conf
          # Point the guest at real upstream resolvers instead of the local
          # systemd-resolved stub so containers do not inherit 127.0.0.53.
          ln -sf /run/systemd/resolve/resolv.conf /etc/resolv.conf
          if command -v systemctl >/dev/null 2>&1; then
            systemctl enable systemd-resolved >/dev/null 2>&1 || true
            systemctl restart systemd-resolved >/dev/null 2>&1 || true
          fi
          mkdir -p /etc/docker
          cat >/etc/docker/daemon.json <<'EOF'
          {
            "dns": ["1.1.1.1", "1.0.0.1", "8.8.8.8", "8.8.4.4"]
          }
          EOF
          echo "[$(date -Is)] camelai-runtime-setup: guest resolv.conf"
          cat /etc/resolv.conf || true
          echo "[$(date -Is)] camelai-runtime-setup: docker daemon dns config"
          cat /etc/docker/daemon.json || true
          if ! command -v docker >/dev/null 2>&1; then
            DOCKER_INSTALL_STARTED_AT_MS="$(now_ms)"
            export DEBIAN_FRONTEND=noninteractive
            apt-get update
            apt-get install -y docker.io ca-certificates curl xz-utils
            echo "[$(date -Is)] camelai-runtime-setup: docker installed elapsed_ms=$(( $(now_ms) - DOCKER_INSTALL_STARTED_AT_MS ))"
          fi
          if command -v systemctl >/dev/null 2>&1; then
            DOCKER_START_STARTED_AT_MS="$(now_ms)"
            systemctl enable docker >/dev/null 2>&1 || true
            systemctl restart docker >/dev/null 2>&1 || systemctl start docker >/dev/null 2>&1 || true
            echo "[$(date -Is)] camelai-runtime-setup: docker started elapsed_ms=$(( $(now_ms) - DOCKER_START_STARTED_AT_MS ))"
          fi
          NETWORK_OBSERVE_STARTED_AT_MS="$(now_ms)"
          if ip route get 1.1.1.1 >/mnt/camelai-shared/runtime/network-route.txt 2>/dev/null; then
            echo "[$(date -Is)] camelai-runtime-setup: route ready elapsed_ms=$(( $(now_ms) - NETWORK_OBSERVE_STARTED_AT_MS ))"
          else
            echo "[$(date -Is)] camelai-runtime-setup: route not ready elapsed_ms=$(( $(now_ms) - NETWORK_OBSERVE_STARTED_AT_MS ))"
          fi
          if getent ahostsv4 api.anthropic.com >/mnt/camelai-shared/runtime/dns-check.txt 2>/dev/null; then
            echo "[$(date -Is)] camelai-runtime-setup: dns observed elapsed_ms=$(( $(now_ms) - NETWORK_OBSERVE_STARTED_AT_MS ))"
          else
            echo "[$(date -Is)] camelai-runtime-setup: dns not ready yet elapsed_ms=$(( $(now_ms) - NETWORK_OBSERVE_STARTED_AT_MS ))"
          fi
          echo runtime-ready > /mnt/camelai-shared/runtime/status.txt
          ip -4 route get 1.1.1.1 | awk '{print $7; exit}' > /mnt/camelai-shared/runtime/guest-ip.txt || true
          echo "[$(date -Is)] camelai-runtime-setup: complete elapsed_ms=$(( $(now_ms) - STARTED_AT_MS ))"
      - path: /usr/local/bin/camelai-start-control-plane
        permissions: '0755'
        owner: root:root
        content: |
          #!/bin/bash
          set -euxo pipefail
          now_ms() {
            date +%s%3N
          }
          STARTED_AT_MS="$(now_ms)"
          LOG_FILE=/mnt/camelai-shared/logs/guest-control-plane-service.log
          mkdir -p /mnt/camelai-shared/logs
          touch "$LOG_FILE"
          exec >>"$LOG_FILE" 2>&1
          echo "[$(date -Is)] camelai-start-control-plane: begin"
          echo starting-control-plane > /mnt/camelai-shared/runtime/status.txt
          ENV_FILE=/mnt/camelai-shared/runtime/guest-env.sh
          CONTAINER_HOME=/mnt/camelai-shared/runtime/container-home
          export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/snap/bin
          if [ -f "$ENV_FILE" ]; then
            set -a
            # shellcheck disable=SC1090
            source "$ENV_FILE"
            set +a
          fi
          IMAGE="${DESKTOP_GUEST_CONTROL_PLANE_IMAGE:-vercantes/camelai-openwork:20260403-v2}"
          echo "[$(date -Is)] camelai-start-control-plane: env loaded model=${DESKTOP_ANTHROPIC_MODEL:-unset} api_key=$([ -n \"${ANTHROPIC_API_KEY:-}\" ] && echo present || echo missing) claude_config_dir=${CLAUDE_CONFIG_DIR:-unset} image=${IMAGE}"
          if command -v systemctl >/dev/null 2>&1; then
            DOCKER_START_STARTED_AT_MS="$(now_ms)"
            systemctl enable docker >/dev/null 2>&1 || true
            systemctl start docker >/dev/null 2>&1 || true
            echo "[$(date -Is)] camelai-start-control-plane: docker ensured elapsed_ms=$(( $(now_ms) - DOCKER_START_STARTED_AT_MS ))"
          fi
          IMAGE_RESOLUTION_STARTED_AT_MS="$(now_ms)"
          if docker image inspect "$IMAGE" >/dev/null 2>&1; then
            echo "[$(date -Is)] camelai-start-control-plane: image present locally image=${IMAGE}"
          else
            NETWORK_WAIT_STARTED_AT_MS="$(now_ms)"
            for _ in $(seq 1 60); do
              if ip route get 1.1.1.1 >/dev/null 2>&1 && getent ahostsv4 registry-1.docker.io >/dev/null 2>&1; then
                break
              fi
              sleep 1
            done
            if ! ip route get 1.1.1.1 >/dev/null 2>&1 || ! getent ahostsv4 registry-1.docker.io >/dev/null 2>&1; then
              echo "[$(date -Is)] camelai-start-control-plane: network wait failed elapsed_ms=$(( $(now_ms) - NETWORK_WAIT_STARTED_AT_MS ))"
              echo runtime-network-unavailable > /mnt/camelai-shared/runtime/status.txt
              echo "camelAI runtime could not reach network prerequisites for ${IMAGE}" >&2
              exit 1
            fi
            echo "[$(date -Is)] camelai-start-control-plane: network ready elapsed_ms=$(( $(now_ms) - NETWORK_WAIT_STARTED_AT_MS ))"
            echo "[$(date -Is)] camelai-start-control-plane: pulling image ${IMAGE}"
            IMAGE_PULL_STARTED_AT_MS="$(now_ms)"
            PULL_LOG="$(mktemp)"
            if docker pull "$IMAGE" >"$PULL_LOG" 2>&1; then
              cat "$PULL_LOG"
              rm -f "$PULL_LOG"
              echo "[$(date -Is)] camelai-start-control-plane: docker pull complete elapsed_ms=$(( $(now_ms) - IMAGE_PULL_STARTED_AT_MS )) image=${IMAGE}"
            elif [ ! -s "$PULL_LOG" ] || ! grep -qiE 'network is unreachable|temporary failure|i/o timeout|connection refused|no route to host|lookup .*: dial ' "$PULL_LOG"; then
              cat "$PULL_LOG"
              echo "[$(date -Is)] camelai-start-control-plane: docker pull failed elapsed_ms=$(( $(now_ms) - IMAGE_PULL_STARTED_AT_MS )) image=${IMAGE}"
              echo runtime-missing-image > /mnt/camelai-shared/runtime/status.txt
              echo "camelAI runtime could not pull required image ${IMAGE}" >&2
              rm -f "$PULL_LOG"
              exit 1
            else
              cat "$PULL_LOG"
              echo "[$(date -Is)] camelai-start-control-plane: docker pull transient failure elapsed_ms=$(( $(now_ms) - IMAGE_PULL_STARTED_AT_MS )) image=${IMAGE}"
              if command -v systemctl >/dev/null 2>&1; then
                systemctl restart docker >/dev/null 2>&1 || true
              fi
              RETRY_WAIT_STARTED_AT_MS="$(now_ms)"
              for _ in $(seq 1 30); do
                if ip route get 1.1.1.1 >/dev/null 2>&1 && getent ahostsv4 registry-1.docker.io >/dev/null 2>&1; then
                  break
                fi
                sleep 1
              done
              echo "[$(date -Is)] camelai-start-control-plane: retry network wait elapsed_ms=$(( $(now_ms) - RETRY_WAIT_STARTED_AT_MS ))"
              RETRY_PULL_STARTED_AT_MS="$(now_ms)"
              if ! docker pull "$IMAGE"; then
                echo "[$(date -Is)] camelai-start-control-plane: docker pull failed after retry elapsed_ms=$(( $(now_ms) - RETRY_PULL_STARTED_AT_MS )) image=${IMAGE}"
                echo runtime-missing-image > /mnt/camelai-shared/runtime/status.txt
                echo "camelAI runtime could not pull required image ${IMAGE}" >&2
                rm -f "$PULL_LOG"
                exit 1
              fi
              rm -f "$PULL_LOG"
              echo "[$(date -Is)] camelai-start-control-plane: docker pull complete after retry elapsed_ms=$(( $(now_ms) - RETRY_PULL_STARTED_AT_MS )) image=${IMAGE}"
            fi
          fi
          echo "[$(date -Is)] camelai-start-control-plane: image resolved elapsed_ms=$(( $(now_ms) - IMAGE_RESOLUTION_STARTED_AT_MS )) image=${IMAGE}"
          mkdir -p "$CONTAINER_HOME"
          echo "[$(date -Is)] camelai-start-control-plane: launching docker image ${IMAGE}"
          docker rm -f camelai-guest-control-plane >/dev/null 2>&1 || true
          CONTAINER_LAUNCH_STARTED_AT_MS="$(now_ms)"
          docker run --rm \
            --name camelai-guest-control-plane \
            --network host \
            -w /mnt/camelai-shared/workspace \
            -v /mnt/camelai-shared:/mnt/camelai-shared \
            -e HOME="${HOME:-$CONTAINER_HOME}" \
            -e CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$CONTAINER_HOME/.claude}" \
            -e DESKTOP_ANTHROPIC_MODEL="${DESKTOP_ANTHROPIC_MODEL:-sonnet}" \
            -e DESKTOP_GUEST_CONTROL_PLANE_PORT="${DESKTOP_GUEST_CONTROL_PLANE_PORT:-\(guestControlPlanePort)}" \
            -e DESKTOP_GUEST_SDK_DEBUG_FILE="${DESKTOP_GUEST_SDK_DEBUG_FILE:-/mnt/camelai-shared/logs/claude-sdk-debug.log}" \
            $( [ -n "${ANTHROPIC_API_KEY:-}" ] && printf -- '-e ANTHROPIC_API_KEY=%s ' "${ANTHROPIC_API_KEY}" ) \
            "$IMAGE"
          EXIT_CODE=$?
          echo "[$(date -Is)] camelai-start-control-plane: docker run finished elapsed_ms=$(( $(now_ms) - CONTAINER_LAUNCH_STARTED_AT_MS )) total_elapsed_ms=$(( $(now_ms) - STARTED_AT_MS ))"
          echo "[$(date -Is)] camelai-start-control-plane: docker exited code=${EXIT_CODE}"
          echo control-plane-exited > /mnt/camelai-shared/runtime/status.txt
          exit "$EXIT_CODE"
      - path: /usr/local/bin/camelai-vsock-bridge.py
        permissions: '0755'
        owner: root:root
        content: |
          #!/usr/bin/env python3
          import socket
          import threading

          VSOCK_PORT = \(guestControlPlanePort)
          TCP_PORT = \(guestControlPlanePort)

          def pump(reader, writer):
            try:
              while True:
                chunk = reader.recv(65536)
                if not chunk:
                  break
                writer.sendall(chunk)
            finally:
              try:
                writer.shutdown(socket.SHUT_WR)
              except OSError:
                pass
              try:
                reader.shutdown(socket.SHUT_RD)
              except OSError:
                pass

          def handle_client(client):
            upstream = socket.create_connection(("127.0.0.1", TCP_PORT))
            left = threading.Thread(target=pump, args=(client, upstream), daemon=True)
            right = threading.Thread(target=pump, args=(upstream, client), daemon=True)
            left.start()
            right.start()
            left.join()
            right.join()
            client.close()
            upstream.close()

          server = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
          server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
          server.bind((socket.VMADDR_CID_ANY, VSOCK_PORT))
          server.listen()
          while True:
            client, _ = server.accept()
            threading.Thread(target=handle_client, args=(client,), daemon=True).start()
      - path: /etc/systemd/system/camelai-runtime-setup.service
        permissions: '0644'
        owner: root:root
        content: |
          [Unit]
          Description=camelAI guest runtime setup
          After=local-fs.target

          [Service]
          Type=oneshot
          ExecStart=/usr/local/bin/camelai-runtime-setup
          RemainAfterExit=yes
          StandardOutput=journal+console
          StandardError=journal+console

          [Install]
          WantedBy=multi-user.target
      - path: /etc/systemd/system/camelai-guest-control-plane.service
        permissions: '0644'
        owner: root:root
        content: |
          [Unit]
          Description=camelAI guest control plane
          After=camelai-runtime-setup.service docker.service network-online.target
          Wants=camelai-runtime-setup.service docker.service network-online.target
          [Service]
          WorkingDirectory=/mnt/camelai-shared/workspace
          ExecStart=/usr/local/bin/camelai-start-control-plane
          Restart=always
          RestartSec=2
          StandardOutput=journal+console
          StandardError=journal+console

          [Install]
          WantedBy=multi-user.target
      - path: /etc/systemd/system/camelai-vsock-bridge.service
        permissions: '0644'
        owner: root:root
        content: |
          [Unit]
          Description=camelAI guest vsock bridge
          After=camelai-guest-control-plane.service
          Wants=camelai-guest-control-plane.service
          [Service]
          ExecStart=/usr/local/bin/camelai-vsock-bridge.py
          Restart=always
          RestartSec=2
          StandardOutput=journal+console
          StandardError=journal+console

          [Install]
          WantedBy=multi-user.target
    \(indent(normalBakeGuardWriteFiles, spaces: 2))
    \(indent(bakeWriteFiles, spaces: 2))
    runcmd:
    \(indent(runCommands, spaces: 6))
    """
}

func writeCloudInitImage(config: HelperConfig) throws {
    let metadata = """
    instance-id: \(config.instanceName)-\(config.runtimeVersion)
    local-hostname: \(config.instanceName)
    """
    let userData = buildCloudInitUserData()

    let seedDirectoryURL = cloudInitSeedDirectoryURL()
    let destinationURL = URL(fileURLWithPath: config.cloudInitImagePath)
    removeIfExists(seedDirectoryURL)
    removeIfExists(destinationURL)
    try ensureDirectory(seedDirectoryURL)
    try writeText(userData, to: seedDirectoryURL.appendingPathComponent("user-data"))
    try writeText(metadata, to: seedDirectoryURL.appendingPathComponent("meta-data"))

    let hdiutilPath = which("hdiutil") ?? "/usr/bin/hdiutil"
    let createResult = try runProcess(
        hdiutilPath,
        [
            "makehybrid",
            "-o", destinationURL.path,
            seedDirectoryURL.path,
            "-iso",
            "-joliet",
            "-ov",
            "-default-volume-name", "CIDATA",
        ]
    )
    if createResult.status != 0 {
        throw NSError(
            domain: "camelai.vm-helper",
            code: Int(createResult.status),
            userInfo: [NSLocalizedDescriptionKey: createResult.stderr.isEmpty ? createResult.stdout : createResult.stderr]
        )
    }
}

func persistPreparedState(lastCommand: String) throws {
    try persistJSON(
        HelperState(
            prepared: true,
            preparedAt: ISO8601DateFormatter().string(from: Date()),
            lastCommand: lastCommand
        ),
        to: stateURL()
    )
}

func persistHelperPID() {
    try? writeText(String(ProcessInfo.processInfo.processIdentifier), to: helperPIDURL())
}

func clearGuestRuntimeMarkers() {
    removeIfExists(guestAddressURL())
    removeIfExists(guestStatusURL())
    removeIfExists(guestStateDirectoryURL().appendingPathComponent("appliance-baked"))
    removeIfExists(guestStateDirectoryURL().appendingPathComponent("dns-check.txt"))
}

func helperConfigOrFailure() -> HelperConfig {
    guard let config = loadConfig() else {
        failure("Missing VM config. Run prepare first.")
    }
    return config
}

func baseDetail(prepared: Bool, frameworkAvailable: Bool) -> String {
    if frameworkAvailable {
        return prepared
            ? "VM artifacts are prepared locally. Guest boot is available through a direct Apple Virtualization Framework VM."
            : "Apple Virtualization Framework is available. Run prepare to create local VM artifacts."
    }
    return "Apple Virtualization Framework is not available in this build environment."
}

func makeResponse(state: String, detail: String, prepared: Bool, guestAddress: String? = nil, localProxyPort: Int? = nil) -> HelperResponse {
    HelperResponse(
        state: state,
        detail: detail,
        helperPath: CommandLine.arguments.first,
        prepared: prepared,
        vmDirectory: vmDirectoryURL().path,
        diskPath: diskURL().path,
        instanceName: instanceName,
        localProxyPort: localProxyPort,
        guestIPAddress: guestAddress
    )
}

#if canImport(Virtualization)
@available(macOS 13.0, *)
final class DirectVMRuntime: NSObject, VZVirtualMachineDelegate {
    private let vmQueue = DispatchQueue(label: "dev.camelai.desktop.vm")
    private let proxyQueue = DispatchQueue(
        label: "dev.camelai.desktop.vm.proxy",
        attributes: .concurrent
    )
    private let startupQueue = DispatchQueue(label: "dev.camelai.desktop.vm.startup")
    private let proxyConnectionsLock = NSLock()
    private var virtualMachine: VZVirtualMachine?
    private var lastError: String?
    private var startupInProgress = false
    private var serialConsoleInputHandle: FileHandle?
    private var serialConsoleOutputHandle: FileHandle?
    private var localProxyListenerFD: Int32 = -1
    private var localProxySource: DispatchSourceRead?
    private var proxyConnections: [UUID: VsockProxyConnection] = [:]
    private var currentLocalProxyPort: Int?

    func status(prepared: Bool) -> HelperResponse {
        let guestAddress = readTrimmedText(at: guestAddressURL())
        let guestStatus = readTrimmedText(at: guestStatusURL())
        let detailPrefix = baseDetail(prepared: prepared, frameworkAvailable: true)
        return vmQueue.sync {
            guard let virtualMachine else {
                if startupInProgress {
                    return makeResponse(
                        state: "starting",
                        detail: "\(detailPrefix) The VM is starting.",
                        prepared: prepared,
                        guestAddress: guestAddress,
                        localProxyPort: currentLocalProxyPort
                    )
                }
                if let lastError {
                    return makeResponse(
                        state: "error",
                        detail: lastError,
                        prepared: prepared,
                        guestAddress: guestAddress,
                        localProxyPort: currentLocalProxyPort
                    )
                }
                return makeResponse(
                    state: "stopped",
                    detail: guestAddress == nil ? detailPrefix : "\(detailPrefix) No VM is currently attached to this helper process.",
                    prepared: prepared,
                    guestAddress: guestAddress,
                    localProxyPort: currentLocalProxyPort
                )
            }

            switch virtualMachine.state {
            case .running:
                if let guestAddress {
                    return makeResponse(
                        state: "running",
                        detail: "\(detailPrefix) Guest address: \(guestAddress).\(guestStatus.map { " Guest status: \($0)." } ?? "")",
                        prepared: prepared,
                        guestAddress: guestAddress,
                        localProxyPort: currentLocalProxyPort
                    )
                }
                return makeResponse(
                    state: "running",
                    detail: guestStatus == nil
                        ? "\(detailPrefix) The VM is running but guest readiness has not been published yet."
                        : "\(detailPrefix) Guest status: \(guestStatus!).",
                    prepared: prepared,
                    localProxyPort: currentLocalProxyPort
                )
            case .starting:
                return makeResponse(
                    state: "starting",
                    detail: "\(detailPrefix) The VM is starting.",
                    prepared: prepared,
                    localProxyPort: currentLocalProxyPort
                )
            case .stopping, .paused, .pausing, .resuming, .saving, .restoring:
                return makeResponse(
                    state: "starting",
                    detail: "\(detailPrefix) The VM is transitioning.",
                    prepared: prepared,
                    guestAddress: guestAddress,
                    localProxyPort: currentLocalProxyPort
                )
            case .error:
                return makeResponse(
                    state: "error",
                    detail: lastError ?? "The VM entered an error state.",
                    prepared: prepared,
                    guestAddress: guestAddress,
                    localProxyPort: currentLocalProxyPort
                )
            case .stopped:
                return makeResponse(
                    state: "stopped",
                    detail: detailPrefix,
                    prepared: prepared,
                    guestAddress: guestAddress,
                    localProxyPort: currentLocalProxyPort
                )
            @unknown default:
                return makeResponse(
                    state: "error",
                    detail: "Encountered an unknown VM state.",
                    prepared: prepared,
                    guestAddress: guestAddress,
                    localProxyPort: currentLocalProxyPort
                )
            }
        }
    }

    func start(config: HelperConfig) -> HelperResponse {
        clearGuestRuntimeMarkers()
        let shouldStart = vmQueue.sync { () -> Bool in
            if startupInProgress {
                return false
            }
            if let virtualMachine, virtualMachine.state == .running || virtualMachine.state == .starting {
                return false
            }
            startupInProgress = true
            lastError = nil
            return true
        }

        if shouldStart {
            startupQueue.async { [weak self] in
                guard let self else {
                    return
                }
                do {
                    let configuration = try self.makeVirtualMachineConfiguration(config: config)
                    try configuration.validate()

                    self.vmQueue.async {
                        do {
                            try self.startLocalProxyIfNeeded()
                            let virtualMachine = VZVirtualMachine(configuration: configuration, queue: self.vmQueue)
                            virtualMachine.delegate = self
                            self.virtualMachine = virtualMachine
                            self.lastError = nil
                            self.startupInProgress = false

                            virtualMachine.start { result in
                                if case let .failure(error) = result {
                                    self.vmQueue.async {
                                        self.lastError = error.localizedDescription
                                        if self.virtualMachine === virtualMachine {
                                            self.virtualMachine = nil
                                        }
                                        self.stopLocalProxy()
                                    }
                                }
                            }
                        } catch {
                            self.virtualMachine = nil
                            self.lastError = error.localizedDescription
                            self.startupInProgress = false
                            self.stopLocalProxy()
                        }
                    }
                } catch {
                    self.vmQueue.async {
                        self.virtualMachine = nil
                        self.lastError = error.localizedDescription
                        self.startupInProgress = false
                        self.stopLocalProxy()
                    }
                }
            }
        }

        if let lastError {
            return makeResponse(
                state: "error",
                detail: "Failed to start VM: \(lastError)",
                prepared: true,
                localProxyPort: currentLocalProxyPort
            )
        }

        persistHelperPID()
        return makeResponse(
            state: "starting",
            detail: "Started the direct Apple Virtualization Framework VM.",
            prepared: true,
            localProxyPort: currentLocalProxyPort
        )
    }

    func stop(prepared: Bool) -> HelperResponse {
        clearGuestRuntimeMarkers()
        let semaphore = DispatchSemaphore(value: 0)
        var stopError: Error?

        vmQueue.sync {
            lastError = nil
            startupInProgress = false
            guard let virtualMachine else {
                semaphore.signal()
                return
            }

            if virtualMachine.canStop {
                virtualMachine.stop { error in
            stopError = error
            self.virtualMachine = nil
            self.stopLocalProxy()
            semaphore.signal()
        }
                return
            }

            self.virtualMachine = nil
            self.stopLocalProxy()
            semaphore.signal()
        }

        semaphore.wait()

        if let stopError {
            lastError = stopError.localizedDescription
            return makeResponse(
                state: "error",
                detail: "Failed to stop VM: \(stopError.localizedDescription)",
                prepared: prepared,
                localProxyPort: currentLocalProxyPort
            )
        }

        return makeResponse(
            state: "stopped",
            detail: "Stopped the direct Apple Virtualization Framework VM.",
            prepared: prepared,
            localProxyPort: currentLocalProxyPort
        )
    }

    private func makeVirtualMachineConfiguration(config: HelperConfig) throws -> VZVirtualMachineConfiguration {
        let configuration = VZVirtualMachineConfiguration()
        configuration.cpuCount = config.cpuCount
        configuration.memorySize = UInt64(config.memoryMiB) * 1024 * 1024

        let bootLoader = VZEFIBootLoader()
        bootLoader.variableStore = try makeEFIVariableStore()
        configuration.bootLoader = bootLoader
        let platform = VZGenericPlatformConfiguration()
        platform.machineIdentifier = try makeMachineIdentifier()
        configuration.platform = platform

        let rootAttachment = try VZDiskImageStorageDeviceAttachment(
            url: URL(fileURLWithPath: config.diskPath),
            readOnly: false
        )
        let cloudInitAttachment = try VZDiskImageStorageDeviceAttachment(
            url: URL(fileURLWithPath: config.cloudInitImagePath),
            readOnly: true
        )
        let cloudInitDevice = VZUSBMassStorageDeviceConfiguration(
            attachment: cloudInitAttachment
        )
        configuration.storageDevices = [
            VZVirtioBlockDeviceConfiguration(attachment: rootAttachment),
            cloudInitDevice,
        ]

        let networkDevice = VZVirtioNetworkDeviceConfiguration()
        networkDevice.attachment = VZNATNetworkDeviceAttachment()
        configuration.networkDevices = [networkDevice]

        let serialPort = try makeSerialPortConfiguration()
        configuration.serialPorts = [serialPort]

        let sharedDirectory = VZSharedDirectory(
            url: URL(fileURLWithPath: config.sharedDirectory, isDirectory: true),
            readOnly: false
        )
        let share = VZSingleDirectoryShare(directory: sharedDirectory)
        let fileSystemDevice = VZVirtioFileSystemDeviceConfiguration(tag: sharedTag)
        fileSystemDevice.share = share
        configuration.directorySharingDevices = [fileSystemDevice]
        configuration.socketDevices = [VZVirtioSocketDeviceConfiguration()]
        configuration.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
        configuration.memoryBalloonDevices = [VZVirtioTraditionalMemoryBalloonDeviceConfiguration()]

        return configuration
    }

    private func makeSerialPortConfiguration() throws -> VZVirtioConsoleDeviceSerialPortConfiguration {
        let logURL = serialConsoleLogURL()
        if !FileManager.default.fileExists(atPath: logURL.path) {
            FileManager.default.createFile(atPath: logURL.path, contents: nil)
        }

        let inputHandle = try FileHandle(forReadingFrom: URL(fileURLWithPath: "/dev/null"))
        let outputHandle = try FileHandle(forWritingTo: logURL)
        try outputHandle.truncate(atOffset: 0)
        try outputHandle.seekToEnd()

        self.serialConsoleInputHandle = inputHandle
        self.serialConsoleOutputHandle = outputHandle

        let attachment = VZFileHandleSerialPortAttachment(
            fileHandleForReading: inputHandle,
            fileHandleForWriting: outputHandle
        )
        let serialPort = VZVirtioConsoleDeviceSerialPortConfiguration()
        serialPort.attachment = attachment
        return serialPort
    }

    private func makeEFIVariableStore() throws -> VZEFIVariableStore {
        let url = efiVariableStoreURL()
        if FileManager.default.fileExists(atPath: url.path) {
            return VZEFIVariableStore(url: url)
        }
        return try VZEFIVariableStore(creatingVariableStoreAt: url)
    }

    private func makeMachineIdentifier() throws -> VZGenericMachineIdentifier {
        let url = machineIdentifierURL()
        if let data = try? Data(contentsOf: url),
           let identifier = VZGenericMachineIdentifier(dataRepresentation: data) {
            return identifier
        }

        let identifier = VZGenericMachineIdentifier()
        try identifier.dataRepresentation.write(to: url, options: [.atomic])
        return identifier
    }

    func guestDidStop(_ virtualMachine: VZVirtualMachine) {
        lastError = "The guest VM stopped."
        startupInProgress = false
        if self.virtualMachine === virtualMachine {
            self.virtualMachine = nil
        }
        stopLocalProxy()
    }

    func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
        lastError = error.localizedDescription
        startupInProgress = false
        if self.virtualMachine === virtualMachine {
            self.virtualMachine = nil
        }
        stopLocalProxy()
    }

    private func startLocalProxyIfNeeded() throws {
        if localProxyListenerFD != -1 {
            return
        }

        var selectedPort: UInt16?
        var listenerFD: Int32 = -1

        for portOffset in 0..<32 {
            let candidatePort = localControlPlanePort + UInt16(portOffset)
            let candidateFD = socket(AF_INET, SOCK_STREAM, 0)
            guard candidateFD >= 0 else {
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
            }

            var reuseAddress: Int32 = 1
            setsockopt(
                candidateFD,
                SOL_SOCKET,
                SO_REUSEADDR,
                &reuseAddress,
                socklen_t(MemoryLayout<Int32>.size)
            )
            try setNonBlocking(candidateFD)

            var address = sockaddr_in()
            address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
            address.sin_family = sa_family_t(AF_INET)
            address.sin_port = candidatePort.bigEndian
            address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))

            let bindResult = withUnsafePointer(to: &address) { pointer in
                pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    Darwin.bind(candidateFD, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
                }
            }

            if bindResult == 0 && listen(candidateFD, SOMAXCONN) == 0 {
                listenerFD = candidateFD
                selectedPort = candidatePort
                break
            }

            Darwin.close(candidateFD)
            if errno != EADDRINUSE {
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
            }
        }

        guard listenerFD != -1, let selectedPort else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(EADDRINUSE))
        }

        let source = DispatchSource.makeReadSource(fileDescriptor: listenerFD, queue: proxyQueue)
        source.setEventHandler { [weak self] in
            self?.acceptLocalProxyClients()
        }
        source.setCancelHandler {
            Darwin.close(listenerFD)
        }
        source.resume()

        localProxyListenerFD = listenerFD
        localProxySource = source
        currentLocalProxyPort = Int(selectedPort)
    }

    private func stopLocalProxy() {
        for connection in snapshotProxyConnections() {
            connection.shutdown()
        }
        replaceProxyConnections(with: [:])
        localProxySource?.cancel()
        localProxySource = nil
        localProxyListenerFD = -1
        currentLocalProxyPort = nil
    }

    private func acceptLocalProxyClients() {
        while true {
            let clientFD = accept(localProxyListenerFD, nil, nil)
            if clientFD == -1 {
                if errno == EAGAIN || errno == EWOULDBLOCK {
                    break
                }
                return
            }

            vmQueue.async { [weak self] in
                guard let self else {
                    Darwin.close(clientFD)
                    return
                }

                guard let socketDevice = self.currentSocketDevice() else {
                    Darwin.close(clientFD)
                    return
                }

                socketDevice.connect(toPort: UInt32(guestControlPlanePort)) { [weak self] result in
                    guard let self else {
                        Darwin.close(clientFD)
                        return
                    }
                    self.proxyQueue.async {
                        switch result {
                        case .success(let connection):
                            do {
                                let proxyConnection = try VsockProxyConnection(
                                    localFD: clientFD,
                                    remoteConnection: connection,
                                    queue: self.proxyQueue,
                                    onClose: { [weak self] connectionID in
                                        self?.removeProxyConnection(id: connectionID)
                                    }
                                )
                                self.storeProxyConnection(proxyConnection)
                                proxyConnection.start()
                            } catch {
                                Darwin.close(clientFD)
                                connection.close()
                            }
                        case .failure:
                            Darwin.close(clientFD)
                        }
                    }
                }
            }
        }
    }

    private func drainPendingClients() {
        while true {
            let clientFD = accept(localProxyListenerFD, nil, nil)
            if clientFD == -1 {
                break
            }
            Darwin.close(clientFD)
        }
    }

    private func currentSocketDevice() -> VZVirtioSocketDevice? {
        virtualMachine?.socketDevices.compactMap { $0 as? VZVirtioSocketDevice }.first
    }

    private func storeProxyConnection(_ connection: VsockProxyConnection) {
        proxyConnectionsLock.lock()
        proxyConnections[connection.id] = connection
        proxyConnectionsLock.unlock()
    }

    private func removeProxyConnection(id: UUID) {
        proxyConnectionsLock.lock()
        proxyConnections.removeValue(forKey: id)
        proxyConnectionsLock.unlock()
    }

    private func snapshotProxyConnections() -> [VsockProxyConnection] {
        proxyConnectionsLock.lock()
        let values = Array(proxyConnections.values)
        proxyConnectionsLock.unlock()
        return values
    }

    private func replaceProxyConnections(with value: [UUID: VsockProxyConnection]) {
        proxyConnectionsLock.lock()
        proxyConnections = value
        proxyConnectionsLock.unlock()
    }
}
#endif

func handleDaemonClient(_ clientFD: Int32, runtime: AnyObject?) {
    defer {
        Darwin.close(clientFD)
    }

    var fallbackId = UUID().uuidString
    do {
        guard let line = try readSingleJSONLine(from: clientFD) else {
            return
        }
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            return
        }

        let requestData = Data(trimmed.utf8)
        let request = try JSONDecoder().decode(HelperDaemonRequest.self, from: requestData)
        fallbackId = request.id

        guard let command = HelperCommand(rawValue: request.command), command != .daemon else {
            try writeDaemonResponse(
                HelperDaemonResponse(
                    id: request.id,
                    ok: false,
                    result: nil,
                    error: "Unsupported helper command: \(request.command)"
                ),
                to: clientFD
            )
            return
        }

        let result = handleCommand(command, runtime: runtime)
        try writeDaemonResponse(
            HelperDaemonResponse(
                id: request.id,
                ok: true,
                result: result,
                error: nil
            ),
            to: clientFD
        )
    } catch {
        try? writeDaemonResponse(
            HelperDaemonResponse(
                id: fallbackId,
                ok: false,
                result: nil,
                error: error.localizedDescription
            ),
            to: clientFD
        )
    }
}

func handlePrepare() -> HelperResponse {
    let isFrameworkAvailable = frameworkAvailable()
    guard isFrameworkAvailable else {
        return makeResponse(
            state: "unavailable",
            detail: "Apple Virtualization Framework is not available in this build environment.",
            prepared: false
        )
    }

    do {
        let applianceURL = applianceImageURL()
        let shouldPreserveExistingDisk =
            applianceURL?.standardizedFileURL == diskURL().standardizedFileURL
        clearGuestRuntimeMarkers()
        if existingConfigNeedsReset() {
            if !shouldPreserveExistingDisk {
                removeIfExists(diskURL())
            }
            removeIfExists(configURL())
            removeIfExists(stateURL())
            removeIfExists(efiVariableStoreURL())
            removeIfExists(machineIdentifierURL())
            removeIfExists(cloudInitISOURL())
            removeIfExists(cloudInitSeedDirectoryURL())
        }
        guard let applianceURL,
              FileManager.default.fileExists(atPath: applianceURL.path)
        else {
            return makeResponse(
                state: "error",
                detail: "The packaged Ubuntu appliance image is missing. Set DESKTOP_VM_APPLIANCE_IMAGE_PATH to a bootstrapped disk image.",
                prepared: false
            )
        }
        try ensureDirectory(vmDirectoryURL())
        try ensureDirectory(sharedDirectoryURL())
        try ensureDirectory(artifactsDirectoryURL())
        try ensureDirectory(guestStateDirectoryURL())
        try ensureDirectory(sharedDirectoryURL().appendingPathComponent("logs", isDirectory: true))
        try ensureDirectory(sharedDirectoryURL().appendingPathComponent("guest", isDirectory: true))
        try ensureDirectory(sharedDirectoryURL().appendingPathComponent("workspace", isDirectory: true))
        try ensureDirectory(sharedDirectoryURL().appendingPathComponent("auth", isDirectory: true))
        let config = buildConfig()
        let targetDiskURL = URL(fileURLWithPath: config.diskPath)
        if applianceURL.standardizedFileURL != targetDiskURL.standardizedFileURL {
            removeIfExists(targetDiskURL)
            try FileManager.default.copyItem(at: applianceURL, to: targetDiskURL)
        }
        try writeCloudInitImage(config: config)
        try persistJSON(config, to: configURL())
        try persistPreparedState(lastCommand: "prepare")
        return makeResponse(
            state: "stopped",
            detail: "Prepared direct AVF VM artifacts, copied the Ubuntu appliance disk, and initialized the shared runtime directory.",
            prepared: true
        )
    } catch {
        return makeResponse(
            state: "error",
            detail: "Failed to prepare VM artifacts: \(error.localizedDescription)",
            prepared: false
        )
    }
}

func handleStaticStatus() -> HelperResponse {
    let prepared = preparedState()
    let detailPrefix = baseDetail(prepared: prepared, frameworkAvailable: frameworkAvailable())
    let guestAddress = readTrimmedText(at: guestAddressURL())
    return makeResponse(
        state: frameworkAvailable() ? "stopped" : "unavailable",
        detail: guestAddress == nil ? detailPrefix : "\(detailPrefix) No VM is currently attached to this helper process.",
        prepared: prepared,
        guestAddress: guestAddress
    )
}

func handleCommand(_ command: HelperCommand, runtime: AnyObject?) -> HelperResponse {
    switch command {
    case .status:
#if canImport(Virtualization)
        if #available(macOS 13.0, *), let runtime = runtime as? DirectVMRuntime {
            return runtime.status(prepared: preparedState())
        }
#endif
        return handleStaticStatus()

    case .prepare:
        return handlePrepare()

    case .start:
        guard preparedState() else {
            return makeResponse(
                state: "error",
                detail: "VM artifacts are not prepared yet. Run prepare first.",
                prepared: false
            )
        }
#if canImport(Virtualization)
        if #available(macOS 13.0, *), let runtime = runtime as? DirectVMRuntime {
            return runtime.start(config: helperConfigOrFailure())
        }
#endif
        return makeResponse(
            state: "error",
            detail: "Direct VM start requires the helper daemon process.",
            prepared: preparedState()
        )

    case .stop:
#if canImport(Virtualization)
        if #available(macOS 13.0, *), let runtime = runtime as? DirectVMRuntime {
            return runtime.stop(prepared: preparedState())
        }
#endif
        return makeResponse(
            state: "error",
            detail: "Direct VM stop requires the helper daemon process.",
            prepared: preparedState()
        )

    case .daemon:
        return makeResponse(
            state: "error",
            detail: "The daemon command must be run as a streaming process.",
            prepared: preparedState()
        )
    }
}

func makeHelperSocketListener() throws -> Int32 {
    let listenerFD = socket(AF_UNIX, SOCK_STREAM, 0)
    guard listenerFD >= 0 else {
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }

    let socketPath = helperSocketURL().path
    let maxPathLength = MemoryLayout.size(ofValue: sockaddr_un().sun_path)
    guard socketPath.utf8.count < maxPathLength else {
        Darwin.close(listenerFD)
        throw NSError(
            domain: "camelai.vm-helper",
            code: 901,
            userInfo: [NSLocalizedDescriptionKey: "Helper socket path is too long: \(socketPath)"]
        )
    }

    removeIfExists(helperSocketURL())

    var address = sockaddr_un()
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    address.sun_family = sa_family_t(AF_UNIX)
    socketPath.withCString { pathCString in
        withUnsafeMutablePointer(to: &address.sun_path) { pathPointer in
            let rawPath = UnsafeMutableRawPointer(pathPointer).assumingMemoryBound(to: CChar.self)
            strncpy(rawPath, pathCString, maxPathLength - 1)
            rawPath[maxPathLength - 1] = 0
        }
    }

    let addressLength = socklen_t(MemoryLayout.size(ofValue: address))
    let bindResult = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.bind(listenerFD, $0, addressLength)
        }
    }
    guard bindResult == 0 else {
        let bindError = errno
        Darwin.close(listenerFD)
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(bindError))
    }

    guard listen(listenerFD, SOMAXCONN) == 0 else {
        let listenError = errno
        Darwin.close(listenerFD)
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(listenError))
    }

    return listenerFD
}

func readSingleJSONLine(from clientFD: Int32) throws -> String? {
    var buffer = Data()
    var chunk = [UInt8](repeating: 0, count: 4096)

    while true {
        let bytesRead = Darwin.read(clientFD, &chunk, chunk.count)
        if bytesRead > 0 {
            buffer.append(chunk, count: Int(bytesRead))
            if let newlineIndex = buffer.firstIndex(of: 0x0A) {
                let line = buffer.prefix(upTo: newlineIndex)
                return String(data: line, encoding: .utf8)
            }
            continue
        }

        if bytesRead == 0 {
            if buffer.isEmpty {
                return nil
            }
            return String(data: buffer, encoding: .utf8)
        }

        if errno == EINTR {
            continue
        }

        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
}

func writeDaemonResponse(_ response: HelperDaemonResponse, to clientFD: Int32) throws {
    let encoder = JSONEncoder()
    let responseData = try encoder.encode(response)
    try responseData.withUnsafeBytes { rawBuffer in
        _ = try writeAll(to: clientFD, buffer: rawBuffer)
    }
    let newline = Data([0x0A])
    try newline.withUnsafeBytes { rawBuffer in
        _ = try writeAll(to: clientFD, buffer: rawBuffer)
    }
}

func runDaemon() -> Never {
#if canImport(Virtualization)
    let runtime: AnyObject? = if #available(macOS 13.0, *) {
        DirectVMRuntime()
    } else {
        nil
    }
#else
    let runtime: AnyObject? = nil
#endif

    signal(SIGPIPE, SIG_IGN)
    clearGuestRuntimeMarkers()
    persistHelperPID()

    let listenerFD: Int32
    do {
        try ensureDirectory(artifactsDirectoryURL())
        listenerFD = try makeHelperSocketListener()
    } catch {
        failure("Failed to create helper daemon socket: \(error.localizedDescription)")
    }

    defer {
        Darwin.close(listenerFD)
        removeIfExists(helperSocketURL())
        removeIfExists(helperPIDURL())
    }

    while true {
        let clientFD = accept(listenerFD, nil, nil)
        if clientFD == -1 {
            if errno == EINTR {
                continue
            }
            break
        }
        DispatchQueue.global().async {
            handleDaemonClient(clientFD, runtime: runtime)
        }
    }

    exit(EXIT_SUCCESS)
}

let arguments = CommandLine.arguments.dropFirst().filter { $0 != "--json" }
guard let commandName = arguments.first, let command = HelperCommand(rawValue: commandName) else {
    failure("usage: camelai-vm-helper <status|prepare|start|stop|daemon> [--json]")
}

if command == .daemon {
    runDaemon()
}

emitAndExit(handleCommand(command, runtime: nil))
