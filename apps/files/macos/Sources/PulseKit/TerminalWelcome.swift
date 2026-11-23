import Foundation

/// The card a new terminal tab opens with (before the shell's first prompt): Pulse's pulse line in ASCII with the folder
/// under it, beside what is useful here (the folder, its Git state, the pane keys, the project's scripts), then a
/// "Try …" line with a command that works in this folder. Drawn with box characters and 24-bit colour, fitted to the
/// pane's width: the full card from 80 columns, a compact one below, a single line when very narrow.
public enum TerminalWelcome {
    public struct Info: Equatable, Sendable {
        public var folder: String
        public var items: Int?
        public var branch: String?
        public var changed: Int = 0
        public var ahead: Int = 0
        public var behind: Int = 0
        /// The project's scripts as commands to type ("pnpm run dev", "make test"), best first.
        public var commands: [String] = []
        public var home: String = NSHomeDirectory()
        public var dark = true

        public init(folder: String, items: Int? = nil, branch: String? = nil, changed: Int = 0, ahead: Int = 0, behind: Int = 0,
                    commands: [String] = [], home: String = NSHomeDirectory(), dark: Bool = true) {
            self.folder = folder
            self.items = items
            self.branch = branch
            self.changed = changed
            self.ahead = ahead
            self.behind = behind
            self.commands = commands
            self.home = home
            self.dark = dark
        }
    }

    /// Pulse's icon (the pulse line), drawn from icons/icon.png at 30 × 12.
    public static let art: [String] = [
        "              **",
        "              #*=*",
        "              #*##",
        "              ##*#",
        "            !=::#*",
        "            ##  ##",
        "    :!      *#  !!!:  !!",
        "...:!!:::!  ##    $#::==!:!:!:",
        ":::!  ===*::==    #*##  *=*=*=",
        "          **      #*#*",
        "                  #**=",
        "                  #*",
    ]

    /// The card as terminal output (lines end in CR LF), for a pane `cols` wide.
    public static func render(_ info: Info, cols: Int) -> String {
        let lines: [String]
        if cols >= 80 { lines = full(info, cols: cols) } else if cols >= 44 { lines = compact(info, cols: cols) } else { lines = tiny(info, cols: cols) }
        return lines.map { $0 + Style.reset }.joined(separator: "\r\n") + "\r\n"
    }

    /// The same without colour codes (what a test, or a person reading a log, sees).
    public static func plain(_ info: Info, cols: Int) -> [String] {
        render(info, cols: cols).components(separatedBy: "\r\n").dropLast().map(Style.strip)
    }

    // MARK: layouts

    static func full(_ info: Info, cols: Int) -> [String] {
        let s = Style(dark: info.dark)
        let width = min(cols - 2, 100)          // the card, borders included
        let leftW = 34
        let rightW = width - 7 - leftW          // a row: "│ " + left + " │ " + right + " │"
        var left: [String] = [""]
        left.append(center(s.title("Pulse Explorer"), visible: 14, width: leftW))
        left.append("")
        for a in art { left.append(center(s.art(a), visible: a.count, width: leftW)) }
        left.append("")
        let place = shortPath(info.folder, home: info.home, max: leftW - 2)
        left.append(center(s.dim(place), visible: place.count, width: leftW))

        var right: [(String, Int)] = [("", 0)]
        func section(_ name: String) { right.append((s.title(name), name.count)) }
        func line(_ text: String, _ style: (String) -> String) {
            let t = clip(text, rightW)
            right.append((style(t), t.count))
        }
        func rule() { right.append((s.border(String(repeating: "─", count: rightW)), rightW)) }

        section("Here")
        line(shortPath(info.folder, home: info.home, max: rightW), s.body)
        if let n = info.items { line(n == 1 ? "1 item" : "\(n) items", s.body) }
        if let b = info.branch { line(gitLine(info, branch: b), s.body) }
        right.append(("", 0))
        rule()
        right.append(("", 0))
        section("Panes")
        line("⌘D split right · ⇧⌘D split down", s.body)
        line("⌘[ ⌘] move between · ⌘W close", s.body)
        right.append(("", 0))
        if !info.commands.isEmpty {
            section("Run")
            for c in info.commands.prefix(3) { line(c, s.body) }
        } else {
            section("Pulse")
            line("⌘K commands · ⌃` new terminal", s.body)
            line("⌘+ ⌘− text size", s.body)
        }

        let rows = max(left.count, right.count) + 1
        var out: [String] = []
        let label = " Pulse "
        out.append(s.border("╭─") + s.dim(label) + s.border(String(repeating: "─", count: max(0, width - 3 - label.count)) + "╮"))
        for i in 0..<rows {
            let l = i < left.count ? left[i] : String(repeating: " ", count: leftW)
            let (r, rv) = i < right.count ? right[i] : ("", 0)
            out.append(s.border("│ ") + pad(l, visible: visibleCount(l, s), width: leftW) + s.border(" │ ") + r
                + String(repeating: " ", count: max(0, rightW - rv)) + s.border(" │"))
        }
        out.append(s.border("╰" + String(repeating: "─", count: width - 2) + "╯"))
        out += tryBox(info, width: width, s: s)
        return out
    }

    static func compact(_ info: Info, cols: Int) -> [String] {
        let s = Style(dark: info.dark)
        let width = min(cols - 2, 76)
        let inner = width - 4
        var body: [(String, Int)] = []
        func line(_ text: String, _ style: (String) -> String) {
            let t = clip(text, inner)
            body.append((style(t), t.count))
        }
        line("Pulse Explorer", s.title)
        line(shortPath(info.folder, home: info.home, max: inner), s.dim)
        if let b = info.branch { line(gitLine(info, branch: b), s.body) }
        line("⌘D split · ⌘W close · ⌘K commands", s.body)
        var out = [s.border("╭" + String(repeating: "─", count: width - 2) + "╮")]
        for (t, v) in body { out.append(s.border("│ ") + t + String(repeating: " ", count: max(0, inner - v)) + s.border(" │")) }
        out.append(s.border("╰" + String(repeating: "─", count: width - 2) + "╯"))
        out += tryBox(info, width: width, s: s)
        return out
    }

    static func tiny(_ info: Info, cols: Int) -> [String] {
        let s = Style(dark: info.dark)
        let text = clip("Pulse · " + shortPath(info.folder, home: info.home, max: cols), max(cols - 1, 1))
        return [s.dim(text)]
    }

    /// The "> Try …" line in its own box, and the hint under it.
    static func tryBox(_ info: Info, width: Int, s: Style) -> [String] {
        let suggestion = info.commands.first ?? (info.branch != nil ? "git status" : "ls -la")
        let inner = width - 4
        let text = clip("Try \"\(suggestion)\"", inner - 4)
        return [
            s.border("╭" + String(repeating: "─", count: width - 2) + "╮"),
            s.border("│ ") + s.title(">") + "   " + s.dim(text) + String(repeating: " ", count: max(0, inner - 4 - text.count)) + s.border(" │"),
            s.border("╰" + String(repeating: "─", count: width - 2) + "╯"),
            " " + s.dim("⌘K for commands · ⌃` new terminal"),
        ]
    }

    // MARK: text

    static func gitLine(_ info: Info, branch: String) -> String {
        var t = "⎇ \(branch)"
        if info.ahead > 0 { t += " ↑\(info.ahead)" }
        if info.behind > 0 { t += " ↓\(info.behind)" }
        t += info.changed == 0 ? " · clean" : " · \(info.changed) changed"
        return t
    }

    /// "~/dev/pulse", cut from the left ("…/dev/pulse") when longer than `max`.
    public static func shortPath(_ path: String, home: String, max: Int) -> String {
        var p = path
        if p == home { p = "~" } else if p.hasPrefix(home + "/") { p = "~" + p.dropFirst(home.count) }
        guard p.count > max, max > 1 else { return p }
        return "…" + p.suffix(max - 1)
    }

    static func clip(_ s: String, _ n: Int) -> String {
        guard s.count > n else { return s }
        return n > 1 ? String(s.prefix(n - 1)) + "…" : String(s.prefix(max(n, 0)))
    }

    static func center(_ styled: String, visible: Int, width: Int) -> String {
        let left = max(0, (width - visible) / 2)
        return String(repeating: " ", count: left) + styled
    }

    static func pad(_ styled: String, visible: Int, width: Int) -> String {
        styled + String(repeating: " ", count: max(0, width - visible))
    }

    static func visibleCount(_ styled: String, _ s: Style) -> Int { Style.strip(styled).count }

    /// Colours: Pulse's monochrome line, light or dark.
    struct Style {
        let dark: Bool
        static let reset = "\u{1B}[0m"
        private func rgb(_ hex: UInt32) -> String { "\u{1B}[38;2;\(hex >> 16 & 255);\(hex >> 8 & 255);\(hex & 255)m" }
        func title(_ t: String) -> String { "\u{1B}[1m" + rgb(dark ? 0xF2F2ED : 0x090909) + t + Self.reset }
        func body(_ t: String) -> String { rgb(dark ? 0xC8C8C2 : 0x3A3A38) + t + Self.reset }
        func dim(_ t: String) -> String { rgb(dark ? 0x7C7C79 : 0x757573) + t + Self.reset }
        func art(_ t: String) -> String { rgb(dark ? 0xE6E6E0 : 0x2A2A28) + t + Self.reset }
        func border(_ t: String) -> String { rgb(dark ? 0x4A4A47 : 0xC4C4BF) + t + Self.reset }

        /// The text without escape sequences.
        static func strip(_ s: String) -> String {
            s.replacingOccurrences(of: "\u{1B}\\[[0-9;]*m", with: "", options: .regularExpression)
        }
    }
}
