// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "camelai-vm-helper",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "camelai-vm-helper", targets: ["camelai-vm-helper"])
    ],
    targets: [
        .executableTarget(
            name: "camelai-vm-helper",
            path: "Sources"
        )
    ]
)
