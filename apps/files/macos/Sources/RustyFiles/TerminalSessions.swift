import Foundation

/// Terminal panes whose shells outlive Pulse: each pane runs in a tmux session of its own, on Pulse's own tmux server
/// (socket "pulse-explorer", its own config, nothing shared with the user's tmux). Quitting Pulse, or Pulse crashing, leaves the
/// sessions running, Claude Code and the other agents in them included; the tab that comes back attaches to its session
/// again. Closing a tab ends its session; sessions no tab names any more are ended at the next start.
///
/// The tmux is invisible: no status line, no prefix key (every key goes to the program), titles, the bell, links and the
/// clipboard passed through, and the outer terminal keeps the scrollback (tmux draws on the main screen).
/// Off when tmux is not installed, or with Settings › Terminal (UserDefaults terminalKeepRunning = false).
enum TerminalSessions {
    static let socket = "pulse-explorer"

    /// tmux, where Homebrew and MacPorts put it (Pulse started from the Dock has a short PATH).
    nonisolated static let tmux: String? = {
        let path = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map(String.init)
        let candidates = ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"] + path
        return candidates.map { $0 + "/tmux" }.first { FileManager.default.isExecutableFile(atPath: $0) }
    }()

    static var enabled: Bool {
        tmux != nil && (UserDefaults.standard.object(forKey: "terminalKeepRunning") as? Bool ?? true)
    }

    /// Pulse's tmux config, written fresh in Application Support.
    static func config() -> String? {
        guard let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return nil }
        let dir = support.appendingPathComponent("Pulse Explorer/tmux", isDirectory: true)
        let file = dir.appendingPathComponent("pulse.tmux.conf")
        let text = """
        # Pulse Explorer's own tmux (TerminalSessions.swift): keeps terminal panes running when Pulse quits; invisible.
        set -g status off
        set -g prefix None
        set -g prefix2 None
        set -g mouse off
        set -g escape-time 0
        set -g focus-events on
        set -g allow-passthrough on
        set -g set-clipboard on
        set -g extended-keys on
        set -g default-terminal "xterm-256color"
        set -ga terminal-features ",xterm-256color:RGB:hyperlinks:clipboard:extkeys:focus:title"
        # the program's title goes to Pulse's tab; the bell to Pulse's agent status
        set -g set-titles on
        # (tmux's own default title is the host name: sent as nothing, so Pulse names the tab by what runs, as without tmux)
        set -g set-titles-string "#{?#{==:#{pane_title},#{host}},,#{pane_title}}"
        set -g bell-action any
        set -g visual-bell off
        set -g monitor-bell on
        # drawn on the main screen: Pulse's own scrollback, selection and find keep working
        set -ga terminal-overrides ",xterm-256color:smcup@:rmcup@"
        set -g history-limit 2000
        set -g aggressive-resize on
        set -g destroy-unattached off
        set -g exit-empty on
        set -g remain-on-exit off
        """
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            if (try? String(contentsOf: file, encoding: .utf8)) != text {
                try text.write(to: file, atomically: true, encoding: .utf8)
                // a server already running (sessions kept from before an update) takes the new settings too
                run(["source-file", file.path])
            }
            return file.path
        } catch {
            return nil
        }
    }

    @discardableResult
    nonisolated static func run(_ args: [String]) -> (status: Int32, output: String) {
        guard let tmux else { return (-1, "") }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: tmux)
        p.arguments = ["-L", socket] + args
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return (-1, "") }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return (p.terminationStatus, String(decoding: data, as: UTF8.self))
    }

    /// The session `name` is running (a pane coming back attaches to it: no welcome card, no saved scrollback replayed).
    nonisolated static func exists(_ name: String) -> Bool {
        run(["has-session", "-t", "=" + name]).status == 0
    }

    /// What `tmux new-session -A` gets: attach to `name`, or make it in `dir` running `shell -l` with `env`.
    static func arguments(name: String, dir: String, shell: String, env: [String: String]) -> [String]? {
        guard let conf = config() else { return nil }
        var args = ["-L", socket, "-f", conf, "new-session", "-A", "-s", name, "-c", dir]
        // the shell's own variables (Pulse's prompt, the agent list…), for a session made now
        for key in ["ZDOTDIR", "PULSE_USER_ZDOTDIR", "PULSE_TRY", "PULSE_EXTRA_AGENTS", "TERM_PROGRAM", "COLORTERM", "LANG"] {
            if let v = env[key] { args += ["-e", "\(key)=\(v)"] }
        }
        return args + [shell, "-l"]
    }

    /// The pane's shell and its terminal inside tmux (the program in front and the folder are read from them).
    nonisolated static func pane(_ name: String) -> (pid: pid_t, tty: String)? {
        // (a pane target: "=name:" is that session exactly, its current window and pane; "=name" alone finds no pane)
        let r = run(["display-message", "-p", "-t", "=" + name + ":", "#{pane_pid}\t#{pane_tty}"])
        let parts = r.output.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: "\t")
        guard r.status == 0, parts.count == 2, let pid = pid_t(parts[0]) else { return nil }
        return (pid, String(parts[1]))
    }

    /// Ends a session (its tab was closed).
    nonisolated static func end(_ name: String) {
        DispatchQueue.global(qos: .utility).async { run(["kill-session", "-t", "=" + name]) }
    }

    /// Ends the sessions no open tab uses (tabs closed while Pulse was not running, splits that are not restored).
    nonisolated static func prune(keeping names: Set<String>) {
        DispatchQueue.global(qos: .utility).async {
            let r = run(["list-sessions", "-F", "#{session_name}"])
            guard r.status == 0 else { return }
            for s in r.output.split(separator: "\n").map(String.init) where !names.contains(s) {
                run(["kill-session", "-t", "=" + s])
            }
        }
    }
}
