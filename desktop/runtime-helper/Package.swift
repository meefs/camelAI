// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "camelai-runtime-helper",
    platforms: [
        .macOS("15")
    ],
    products: [
        .executable(name: "camelai-runtime-helper", targets: ["camelai-runtime-helper"])
    ],
    dependencies: [
        .package(
            url: "https://github.com/apple/containerization.git",
            .upToNextMinor(from: "0.29.0")
        )
    ],
    targets: [
        .executableTarget(
            name: "camelai-runtime-helper",
            dependencies: [
                .product(name: "Containerization", package: "containerization"),
                .product(name: "ContainerizationExtras", package: "containerization")
            ],
            path: "Sources"
        )
    ]
)
