import Containerization
import ContainerizationError
import ContainerizationExtras
import Darwin
import Foundation

struct HelperResponse: Codable {
    let state: String
    let detail: String
    let helperPath: String?
    let prepared: Bool
    let runtimeDirectory: String?
    let containerID: String?
    let controlPlaneAddress: String?
    let controlPlanePort: Int?
    let imageReference: String?
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

struct HelperMetadata: Codable {
    let pid: Int32
    let helperPath: String?
    let helperMtimeMs: UInt64?
}

enum HelperCommand: String {
    case status
    case prepare
    case start
    case stop
    case daemon
}

let environment = ProcessInfo.processInfo.environment
let instanceName = environment["DESKTOP_RUNTIME_INSTANCE_NAME"] ?? "camelai-desktop"
let runtimeImageReference =
    environment["DESKTOP_RUNTIME_IMAGE"] ?? "docker.io/vercantes/camelai-openwork:20260403-v3"
let initfsReference =
    environment["DESKTOP_RUNTIME_INITFS_REFERENCE"]
    ?? "ghcr.io/apple/containerization/vminit:0.26.5"
let controlPlanePort = Int(
    environment["DESKTOP_RUNTIME_CONTROL_PLANE_PORT"]
        ?? "4317"
) ?? 4317
let requestedCPUCount = Int(environment["DESKTOP_RUNTIME_CPUS"] ?? "4") ?? 4
let memoryMiB = Int(environment["DESKTOP_RUNTIME_MEMORY_MIB"] ?? "4096") ?? 4096
let rootfsMiB = UInt64(environment["DESKTOP_RUNTIME_ROOTFS_MIB"] ?? "4096") ?? 4096
let runtimeMountPath = "/mnt/camelai-shared"
let runtimeContainerAddress = environment["DESKTOP_RUNTIME_ADDRESS"] ?? "192.168.64.2/24"
let runtimeContainerHostAddress = runtimeContainerAddress.split(separator: "/").first.map(String.init)
    ?? "192.168.64.2"
let runtimeContainerGateway = environment["DESKTOP_RUNTIME_GATEWAY"] ?? "192.168.64.1"
let runtimeContainerNameservers = (environment["DESKTOP_RUNTIME_NAMESERVERS"] ?? runtimeContainerGateway)
    .split(separator: ",")
    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
    .filter { !$0.isEmpty }

protocol RuntimeHandling: Sendable {
    func status(prepared: Bool) async -> HelperResponse
    func start(prepared: Bool) async -> HelperResponse
    func stop(prepared: Bool) async -> HelperResponse
}

func isStaleContainerBundleError(_ error: any Error) -> Bool {
    if let containerizationError = error as? ContainerizationError {
        return containerizationError.code == .exists
    }

    let nsError = error as NSError
    return nsError.domain == NSCocoaErrorDomain && nsError.code == NSFileWriteFileExistsError
}

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

func runtimeDirectoryURL() -> URL {
    if let configured = environment["DESKTOP_RUNTIME_DIR"], !configured.isEmpty {
        return URL(fileURLWithPath: configured, isDirectory: true)
    }
    return repoRoot()
        .appendingPathComponent("desktop", isDirectory: true)
        .appendingPathComponent(".local", isDirectory: true)
        .appendingPathComponent("runtime", isDirectory: true)
}

func sharedDirectoryURL() -> URL {
    runtimeDirectoryURL().appendingPathComponent("shared", isDirectory: true)
}

func artifactsDirectoryURL() -> URL {
    runtimeDirectoryURL().appendingPathComponent("artifacts", isDirectory: true)
}

func helperSocketURL() -> URL {
    artifactsDirectoryURL().appendingPathComponent("helper.sock")
}

func helperPIDURL() -> URL {
    artifactsDirectoryURL().appendingPathComponent("helper.pid")
}

func helperMetadataURL() -> URL {
    artifactsDirectoryURL().appendingPathComponent("helper-metadata.json")
}

func runtimeStatusURL() -> URL {
    sharedDirectoryURL().appendingPathComponent("runtime/status.txt")
}

func kernelBinaryURL() -> URL {
    if let configured = environment["DESKTOP_RUNTIME_KERNEL_PATH"], !configured.isEmpty {
        return URL(fileURLWithPath: configured)
    }
    return repoRoot()
        .appendingPathComponent("desktop", isDirectory: true)
        .appendingPathComponent("runtime-helper", isDirectory: true)
        .appendingPathComponent("assets", isDirectory: true)
        .appendingPathComponent("vmlinux")
}

func containerizationRootURL() -> URL {
    runtimeDirectoryURL().appendingPathComponent("containerization", isDirectory: true)
}

func runtimeContainerBundleURL() -> URL {
    containerizationRootURL()
        .appendingPathComponent("containers", isDirectory: true)
        .appendingPathComponent(instanceName, isDirectory: true)
}

func runtimeContainerRootfsURL() -> URL {
    runtimeContainerBundleURL().appendingPathComponent("rootfs.ext4")
}

func cachedRootfsURL() -> URL {
    artifactsDirectoryURL().appendingPathComponent("rootfs-cache-v3.ext4")
}

func serviceLogURL() -> URL {
    sharedDirectoryURL().appendingPathComponent("logs/control-plane-service.log")
}

func bootLogURL() -> URL {
    sharedDirectoryURL().appendingPathComponent("logs/runtime-boot.log")
}

func helperPath() -> String? {
    CommandLine.arguments.first
}

func removeIfExists(_ url: URL) {
    try? FileManager.default.removeItem(at: url)
}

func pathIsReadableFile(_ url: URL) -> Bool {
    FileManager.default.isReadableFile(atPath: url.path)
}

func ensureDirectory(_ url: URL) throws {
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
}

func truncateFile(_ url: URL) {
    try? ensureDirectory(url.deletingLastPathComponent())
    FileManager.default.createFile(atPath: url.path, contents: nil)
}

func writeRuntimeStatus(_ value: String) {
    try? ensureDirectory(runtimeStatusURL().deletingLastPathComponent())
    try? "\(value)\n".write(to: runtimeStatusURL(), atomically: true, encoding: .utf8)
}

func removeRuntimeContainerBundle() {
    removeIfExists(runtimeContainerBundleURL())
}

func replaceCachedRootfsIfPresent() {
    let currentRootfs = runtimeContainerRootfsURL()
    guard pathIsReadableFile(currentRootfs) else {
        return
    }

    let cacheRootfs = cachedRootfsURL()
    try? ensureDirectory(cacheRootfs.deletingLastPathComponent())
    removeIfExists(cacheRootfs)
    do {
        try FileManager.default.moveItem(at: currentRootfs, to: cacheRootfs)
    } catch {
        try? FileManager.default.copyItem(at: currentRootfs, to: cacheRootfs)
    }
}

@available(macOS 26.0, *)
func makeRuntimeContainerManager(kernel: Kernel) async throws -> ContainerManager {
    try await ContainerManager(
        kernel: kernel,
        initfsReference: initfsReference,
        root: containerizationRootURL()
    )
}

@available(macOS 26.0, *)
func makeRuntimeNetworkInterface() throws -> NATInterface {
    NATInterface(
        ipv4Address: try CIDRv4(runtimeContainerAddress),
        ipv4Gateway: try IPv4Address(runtimeContainerGateway)
    )
}

func preparedState() -> Bool {
    helperIsAvailable() && pathIsReadableFile(kernelBinaryURL())
}

func persistHelperPID() {
    try? ensureDirectory(artifactsDirectoryURL())
    try? "\(getpid())\n".write(to: helperPIDURL(), atomically: true, encoding: .utf8)
}

func persistHelperMetadata() {
    let helperURL = helperPath().map { URL(fileURLWithPath: $0) }
    let helperMtimeMs = helperURL
        .flatMap { try? FileManager.default.attributesOfItem(atPath: $0.path) }
        .flatMap { $0[.modificationDate] as? Date }
        .map { UInt64($0.timeIntervalSince1970 * 1000) }

    let metadata = HelperMetadata(
        pid: getpid(),
        helperPath: helperPath(),
        helperMtimeMs: helperMtimeMs
    )

    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    if let data = try? encoder.encode(metadata) {
        try? data.write(to: helperMetadataURL(), options: .atomic)
    }
}

func helperIsAvailable() -> Bool {
    if #available(macOS 26.0, *) {
        return true
    }
    return false
}

func baseDetail(prepared: Bool) -> String {
    if helperIsAvailable() {
        return prepared
            ? "Container runtime assets are available locally. The desktop app will start the control-plane container automatically."
            : "Apple containerization support is available, but the runtime kernel is missing."
    }
    return "Apple containerization support is not available in this build environment."
}

func describeError(_ error: any Error) -> String {
    if let containerizationError = error as? ContainerizationError {
        if let cause = containerizationError.cause {
            return "\(containerizationError.code): \(containerizationError.message) (cause: \(String(reflecting: cause)))"
        }
        return "\(containerizationError.code): \(containerizationError.message)"
    }

    let nsError = error as NSError
    if nsError.domain != NSCocoaErrorDomain || nsError.code != 0 {
        return "\(nsError.domain) \(nsError.code): \(nsError.localizedDescription)"
    }

    return String(reflecting: error)
}

func makeResponse(
    state: String,
    detail: String,
    prepared: Bool,
    controlPlaneAddress: String? = nil,
    controlPlanePortValue: Int? = nil
) -> HelperResponse {
    HelperResponse(
        state: state,
        detail: detail,
        helperPath: helperPath(),
        prepared: prepared,
        runtimeDirectory: runtimeDirectoryURL().path,
        containerID: instanceName,
        controlPlaneAddress: controlPlaneAddress,
        controlPlanePort: controlPlanePortValue,
        imageReference: runtimeImageReference
    )
}

func writeAll(to fileDescriptor: Int32, buffer: UnsafeRawBufferPointer) throws -> Int {
    var totalWritten = 0
    while totalWritten < buffer.count {
        let bytesWritten = Darwin.write(
            fileDescriptor,
            buffer.baseAddress!.advanced(by: totalWritten),
            buffer.count - totalWritten
        )
        if bytesWritten > 0 {
            totalWritten += bytesWritten
            continue
        }
        if bytesWritten == -1 && errno == EINTR {
            continue
        }
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    return totalWritten
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
            return buffer.isEmpty ? nil : String(data: buffer, encoding: .utf8)
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
            domain: "camelai.runtime-helper",
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

func ensureKernelBinary() throws {
    guard pathIsReadableFile(kernelBinaryURL()) else {
        throw NSError(
            domain: "camelai.runtime-helper",
            code: 902,
            userInfo: [
                NSLocalizedDescriptionKey:
                    "Runtime kernel is missing at \(kernelBinaryURL().path). Build or stage the app runtime assets first."
            ]
        )
    }
}

func handlePrepare() -> HelperResponse {
    guard helperIsAvailable() else {
        return makeResponse(
            state: "unavailable",
            detail: "Apple containerization support is not available in this build environment.",
            prepared: false
        )
    }

    do {
        try ensureDirectory(runtimeDirectoryURL())
        try ensureDirectory(sharedDirectoryURL())
        try ensureDirectory(artifactsDirectoryURL())
        try ensureDirectory(containerizationRootURL())
        try ensureDirectory(sharedDirectoryURL().appendingPathComponent("logs", isDirectory: true))
        try ensureDirectory(sharedDirectoryURL().appendingPathComponent("runtime", isDirectory: true))
        try ensureDirectory(sharedDirectoryURL().appendingPathComponent("runtime/container-home", isDirectory: true))
        try ensureDirectory(sharedDirectoryURL().appendingPathComponent("workspace", isDirectory: true))
        try ensureKernelBinary()
        writeRuntimeStatus("runtime-assets-ready")
        return makeResponse(
            state: "stopped",
            detail: "Validated the local runtime assets and initialized the runtime directories.",
            prepared: preparedState()
        )
    } catch {
        return makeResponse(
            state: "error",
            detail: "Failed to prepare the local runtime assets: \(error.localizedDescription)",
            prepared: false
        )
    }
}

func handleStaticStatus() -> HelperResponse {
    let prepared = preparedState()
    return makeResponse(
        state: helperIsAvailable() ? "stopped" : "unavailable",
        detail: baseDetail(prepared: prepared),
        prepared: prepared
    )
}

final class FileLogWriter: Writer, @unchecked Sendable {
    private let handle: FileHandle
    private let lock = NSLock()

    init(url: URL) throws {
        try ensureDirectory(url.deletingLastPathComponent())
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: nil)
        }
        self.handle = try FileHandle(forWritingTo: url)
        try self.handle.seekToEnd()
    }

    func write(_ data: Data) throws {
        lock.lock()
        defer { lock.unlock() }
        try handle.seekToEnd()
        try handle.write(contentsOf: data)
    }

    func close() throws {
        lock.lock()
        defer { lock.unlock() }
        try handle.close()
    }
}

@available(macOS 26.0, *)
actor ContainerRuntime: RuntimeHandling {
    private var container: LinuxContainer?
    private var containerWaitTask: Task<Void, Never>?
    private var state = "stopped"
    private var detail = baseDetail(prepared: preparedState())
    private var controlPlaneAddress: String?
    private var stopping = false
    private let logWriter: FileLogWriter?

    init() {
        self.logWriter = try? FileLogWriter(url: serviceLogURL())
    }

    private func setStartingDetail(_ message: String, runtimeStatus: String? = nil) {
        state = "starting"
        detail = message
        if let runtimeStatus {
            writeRuntimeStatus(runtimeStatus)
        }
    }

    func status(prepared: Bool) async -> HelperResponse {
        switch state {
        case "running":
            return makeResponse(
                state: "running",
                detail: detail,
                prepared: prepared,
                controlPlaneAddress: controlPlaneAddress,
                controlPlanePortValue: controlPlanePort
            )
        case "starting":
            return makeResponse(
                state: "starting",
                detail: detail,
                prepared: prepared,
                controlPlaneAddress: controlPlaneAddress,
                controlPlanePortValue: controlPlanePort
            )
        case "error":
            return makeResponse(
                state: "error",
                detail: detail,
                prepared: prepared,
                controlPlaneAddress: controlPlaneAddress,
                controlPlanePortValue: controlPlanePort
            )
        default:
            return makeResponse(
                state: helperIsAvailable() ? "stopped" : "unavailable",
                detail: baseDetail(prepared: prepared),
                prepared: prepared
            )
        }
    }

    func start(prepared: Bool) async -> HelperResponse {
        let prepared = preparedState()
        if container != nil, state == "running" {
            return await status(prepared: prepared)
        }

        guard prepared else {
            do {
                _ = handlePrepare()
            }
            let preparedAfterSetup = preparedState()
            guard preparedAfterSetup else {
                return makeResponse(
                    state: "error",
                    detail: "Runtime kernel is missing. Build or stage the runtime assets first.",
                    prepared: false
                )
            }
            return await start(prepared: preparedAfterSetup)
        }

        stopping = false
        setStartingDetail(
            "Preparing the local Linux runtime and checking the control-plane image.",
            runtimeStatus: "starting-runtime-container"
        )
        truncateFile(serviceLogURL())
        truncateFile(bootLogURL())

        do {
            var kernel = Kernel(path: kernelBinaryURL(), platform: .linuxArm)
            kernel.commandLine.addDebug()
            kernel.commandLine.kernelArgs.append("oops=panic")

            if let container {
                try? await container.stop()
                self.container = nil
            }

            setStartingDetail(
                "Loading the lightweight Linux init runtime.",
                runtimeStatus: "resolving-init-image"
            )
            var manager = try await makeRuntimeContainerManager(kernel: kernel)
            setStartingDetail(
                "Checking for the local control-plane image.",
                runtimeStatus: "resolving-container-image"
            )
            let image: Image
            do {
                image = try await manager.imageStore.get(reference: runtimeImageReference, pull: false)
            } catch {
                setStartingDetail(
                    "Pulling the control-plane image from Docker Hub. This can take a while on first boot.",
                    runtimeStatus: "pulling-container-image"
                )
                image = try await manager.imageStore.get(reference: runtimeImageReference, pull: true)
            }
            let imageConfig = try await image.config(for: .current).config

            let workspaceDir = "\(runtimeMountPath)/workspace"
            let envFile = "\(runtimeMountPath)/runtime/control-plane-env.sh"
            let processArguments = [
                "/bin/sh",
                "-lc",
                """
                set -e
                export DESKTOP_RUNTIME_SHARED_DIR="\(runtimeMountPath)"
                export DESKTOP_RUNTIME_CONTROL_PLANE_PORT="\(controlPlanePort)"
                if [ -f "\(envFile)" ]; then
                  set -a
                  . "\(envFile)"
                  set +a
                fi
                echo starting-control-plane > \(runtimeMountPath)/runtime/status.txt
                cd "\(workspaceDir)"
                exec node /opt/camelai-desktop-guest/control-plane.mjs
                """
            ]
            let runtimeInterface = try makeRuntimeNetworkInterface()
            let runtimeDNS = runtimeContainerNameservers.isEmpty ? nil : DNS(nameservers: runtimeContainerNameservers)
            let processOutputWriter = self.logWriter
            let processBaseConfig = imageConfig.map(LinuxProcessConfiguration.init(from:))
            let runtimeCPUs = max(2, requestedCPUCount)
            let runtimeMemoryBytes = UInt64(max(1024, memoryMiB)) * 1024 * 1024

            let configureContainer: @Sendable (inout LinuxContainer.Configuration) throws -> Void = { config in
                if let processBaseConfig {
                    config.process = processBaseConfig
                }
                config.cpus = runtimeCPUs
                config.memoryInBytes = runtimeMemoryBytes
                config.hostname = instanceName
                config.mounts.append(
                    .share(
                        source: sharedDirectoryURL().path,
                        destination: runtimeMountPath
                    )
                )
                config.interfaces = [runtimeInterface]
                if let runtimeDNS {
                    config.dns = runtimeDNS
                }
                config.bootLog = .file(path: bootLogURL(), append: true)
                config.process.arguments = processArguments
                if let writer = processOutputWriter {
                    config.process.stdout = writer
                    config.process.stderr = writer
                }
            }

            let container: LinuxContainer
            let warmRootfs = cachedRootfsURL()
            let hasWarmRootfs = pathIsReadableFile(warmRootfs)

            if hasWarmRootfs {
                do {
                    setStartingDetail(
                        "Reusing the cached container filesystem for a warm boot.",
                        runtimeStatus: "reusing-root-filesystem"
                    )
                    container = try await manager.create(
                        instanceName,
                        image: image,
                        rootfs: .block(format: "ext4", source: warmRootfs.path, destination: "/"),
                        networking: false,
                        configuration: configureContainer
                    )
                } catch {
                    removeRuntimeContainerBundle()
                    setStartingDetail(
                        "Rebuilding the container filesystem because the cached one was not usable.",
                        runtimeStatus: "creating-root-filesystem"
                    )
                    container = try await manager.create(
                        instanceName,
                        image: image,
                        rootfsSizeInBytes: rootfsMiB * 1024 * 1024,
                        networking: false,
                        configuration: configureContainer
                    )
                }
            } else {
                do {
                    setStartingDetail(
                        "Creating the container filesystem for the first local boot.",
                        runtimeStatus: "creating-root-filesystem"
                    )
                    container = try await manager.create(
                        instanceName,
                        image: image,
                        rootfsSizeInBytes: rootfsMiB * 1024 * 1024,
                        networking: false,
                        configuration: configureContainer
                    )
                } catch {
                    guard isStaleContainerBundleError(error) else {
                        throw error
                    }
                    removeRuntimeContainerBundle()
                    setStartingDetail(
                        "Retrying container filesystem creation after clearing stale runtime state.",
                        runtimeStatus: "creating-root-filesystem"
                    )
                    container = try await manager.create(
                        instanceName,
                        image: image,
                        rootfsSizeInBytes: rootfsMiB * 1024 * 1024,
                        networking: false,
                        configuration: configureContainer
                    )
                }
            }

            setStartingDetail(
                "Booting the lightweight Linux runtime.",
                runtimeStatus: "creating-runtime-vm"
            )
            try await container.create()
            if !hasWarmRootfs {
                replaceCachedRootfsIfPresent()
            }
            setStartingDetail(
                "Starting the control-plane server inside the runtime.",
                runtimeStatus: "starting-control-plane-process"
            )
            try await container.start()

            self.container = container
            self.controlPlaneAddress = runtimeContainerHostAddress
            self.state = "running"
            if let controlPlaneAddress {
                self.detail = "The local control-plane container is running at \(controlPlaneAddress):\(controlPlanePort)."
            } else {
                self.detail = "The local control-plane container is running."
            }
            writeRuntimeStatus("runtime-container-started")
            watchContainer(container)
            return await status(prepared: prepared)
        } catch {
            state = "error"
            detail = "Failed to start the local control-plane container: \(describeError(error))"
            controlPlaneAddress = nil
            container = nil
            writeRuntimeStatus("runtime-container-error")
            return await status(prepared: prepared)
        }
    }

    func stop(prepared: Bool) async -> HelperResponse {
        stopping = true
        defer { stopping = false }

        if let container {
            do {
                try await container.stop()
            } catch {
                state = "error"
                detail = "Failed to stop the local control-plane container: \(error.localizedDescription)"
                return await status(prepared: prepared)
            }
        }

        containerWaitTask?.cancel()
        containerWaitTask = nil
        container = nil
        controlPlaneAddress = nil
        replaceCachedRootfsIfPresent()
        removeRuntimeContainerBundle()
        state = "stopped"
        detail = baseDetail(prepared: prepared)
        writeRuntimeStatus("runtime-stopped")
        return await status(prepared: prepared)
    }

    private func watchContainer(_ container: LinuxContainer) {
        containerWaitTask?.cancel()
        containerWaitTask = Task {
            let exitStatus: ExitStatus
            do {
                exitStatus = try await container.wait()
            } catch {
                self.recordUnexpectedExit(detail: "The control-plane container exited with an error: \(error.localizedDescription)")
                return
            }
            self.recordContainerExit(exitCode: exitStatus.exitCode)
        }
    }

    private func recordContainerExit(exitCode: Int32) {
        guard !stopping else {
            return
        }
        state = "error"
        detail = "The control-plane container exited unexpectedly with code \(exitCode)."
        controlPlaneAddress = nil
        container = nil
        writeRuntimeStatus("control-plane-exited")
    }

    private func recordUnexpectedExit(detail: String) {
        guard !stopping else {
            return
        }
        state = "error"
        self.detail = detail
        controlPlaneAddress = nil
        container = nil
        writeRuntimeStatus("control-plane-exited")
    }
}

func handleCommand(_ command: HelperCommand, runtime: (any RuntimeHandling)?) async -> HelperResponse {
    switch command {
    case .status:
        if #available(macOS 26.0, *), let runtime {
            return await runtime.status(prepared: preparedState())
        }
        return handleStaticStatus()
    case .prepare:
        return handlePrepare()
    case .start:
        guard #available(macOS 26.0, *), let runtime else {
            return makeResponse(
                state: "error",
                detail: "Container runtime start requires the helper daemon process.",
                prepared: preparedState()
            )
        }
        return await runtime.start(prepared: preparedState())
    case .stop:
        guard #available(macOS 26.0, *), let runtime else {
            return makeResponse(
                state: "error",
                detail: "Container runtime stop requires the helper daemon process.",
                prepared: preparedState()
            )
        }
        return await runtime.stop(prepared: preparedState())
    case .daemon:
        return makeResponse(
            state: "error",
            detail: "The daemon command must be run as a streaming process.",
            prepared: preparedState()
        )
    }
}

func handleDaemonClient(_ clientFD: Int32, runtime: (any RuntimeHandling)?) async {
    defer {
        Darwin.close(clientFD)
    }

    var fallbackID = UUID().uuidString
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
        fallbackID = request.id

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

        let result = await handleCommand(command, runtime: runtime)
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
                id: fallbackID,
                ok: false,
                result: nil,
                error: error.localizedDescription
            ),
            to: clientFD
        )
    }
}

func runDaemon() -> Never {
    let runtime: (any RuntimeHandling)? = if #available(macOS 26.0, *) {
        ContainerRuntime()
    } else {
        nil
    }

    signal(SIGPIPE, SIG_IGN)
    persistHelperPID()
    persistHelperMetadata()

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
        removeIfExists(helperMetadataURL())
    }

    while true {
        let clientFD = accept(listenerFD, nil, nil)
        if clientFD == -1 {
            if errno == EINTR {
                continue
            }
            break
        }
        Task.detached {
            await handleDaemonClient(clientFD, runtime: runtime)
        }
    }

    exit(EXIT_SUCCESS)
}

@main
struct RuntimeHelperMain {
    static func main() async {
        let arguments = CommandLine.arguments.dropFirst().filter { $0 != "--json" }
        guard let commandName = arguments.first, let command = HelperCommand(rawValue: commandName) else {
            failure("usage: camelai-runtime-helper <status|prepare|start|stop|daemon> [--json]")
        }

        if command == .daemon {
            runDaemon()
        }

        let response = await handleCommand(command, runtime: nil)
        emitAndExit(response)
    }
}
