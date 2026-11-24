// swift-tools-version:6.2
// SwiftTerm, vendored into Pulse Explorer (see VENDORED.md): the library and its build-info plugin only; upstream's
// tests, fuzzer, demo apps and its Embedded / WebAssembly / Linux build modes are left out.

import PackageDescription

let package = Package(
    name: "SwiftTerm",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "SwiftTerm", targets: ["SwiftTerm"]),
    ],
    targets: [
        .target(
            name: "SwiftTerm",
            path: "Sources/SwiftTerm",
            exclude: ["Mac/README.md", "Apple/Metal/Shaders.metal"],
            plugins: [.plugin(name: "SwiftTermBuildInfoPlugin")]
        ),
        .executableTarget(name: "SwiftTermBuildInfoGenerator", path: "Sources/SwiftTermBuildInfoGenerator"),
        .plugin(name: "SwiftTermBuildInfoPlugin", capability: .buildTool(), dependencies: ["SwiftTermBuildInfoGenerator"]),
    ]
)
