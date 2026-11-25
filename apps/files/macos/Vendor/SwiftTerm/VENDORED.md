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
- `Mac/MacLocalTerminalView.swift`: `setProcessBytesHandler(_:)` (and the adapter's `bytesTap`) hands the raw output
  bytes to the host before parsing, for Pulse's agent status and kept scrollback.
- `Mac/MacTerminalView.swift`: `bellHandler`, told of every bell (whatever `bellStyle`), for agent status.
- `TerminalIOPipeline.swift`: the gather and parse threads get 8 MB stacks (512 KB overflowed now and then under the
  output tap: EXC_BAD_ACCESS in the stack guard of `swiftterm-io-reader`).
