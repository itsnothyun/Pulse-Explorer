// swift-tools-version: 6.0
// The macOS app. Build it with `macos/build.sh`, which first builds the Rust core
// (crates/rf-mac) and generates its Swift bindings into Sources/.

import Foundation
import PackageDescription

let repoRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().path

let package = Package(
    name: "RustyFiles",
    platforms: [.macOS("26.0")],
    dependencies: [
        // Terminal tabs: SwiftTerm (MIT, Miguel de Icaza), from Pulse's own fork so it can carry our patches; pinned.
        .package(url: "https://github.com/itsnothyun/SwiftTerm", exact: "1.99.3"),
    ],
    targets: [
        // The C header UniFFI generates for the Rust core (copied in by build.sh).
        .target(name: "rf_macFFI", path: "Sources/rf_macFFI"),
        // Pulse's features as plain, testable logic (no windows): naming, scanning, parsing, storage, text recognition.
        .target(name: "PulseKit", path: "Sources/PulseKit"),
        .testTarget(name: "PulseKitTests", dependencies: ["PulseKit"], path: "Tests/PulseKitTests"),
        .executableTarget(
            name: "RustyFiles",
            dependencies: ["rf_macFFI", "PulseKit", .product(name: "SwiftTerm", package: "SwiftTerm")],
            path: "Sources/RustyFiles",
            linkerSettings: [
                // The static library by full path, so the linker never picks the .dylib next to it.
                .unsafeFlags(["\(repoRoot)/target/mac/release/librf_mac.a"]),
                .linkedFramework("AppKit"),
                .linkedFramework("Quartz"),
                .linkedFramework("CoreWLAN"),
                .linkedFramework("CoreFoundation"),
                .linkedLibrary("iconv"),
            ]
        ),
    ],
    swiftLanguageModes: [.v5]
)
