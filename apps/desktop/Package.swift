// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "Ellie",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "Ellie", targets: ["Ellie"]),
    ],
    targets: [
        .executableTarget(
            name: "Ellie",
            path: "Sources/Ellie"
        ),
        .testTarget(
            name: "EllieTests",
            dependencies: ["Ellie"],
            path: "Tests/EllieTests"
        ),
    ],
    swiftLanguageModes: [.v5]
)
