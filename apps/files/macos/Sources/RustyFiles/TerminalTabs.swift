import AppKit
import PulseKit
import SwiftTerm

/// Terminal tabs (the "+" button's menu, ⌃`): a real terminal in a Pulse tab, opened in the folder you were in.
///
/// The terminal itself is SwiftTerm (MIT, Miguel de Icaza), vendored in Vendor/SwiftTerm (see VENDORED.md there): a full
/// xterm-compatible emulator with the user's own login shell behind it. What Pulse adds, after
/// Ghostty and herdr: panes split right (⌘D) and down (⇧⌘D) in one tab, moved between with ⌘[ / ⌘], closed with ⌘W;
/// the tab named after what runs in it ("claude — pulse") or its folder; and a mark on a tab whose long command finished
/// while you were elsewhere. The shell's folder and foreground program are read from the kernel (ProcessInspect).
enum TerminalAddress {
    /// `id` names the tab across restarts (its saved scrollback, TerminalHistory).
    nonisolated static func url(in dir: URL, id: String = UUID().uuidString) -> URL {
        var c = URLComponents()
        c.scheme = "rustyfiles"
        c.path = "terminal"
        c.queryItems = [URLQueryItem(name: "cwd", value: dir.path), URLQueryItem(name: "id", value: id)]
        return c.url!
    }

    nonisolated static func id(of url: URL) -> String? {
        URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "id" })?.value
    }

    nonisolated static func directory(of url: URL) -> URL? {
        guard url.scheme == "rustyfiles", let c = URLComponents(url: url, resolvingAgainstBaseURL: false), c.path == "terminal" else { return nil }
        let cwd = c.queryItems?.first(where: { $0.name == "cwd" })?.value ?? NSHomeDirectory()
        return URL(fileURLWithPath: cwd)
    }

    nonisolated static func isTerminal(_ url: URL) -> Bool { directory(of: url) != nil }
}

/// One pane: a SwiftTerm view running a login shell, in Pulse's colours.
@MainActor
final class TerminalPane: NSObject, LocalProcessTerminalViewDelegate {
    let view: PulseTerminalView
    let id = UUID().uuidString
    /// What it is doing (AgentStatus), updated by its page.
    var status: AgentStatus = .idle
    /// Output saved when the tab was last open, shown before the new shell (TerminalHistory).
    var restore: Data?
    var onExit: ((TerminalPane) -> Void)?
    var onTitle: (() -> Void)?
    private(set) var shellTitle: String?
    private(set) var activity = ProcessInspect.Activity(program: nil, directory: nil)

    /// The tmux session the shell runs in (TerminalSessions): the tab's id for its first pane, so the tab finds it again.
    let session: String
    /// The shell inside tmux (what runs in front is read from it, not from the tmux client in front of Pulse's own terminal).
    private var inner: pid_t?
    /// The pane attached to a session that was already running (Pulse came back after a quit or a crash).
    private(set) var reattached = false

    init(directory: URL, session: String = UUID().uuidString) {
        view = PulseTerminalView(frame: NSRect(x: 0, y: 0, width: 600, height: 400))
        self.directory = directory
        self.session = session
        super.init()
        view.processDelegate = self
        view.directory = { [weak self] in self?.activity.directory.map { URL(fileURLWithPath: $0) } ?? self?.directory }
        view.optionAsMetaKey = false  // Option types the Mac's characters (é, ñ, …), as in Ghostty's default
        view.font = Self.font
        apply(dark: true, text: NSColor(red: 0.949, green: 0.949, blue: 0.929, alpha: 1))
    }

    private let directory: URL
    private(set) var started = false
    private var dark = true

    /// Starts the shell, once, when the pane has its real width: the welcome card first (Settings: terminalWelcome),
    /// so the shell's first prompt comes under it.
    func begin() {
        guard !started else { return }
        started = true
        let dir = directory
        let welcome = UserDefaults.standard.object(forKey: "terminalWelcome") as? Bool ?? true
        let advance = ("W" as NSString).size(withAttributes: [.font: view.font]).width
        let lineHeight = ceil(view.font.ascender - view.font.descender + view.font.leading)
        let cols = max(Int(view.bounds.width / max(advance, 1)) - 1, 20)
        let rows = Int(view.bounds.height / max(lineHeight, 1))
        let dark = self.dark
        let session = self.session, keep = TerminalSessions.enabled
        Task.detached(priority: .userInitiated) {
            // its shell still running (Pulse quit or crashed and came back): attached again, the screen is tmux's to draw
            let running = keep && TerminalSessions.exists(session)
            var info = TerminalWelcomeInfo.gather(dir, dark: dark)
            await MainActor.run { [weak self] in
                guard let self else { return }
                let prompt = self.boxPrompt
                info.tryBox = !prompt
                self.suggestion = TerminalWelcome.suggestion(info)
                if running {
                    self.reattached = true
                    self.restore = nil
                } else if let saved = self.restore {
                    // a tab that comes back: what it showed, then a quiet line, then the new shell
                    self.view.feed(byteArray: [UInt8](ScrollbackRing.replay(saved))[...])
                    self.view.feed(text: "\r\n\u{1B}[38;2;124;124;121m── restored · \(DateFormatter.localizedString(from: Date(), dateStyle: .none, timeStyle: .short)) ──\u{1B}[0m\r\n")
                    self.restore = nil
                } else if welcome {
                    let card = TerminalWelcome.render(info, cols: cols)
                    self.view.feed(text: card)
                    // the pulse line draws itself in (when the card has room to stay where it is)
                    let height = card.components(separatedBy: "\r\n").count
                    if Motion.on, rows >= height + 6 { self.animate(TerminalWelcome.frames(info, cols: cols)) }
                }
                self.start(in: dir)
            }
        }
    }

    /// The command the box prompt's hint offers (PULSE_TRY).
    private var suggestion = ""

    /// Pulse's box prompt is used for zsh (ShellIntegration), unless turned off (UserDefaults terminalPrompt = false).
    private var boxPrompt: Bool {
        (UserDefaults.standard.object(forKey: "terminalPrompt") as? Bool ?? true) && (Self.shell as NSString).lastPathComponent == "zsh"
    }

    private var animation: Timer?

    /// Plays the frames, 28 ms apart (the first at once, so the still card is never seen without its sweep).
    private func animate(_ frames: [String]) {
        guard !frames.isEmpty else { return }
        view.feed(text: frames[0])
        var i = 1
        animation = Timer.scheduledTimer(withTimeInterval: 0.028, repeats: true) { [weak self] t in
            MainActor.assumeIsolated {
                guard let self, i < frames.count else { return t.invalidate() }
                // something already runs (an agent cleared the screen for itself): the art is not drawn over it
                if self.programInFront { return t.invalidate() }
                self.view.feed(text: frames[i])
                i += 1
            }
        }
    }

    /// Settings › Terminal › Shell (a path), else the user's login shell ($SHELL), else zsh.
    static var shell: String {
        let chosen = UserDefaults.standard.string(forKey: "terminalShell") ?? ""
        if !chosen.isEmpty, FileManager.default.isExecutableFile(atPath: chosen) { return chosen }
        return ProcessInfo.processInfo.environment["SHELL"].flatMap { FileManager.default.isExecutableFile(atPath: $0) ? $0 : nil } ?? "/bin/zsh"
    }

    /// Pulse's zsh files (ShellIntegration), written fresh in Application Support.
    static func zshIntegration() -> URL? {
        guard let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return nil }
        return try? ShellIntegration.install(in: support.appendingPathComponent("Pulse Explorer/zsh", isDirectory: true))
    }

    /// The file manager's look: no background of its own (the card's glass shows through, as behind the list), the
    /// palette's text colour, a caret and selection that read on light and dark.
    func apply(dark: Bool, text: NSColor) {
        self.dark = dark
        view.nativeBackgroundColor = .clear
        view.nativeForegroundColor = text
        view.caretColor = text.withAlphaComponent(0.85)
        view.selectedTextBackgroundColor = (dark ? NSColor.white : NSColor.black).withAlphaComponent(dark ? 0.22 : 0.14)
        view.layer?.backgroundColor = NSColor.clear.cgColor
    }

    static var fontSize: CGFloat {
        get { let v = UserDefaults.standard.double(forKey: "terminalFontSize"); return v >= 9 ? v : 13 }
        set { UserDefaults.standard.set(Double(newValue), forKey: "terminalFontSize") }
    }

    static var font: NSFont {
        NSFont(name: "SF Mono", size: fontSize) ?? NSFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
    }

    /// The user's own shell as a login shell ("-zsh"), so their profile, PATH and prompt are all there.
    private func start(in dir: URL) {
        let shell = Self.shell
        var env = ProcessInfo.processInfo.environment
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"
        env["TERM_PROGRAM"] = "PulseExplorer"
        env["LANG"] = env["LANG"] ?? "en_US.UTF-8"
        // what Pulse's own launch put there is not the user's
        env.removeValue(forKey: "PULSE_VIEWER")
        // the welcome card's input box as the prompt: zsh starts from Pulse's files, which load the user's own first
        if boxPrompt, let zdot = Self.zshIntegration() {
            env["PULSE_USER_ZDOTDIR"] = env["ZDOTDIR"] ?? NSHomeDirectory()
            env["ZDOTDIR"] = zdot.path
            env["PULSE_TRY"] = suggestion
            if let extra = UserDefaults.standard.string(forKey: "terminalExtraAgents"), !extra.isEmpty {
                env["PULSE_EXTRA_AGENTS"] = [env["PULSE_EXTRA_AGENTS"], extra].compactMap { $0 }.joined(separator: " ")
            }
        }
        let cwd = FileManager.default.fileExists(atPath: dir.path) ? dir.path : NSHomeDirectory()
        // in its own tmux session (TerminalSessions): the shell, and an agent in it, outlive Pulse
        if TerminalSessions.enabled, let tmux = TerminalSessions.tmux,
            let args = TerminalSessions.arguments(name: session, dir: cwd, shell: shell, env: env)
        {
            view.startProcess(executable: tmux, args: Array(args), environment: env.map { "\($0.key)=\($0.value)" },
                              execName: "tmux", currentDirectory: cwd)
            findInner()
            return
        }
        view.startProcess(executable: shell, args: ["-l"], environment: env.map { "\($0.key)=\($0.value)" },
                          execName: "-" + (shell as NSString).lastPathComponent, currentDirectory: cwd)
    }

    /// The shell inside the tmux session and its terminal, once tmux has made them (a few tries, 0.1 s apart).
    private func findInner(tries: Int = 30) {
        let session = self.session
        Task.detached(priority: .utility) {
            let found = TerminalSessions.pane(session)
            await MainActor.run { [weak self] in
                guard let self, self.inner == nil else { return }
                if let found {
                    self.inner = found.pid
                } else if tries > 0 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in self?.findInner(tries: tries - 1) }
                }
            }
        }
    }

    /// Something other than the shell is in front (an agent, a command).
    var programInFront: Bool {
        if let inner { return ProcessInspect.terminalForeground(of: inner).map { $0 != inner } ?? false }
        guard let p = view.process, p.running, let fg = ProcessInspect.foreground(ofTerminal: p.childfd) else { return false }
        return fg != p.shellPid
    }

    /// Reads what runs in front and where the shell is (polled by the page while it shows).
    @discardableResult
    func refresh() -> Bool {
        guard started, let p = view.process, p.running else { return false }
        let a = inner.map { ProcessInspect.activity(shell: $0) } ?? ProcessInspect.activity(shell: p.shellPid, terminal: p.childfd)
        let changed = a != activity
        activity = a
        return changed
    }

    var title: String { shellTitle.flatMap { $0.isEmpty ? nil : $0 } ?? ProcessInspect.title(activity) }

    /// Ends the pane. `endSession`: its shell goes too (the pane or its tab was closed); otherwise the tmux session keeps
    /// running for the next start (Pulse quitting).
    func terminate(endSession: Bool = true) {
        animation?.invalidate()
        if endSession, TerminalSessions.enabled { TerminalSessions.end(session) }
        view.process?.terminate()
        inner = nil
    }

    // MARK: SwiftTerm

    nonisolated func sizeChanged(source: LocalProcessTerminalView, newCols: Int, newRows: Int) {}

    nonisolated func setTerminalTitle(source: LocalProcessTerminalView, title: String) {
        MainActor.assumeIsolated {
            shellTitle = title
            onTitle?()
        }
    }

    nonisolated func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {
        MainActor.assumeIsolated { onTitle?() }
    }

    nonisolated func processTerminated(source: TerminalView, exitCode: Int32?) {
        MainActor.assumeIsolated { onExit?(self) }
    }
}

/// A terminal tab's content: one or more panes in nested split views.
@MainActor
final class TerminalPage {
    let container = TerminalContainer()
    private(set) var panes: [TerminalPane] = []
    private(set) var focused: TerminalPane?
    /// The tab's title or activity changed (the window renames its tab).
    var onChange: (() -> Void)?
    /// The last pane closed: the tab goes.
    var onEmpty: (() -> Void)?
    /// A long command ended while this tab was in the background.
    private(set) var finishedInBackground = false
    var isShown = false {
        didSet {
            if isShown { finishedInBackground = false }
            updateTimer()
        }
    }

    private var timer: Timer?
    private var busySince: [ObjectIdentifier: Date] = [:]
    /// The tab's id (TerminalAddress), for its saved scrollback.
    let id: String
    /// The tab's title in the window, for notifications.
    var tabTitle: () -> String = { "" }

    init(directory: URL, id: String = UUID().uuidString) {
        self.id = id
        // a real size from the start: panes laid out in a zero-sized view get a null frame and never stretch
        container.frame = NSRect(x: 0, y: 0, width: 900, height: 560)
        container.wantsLayer = true
        container.layer?.cornerRadius = Metrics.radius
        container.layer?.masksToBounds = true
        container.layer?.borderWidth = 1
        // the system's light / dark switch reaches the container: the look follows it
        container.onAppearance = { [weak self] in
            guard let self else { return }
            self.applyLook(Palette.of(self.container))
        }
        let pane = makePane(in: directory)
        pane.restore = TerminalHistory.load(id: id)
        let host = paneHost(pane.view)
        host.frame = container.bounds
        host.autoresizingMask = [.width, .height]
        container.addSubview(host)
        focused = pane
        updateTimer()
    }

    /// The tab's title: a mark for the most pressing pane (◐ an agent waits, ◌ one works, ● a command finished out of
    /// sight), then what the focused pane shows.
    var title: String {
        let mark = panes.contains { $0.status == .waiting } ? AgentStatus.waiting.mark
            : panes.contains { $0.status == .working } ? AgentStatus.working.mark
            : finishedInBackground ? "● " : ""
        return mark + (focused?.title ?? "Terminal")
    }

    /// The tab's output for next time (the first pane's; panes split off start fresh).
    func saveHistory() {
        guard let first = panes.first else { return }
        TerminalHistory.save(first.view.ring.bytes, id: id)
    }

    func focus(_ pane: TerminalPane) {
        guard panes.contains(where: { $0 === pane }) else { return }
        focused = pane
        focus()
        onChange?()
    }
    var directory: URL? { focused?.activity.directory.map { URL(fileURLWithPath: $0) } }
    var focusedView: PulseTerminalView? { focused?.view }

    /// Starts the panes that are waiting (a new tab once it shows, a new split once it has its size).
    func beginPending() {
        container.layoutSubtreeIfNeeded()
        for p in panes where !p.started { p.begin() }
    }

    func focus() {
        guard let v = focused?.view else { return }
        v.window?.makeFirstResponder(v)
    }

    // MARK: panes

    private func makePane(in dir: URL) -> TerminalPane {
        // the first pane's session is named after the tab, which comes back with the same id
        let p = TerminalPane(directory: dir, session: panes.isEmpty ? id : UUID().uuidString)
        if let look { p.apply(dark: look.dark, text: look.text) }
        p.onExit = { [weak self] pane in self?.close(pane) }
        p.view.onOpenFolder = { url in AppDelegate.shared.frontController?.openTab(url, activate: true) }
        p.onTitle = { [weak self] in self?.onChange?() }
        panes.append(p)
        return p
    }

    /// The pane in a little padding, so text doesn't touch the card's rounded edge.
    private func paneHost(_ v: NSView) -> NSView {
        let host = PaneHost(frame: NSRect(x: 0, y: 0, width: 900, height: 560))
        host.wantsLayer = true
        host.layer?.backgroundColor = NSColor.clear.cgColor
        v.frame = host.bounds.insetBy(dx: 8, dy: 6)
        v.autoresizingMask = [.width, .height]
        host.addSubview(v)
        return host
    }

    /// Splits the focused pane: a new shell beside it (right) or under it (down), in the same folder.
    func split(vertical: Bool) {
        guard let current = focused, let host = current.view.superview, let parent = host.superview else { return }
        let dir = current.activity.directory.map { URL(fileURLWithPath: $0) } ?? URL(fileURLWithPath: NSHomeDirectory())
        let pane = makePane(in: dir)
        let newHost = paneHost(pane.view)
        let split = NSSplitView(frame: host.frame)
        split.isVertical = vertical
        split.dividerStyle = .thin
        split.autoresizingMask = [.width, .height]
        if let parentSplit = parent as? NSSplitView, let i = parentSplit.arrangedSubviews.firstIndex(of: host) {
            host.removeFromSuperview()
            parentSplit.insertArrangedSubview(split, at: i)
        } else {
            host.removeFromSuperview()
            parent.addSubview(split)
        }
        split.addArrangedSubview(host)
        split.addArrangedSubview(newHost)
        split.adjustSubviews()
        let half = (vertical ? split.bounds.width : split.bounds.height) / 2
        split.setPosition(half, ofDividerAt: 0)
        focused = pane
        if Motion.on {
            newHost.alphaValue = 0
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.18
                newHost.animator().alphaValue = 1
            }
        }
        DispatchQueue.main.async { [weak self] in
            self?.beginPending()
            self?.focus()
        }
        onChange?()
    }

    /// Closes a pane (its shell is ended); its neighbour takes the room.
    func close(_ pane: TerminalPane) {
        guard let i = panes.firstIndex(where: { $0 === pane }) else { return }
        pane.onExit = nil
        pane.terminate()
        panes.remove(at: i)
        busySince[ObjectIdentifier(pane)] = nil
        if panes.isEmpty {
            onEmpty?()
            return
        }
        if let host = pane.view.superview, let split = host.superview as? NSSplitView {
            host.removeFromSuperview()
            // a split left with one side is replaced by that side
            if split.arrangedSubviews.count == 1, let only = split.arrangedSubviews.first, let outer = split.superview {
                only.removeFromSuperview()
                only.frame = split.frame
                only.autoresizingMask = [.width, .height]
                if let outerSplit = outer as? NSSplitView, let j = outerSplit.arrangedSubviews.firstIndex(of: split) {
                    split.removeFromSuperview()
                    outerSplit.insertArrangedSubview(only, at: j)
                } else {
                    split.removeFromSuperview()
                    outer.addSubview(only)
                }
            }
        }
        if focused === pane { focused = panes[min(i, panes.count - 1)] }
        focus()
        onChange?()
    }

    func closeFocused() { if let f = focused { close(f) } }

    /// The look of the list's card (FileList.swift CardView): the palette's content wash over the window's glass, its
    /// border; panes see-through on it. Applied on creation and when the theme or material changes.
    private var look: (dark: Bool, text: NSColor)?
    func applyLook(_ p: Palette) {
        look = (p.dark, p.text)
        container.layer?.backgroundColor = p.contentBg.cgColor
        container.layer?.borderColor = p.border.cgColor
        for pane in panes { pane.apply(dark: p.dark, text: p.text) }
    }

    /// ⌘+ / ⌘− / ⌘0: the text size of every pane (9 to 28 pt, 13 by default), remembered.
    func zoom(_ step: Int) {
        let now = TerminalPane.fontSize
        let next: CGFloat = step == 0 ? 13 : min(max(now + CGFloat(step), 9), 28)
        guard next != now else { return NSSound.beep() }
        TerminalPane.fontSize = next
        for p in panes { p.view.font = TerminalPane.font }
    }

    /// ⌘[ / ⌘]: the previous or next pane.
    func cycle(_ step: Int) {
        guard panes.count > 1, let f = focused, let i = panes.firstIndex(where: { $0 === f }) else { return }
        focused = panes[(i + step + panes.count) % panes.count]
        focus()
        onChange?()
    }

    /// A click in a pane makes it the focused one.
    func noteFocus(_ v: NSView) {
        if let p = panes.first(where: { v === $0.view || v.isDescendant(of: $0.view) }), p !== focused {
            focused = p
            onChange?()
        }
    }

    /// `endSessions`: false while Pulse quits (the shells keep running in tmux and come back with it).
    func terminateAll(endSessions: Bool = true) {
        timer?.invalidate()
        TerminalRegistry.shared.remove(self)
        for p in panes {
            p.onExit = nil
            p.terminate(endSession: endSessions)
        }
        panes = []
    }

    // MARK: watching what runs (once a second, only while the tab shows or something runs)

    private func updateTimer() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: isShown ? 1 : 2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
    }

    private func tick() {
        var changed = false
        let extra = Set((UserDefaults.standard.string(forKey: "terminalExtraAgents") ?? "").split(separator: " ").map { $0.lowercased() })
        let quietAfter = max(UserDefaults.standard.double(forKey: "terminalAgentQuietSeconds"), 0) == 0 ? 3 : UserDefaults.standard.double(forKey: "terminalAgentQuietSeconds")
        for p in panes {
            let wasBusy = p.activity.isBusy
            if p.refresh() { changed = true }
            // agent status: working while it draws, waiting when it goes quiet or rings
            let rang = p.view.lastBell.map { Date().timeIntervalSince($0) < 4 } ?? false
            let status = AgentStatus.of(program: p.activity.program, quietFor: Date().timeIntervalSince(p.view.lastOutput), rang: rang, quietAfter: quietAfter, extra: extra)
            if status != p.status {
                let old = p.status
                p.status = status
                changed = true
                // an agent stopped to ask, out of sight: a notification and a bounce
                let inFront = isShown && (container.window?.isKeyWindow ?? false) && NSApp.isActive
                if status.notifies(from: old), !inFront {
                    AgentNotifier.notify(p, tabTitle: tabTitle())
                    NSApp.requestUserAttention(.informationalRequest)
                }
            }
            let id = ObjectIdentifier(p)
            if p.activity.isBusy, !wasBusy { busySince[id] = Date() }
            if !p.activity.isBusy, wasBusy {
                // a command that ran a while and ended out of sight: the tab says so, like herdr's "done"
                if let since = busySince[id], Date().timeIntervalSince(since) > 3, !isShown {
                    finishedInBackground = true
                    NSApp.requestUserAttention(.informationalRequest)
                }
                busySince[id] = nil
            }
        }
        if changed { onChange?() }
    }
}

/// The view a pane sits in; a click inside tells the page which pane is in front.
private final class PaneHost: NSView {
    override func hitTest(_ point: NSPoint) -> NSView? {
        let v = super.hitTest(point)
        if v != nil, NSApp.currentEvent?.type == .leftMouseDown, let page = (window?.windowController as? BrowserWindowController)?.terminalPageInFront {
            page.noteFocus(subviews.first ?? self)
        }
        return v
    }
}

/// A terminal tab's container: says when the system's appearance changes (light / dark), so the look can follow.
final class TerminalContainer: NSView {
    var onAppearance: (() -> Void)?
    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        onAppearance?()
    }
}

/// What the welcome card says about a folder (read off the main thread: a directory listing, `git status`, the project
/// file's scripts).
enum TerminalWelcomeInfo {
    nonisolated static func gather(_ dir: URL, dark: Bool) -> TerminalWelcome.Info {
        var info = TerminalWelcome.Info(folder: dir.path, dark: dark)
        info.items = (try? FileManager.default.contentsOfDirectory(atPath: dir.path))?.filter { !$0.hasPrefix(".") }.count
        if Repo.root(of: dir) != nil, let g = Repo.summary(dir) {
            info.branch = g.branch
            info.changed = g.changed
            info.ahead = g.ahead
            info.behind = g.behind
        }
        info.commands = commands(in: dir)
        return info
    }

    /// The project's scripts as commands, the usual ones first (dev, start, build, test).
    nonisolated static func commands(in dir: URL) -> [String] {
        let files = ["package.json", "Makefile", "justfile", "composer.json"].map { dir.appendingPathComponent($0) }
        guard let file = files.first(where: { FileManager.default.fileExists(atPath: $0.path) }) else { return [] }
        let scripts = ProjectScripts.scripts(in: file)
        let rank = ["dev": 0, "start": 1, "serve": 2, "build": 3, "test": 4]
        return scripts.enumerated().sorted { a, b in
            (rank[a.element.name] ?? 10, a.offset) < (rank[b.element.name] ?? 10, b.offset)
        }.map(\.element.command)
    }
}
