import AppKit
import PulseKit

/// Settings › Terminal: everything terminal tabs can be told, in one place.
@MainActor
enum TerminalSettings {
    private static let d = UserDefaults.standard

    private static func flag(_ key: String, _ fallback: Bool = true) -> Bool { d.object(forKey: key) as? Bool ?? fallback }

    private static func toggle(_ key: String) -> SettingsControl {
        .toggle(get: { flag(key) }, set: { d.set($0, forKey: key) })
    }

    /// Shells this Mac has, as (path, name).
    static var shells: [(String, String)] {
        let listed = ((try? String(contentsOfFile: "/etc/shells", encoding: .utf8)) ?? "").split(separator: "\n").map(String.init).filter { $0.hasPrefix("/") }
        let extra = ["/opt/homebrew/bin/fish", "/opt/homebrew/bin/nu", "/usr/local/bin/fish"]
        let all = (listed + extra).filter { FileManager.default.isExecutableFile(atPath: $0) }
        var seen = Set<String>()
        return [("", String(localized: "Login shell"))] + all.filter { seen.insert($0).inserted }.map { ($0, ($0 as NSString).lastPathComponent + "  (" + $0 + ")") }
    }

    static func rows() -> [SettingsRow] {
        [
            .section(String(localized: "Look")),
            .card(title: String(localized: "Text size"), detail: String(localized: "⌘+ and ⌘− in a terminal tab change it too."), icon: "type",
                  control: .choice(options: (10...20).map { (String($0), "\($0) pt") },
                                   get: { String(Int(TerminalPane.fontSize)) },
                                   set: { TerminalPane.fontSize = CGFloat(Int($0) ?? 13) })),
            .card(title: String(localized: "Welcome card"), detail: String(localized: "The PULSE card with this folder's Git state and scripts when a terminal opens."), icon: "layout-grid",
                  control: toggle("terminalWelcome")),
            .card(title: String(localized: "Box prompt"), detail: String(localized: "zsh's prompt drawn as the card's input box, with the folder and branch in its edge. Only replaces macOS's default prompt."), icon: "square-chevron-right",
                  control: toggle("terminalPrompt")),
            .section(String(localized: "Shell")),
            .card(title: String(localized: "Shell"), detail: String(localized: "For new terminal tabs."), icon: "square-terminal",
                  control: .choice(options: shells, get: { d.string(forKey: "terminalShell") ?? "" }, set: { d.set($0, forKey: "terminalShell") })),
            .section(String(localized: "Agents")),
            .card(title: String(localized: "Tell me when an agent waits"), detail: String(localized: "A notification when Claude Code, Codex, Gemini… stop to ask while their tab is out of sight."), icon: "bell",
                  control: toggle("terminalAgentNotifications")),
            .card(title: String(localized: "Waiting after"), detail: String(localized: "How long an agent must be quiet to count as waiting for you."), icon: "clock",
                  control: .choice(options: [("2", "2 s"), ("3", "3 s"), ("5", "5 s"), ("8", "8 s")],
                                   get: { let v = d.double(forKey: "terminalAgentQuietSeconds"); return String(Int(v == 0 ? 3 : v)) },
                                   set: { d.set(Double($0) ?? 3, forKey: "terminalAgentQuietSeconds") })),
            .card(title: String(localized: "More agents"), detail: (d.string(forKey: "terminalExtraAgents") ?? "").isEmpty
                    ? String(localized: "Program names to treat as agents, besides the known ones.")
                    : d.string(forKey: "terminalExtraAgents"),
                  icon: "bot", control: .buttons([(String(localized: "Edit…"), { editExtraAgents() })])),
            .section(String(localized: "Scrollback")),
            .card(title: String(localized: "Keep scrollback"), detail: String(localized: "A terminal tab that comes back after Pulse restarts shows what it showed before."), icon: "archive",
                  control: toggle("terminalKeepScrollback")),
            .card(title: String(localized: "Saved scrollback"), detail: savedSize(), icon: "trash",
                  control: .buttons([(String(localized: "Clear"), {
                      if let f = TerminalHistory.folder { try? FileManager.default.removeItem(at: f) }
                      NotificationCenter.default.post(name: .rfSettingsChanged, object: nil, userInfo: ["key": "terminal"])
                  })])),
        ]
    }

    private static func savedSize() -> String {
        guard let f = TerminalHistory.folder, let files = try? FileManager.default.contentsOfDirectory(at: f, includingPropertiesForKeys: [.fileSizeKey]) else {
            return String(localized: "Nothing saved")
        }
        let bytes = files.reduce(0) { $0 + ((try? $1.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) }
        return String(localized: "\(files.count) tabs · \(ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file))")
    }

    private static func editExtraAgents() {
        let a = NSAlert()
        a.messageText = String(localized: "More agents")
        a.informativeText = String(localized: "Program names, separated by spaces (as their command is called).")
        let f = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24))
        f.stringValue = d.string(forKey: "terminalExtraAgents") ?? ""
        a.accessoryView = f
        a.addButton(withTitle: String(localized: "Save"))
        a.addButton(withTitle: String(localized: "Cancel"))
        guard a.runModal() == .alertFirstButtonReturn else { return }
        let names = f.stringValue.split(whereSeparator: { $0 == " " || $0 == "," }).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        d.set(names.joined(separator: " "), forKey: "terminalExtraAgents")
        NotificationCenter.default.post(name: .rfSettingsChanged, object: nil, userInfo: ["key": "terminal"])
    }
}
