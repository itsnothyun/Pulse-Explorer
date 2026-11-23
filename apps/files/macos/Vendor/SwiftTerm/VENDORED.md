# SwiftTerm, vendored

The terminal engine behind Pulse Explorer's terminal tabs (`Sources/RustyFiles/TerminalTabs.swift`).

- Upstream: https://github.com/migueldeicaza/SwiftTerm (MIT, © Miguel de Icaza; see LICENSE)
- Taken from: v1.99.3, commit 282c3c3a932b55c129628876b70f37d993af1615
- Kept: `Sources/SwiftTerm`, the build-info plugin and its generator, `swifterm-terminfo` (the generator reads it), LICENSE, README.md
- Left out: tests, fuzzer, termcast, demo apps, docs, and the Embedded / WebAssembly / Linux / Windows build modes
  (the PNG dependency they need is not used on macOS)

Pulse's own changes to this copy, if any, are listed below so an update from upstream can carry them over.

## Pulse changes

- `Package.swift` rewritten to the library only (above).
