import Foundation

/// What a terminal pane is doing, for the tab's mark, the Agents panel and notifications (herdr's idea: know which agent
/// needs you without looking at every pane).
///
/// An agent at work keeps drawing (its spinner, its stream of text); one that waits for an answer goes quiet, and often
/// rings the bell. So: an agent program in front that has said nothing for a few seconds, or has just rung, is waiting.
public enum AgentStatus: String, Equatable, Sendable, CaseIterable {
    /// At the prompt.
    case idle
    /// A command other than an agent runs.
    case running
    /// An agent works (output flowing).
    case working
    /// An agent waits for you (quiet, or it rang the bell).
    case waiting

    /// Coding agents by program name (the shell integration's list, ShellIntegration).
    public static let agentNames: Set<String> = [
        "claude", "claude-code", "agy", "antigravity", "codex", "gemini", "aider", "opencode", "amp", "cursor-agent",
        "goose", "crush", "qwen", "droid", "copilot",
    ]

    public static func isAgent(_ program: String?, extra: Set<String> = []) -> Bool {
        guard let p = program?.lowercased() else { return false }
        let base = p.hasSuffix("-cli") ? String(p.dropLast(4)) : p
        return agentNames.contains(base) || extra.contains(base)
    }

    /// The status from what runs in front, how long since the pane last printed, and whether it rang lately.
    public static func of(program: String?, quietFor: TimeInterval, rang: Bool, quietAfter: TimeInterval = 3, extra: Set<String> = []) -> AgentStatus {
        guard let program else { return .idle }
        guard isAgent(program, extra: extra) else { return .running }
        return rang || quietFor >= quietAfter ? .waiting : .working
    }

    /// The mark a tab shows for it.
    public var mark: String {
        switch self {
        case .idle: ""
        case .running: ""
        case .working: "◌ "
        case .waiting: "◐ "
        }
    }

    public var label: String {
        switch self {
        case .idle: "At the prompt"
        case .running: "Running"
        case .working: "Working"
        case .waiting: "Waiting for you"
        }
    }

    /// Whether going from `old` to this should tell the user (an agent that stops to ask, out of sight).
    public func notifies(from old: AgentStatus) -> Bool { self == .waiting && old == .working }
}

/// Finds the bell in a terminal's output, leaving out the BEL that ends an OSC sequence (ESC ] … BEL), which is no bell.
public struct BellScanner: Sendable {
    private var inOSC = false
    private var sawEsc = false
    public init() {}

    /// True when `bytes` held a real bell.
    public mutating func scan<C: Collection>(_ bytes: C) -> Bool where C.Element == UInt8 {
        var rang = false
        for b in bytes {
            if inOSC {
                if b == 0x07 { inOSC = false } else if sawEsc && b == 0x5C { inOSC = false }  // BEL or ST (ESC \)
                sawEsc = b == 0x1B
                continue
            }
            if sawEsc && b == 0x5D { inOSC = true }  // ESC ]
            else if b == 0x07 { rang = true }
            sawEsc = b == 0x1B
        }
        return rang
    }
}

/// The last part of a terminal's output, kept so a restored tab opens with what it showed (a ring of bytes).
public struct ScrollbackRing: Sendable {
    public let capacity: Int
    private(set) var data = Data()
    public init(capacity: Int = 256 * 1024) { self.capacity = capacity }

    public mutating func append<C: Collection>(_ bytes: C) where C.Element == UInt8 {
        data.append(contentsOf: bytes)
        if data.count > capacity {
            // cut at a line start, so the restored text doesn't begin halfway through an escape sequence
            var cut = data.count - capacity
            if let nl = data[cut...].firstIndex(of: 0x0A) { cut = nl + 1 }
            data = Data(data[cut...])
        }
    }

    public var bytes: Data { data }

    /// What to show again: the saved bytes with full-screen programs' switches taken out (a restored tab is never in
    /// another program's alternate screen) and the colours reset at the end.
    public static func replay(_ saved: Data) -> Data {
        var text = String(decoding: saved, as: UTF8.self)
        for seq in ["\u{1B}[?1049h", "\u{1B}[?1049l", "\u{1B}[?47h", "\u{1B}[?47l", "\u{1B}[?1047h", "\u{1B}[?1047l"] {
            text = text.replacingOccurrences(of: seq, with: "")
        }
        return Data((text + "\u{1B}[0m").utf8)
    }
}
