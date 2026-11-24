import AppKit
import PulseKit
import SwiftTerm
import UserNotifications

// MARK: - Pulse's terminal view

/// SwiftTerm's local-process view with what Pulse adds: it notes when the program last printed and when it rang (for
/// agent status), keeps the tail of its output (to restore a tab after a restart), opens paths ⌘-clicked in its output in
/// Pulse, and pastes files dropped on it as shell-quoted paths.
@MainActor
final class PulseTerminalView: LocalProcessTerminalView {
    /// What the output tells, written on SwiftTerm's parse thread (behind a lock), read on the main thread.
    private final class OutputState: @unchecked Sendable {
        let lock = NSLock()
        var last = Date()
        var ring = ScrollbackRing()
    }
    private let output = OutputState()
    private(set) var lastBell: Date?

    var lastOutput: Date { output.lock.withLock { output.last } }
    var ring: ScrollbackRing { output.lock.withLock { output.ring } }

    /// The folder relative paths in the output are read against (the shell's).
    var directory: () -> URL? = { nil }
    var onOpenFolder: ((URL) -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        registerForDraggedTypes([.fileURL])
        let state = output
        // every batch of output (SwiftTerm hook, VENDORED.md): when it came, and the tail kept for a restore
        setProcessBytesHandler { bytes in
            state.lock.withLock {
                state.last = Date()
                state.ring.append(bytes)
            }
        }
        bellHandler = { [weak self] in self?.lastBell = Date() }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    // ⌘-click on a path in the output: a folder opens in a Pulse tab, a file the way Pulse opens it (Quick View for its
    // types), "file.swift:12:3" included; links that are no file go to SwiftTerm (the browser)
    override func requestOpenLink(source: TerminalView, request: TerminalLinkRequest) {
        if let url = TerminalPaths.resolve(request.link, in: directory()) {
            var isDir: ObjCBool = false
            FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir)
            if isDir.boolValue { onOpenFolder?(url) } else { TerminalPaths.open(url) }
            return
        }
        super.requestOpenLink(source: source, request: request)
    }

    // files dropped from Pulse or Finder: their paths, quoted, at the cursor (as Terminal, iTerm and Ghostty do)
    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        sender.draggingPasteboard.canReadObject(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) ? .copy : super.draggingEntered(sender)
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
        guard !urls.isEmpty else { return super.performDragOperation(sender) }
        send(txt: urls.map { PathForms.shellQuoted($0.path) }.joined(separator: " ") + " ")
        window?.makeFirstResponder(self)
        return true
    }
}

/// Paths in a terminal's output.
enum TerminalPaths {
    /// The file or folder `link` names (absolute, "~/…", or relative to `dir`; ":line[:col]" taken off), if it exists.
    static func resolve(_ link: String, in dir: URL?) -> URL? {
        var s = link.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("file://"), let u = URL(string: s), u.isFileURL { s = u.path }
        guard !s.isEmpty, !s.contains("://") else { return nil }
        // "path:12" / "path:12:3": the place in the file goes, the file stays
        if let r = s.range(of: #"(:\d+){1,2}$"#, options: .regularExpression) { s.removeSubrange(r) }
        let expanded = (s as NSString).expandingTildeInPath
        let url = expanded.hasPrefix("/") ? URL(fileURLWithPath: expanded) : (dir ?? URL(fileURLWithPath: NSHomeDirectory())).appendingPathComponent(expanded)
        return FileManager.default.fileExists(atPath: url.standardizedFileURL.path) ? url.standardizedFileURL : nil
    }

    /// Opens a file as Pulse's file manager would: its own rule, Pulse's viewer for Pulse's types, else the Mac's default.
    @MainActor
    static func open(_ url: URL) {
        if let app = OpenRules.opener(for: url) {
            NSWorkspace.shared.open([url], withApplicationAt: app, configuration: NSWorkspace.OpenConfiguration())
        } else {
            NSWorkspace.shared.open(url)
        }
    }
}

// MARK: - scrollback kept across restarts

/// A terminal tab's last output, saved when Pulse quits or the window closes and shown again when the tab comes back
/// (Settings › Terminal › Keep scrollback). Files in Application Support, one per tab; a closed tab's is removed.
enum TerminalHistory {
    static var folder: URL? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("Pulse Explorer/terminal-history", isDirectory: true)
    }

    static var enabled: Bool { UserDefaults.standard.object(forKey: "terminalKeepScrollback") as? Bool ?? true }

    static func save(_ data: Data, id: String) {
        guard enabled, !id.isEmpty, let folder, !data.isEmpty else { return }
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try? data.write(to: folder.appendingPathComponent("\(id).bin"), options: .atomic)
    }

    static func load(id: String) -> Data? {
        guard enabled, !id.isEmpty, let folder else { return nil }
        return try? Data(contentsOf: folder.appendingPathComponent("\(id).bin"))
    }

    static func remove(id: String) {
        guard let folder else { return }
        try? FileManager.default.removeItem(at: folder.appendingPathComponent("\(id).bin"))
    }

    /// Histories untouched for 30 days go (tabs that never came back).
    static func prune() {
        guard let folder, let files = try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
        let old = Date().addingTimeInterval(-30 * 86_400)
        for f in files where ((try? f.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) < old {
            try? FileManager.default.removeItem(at: f)
        }
    }
}

// MARK: - every terminal, for the Agents panel and notifications

@MainActor
final class TerminalRegistry {
    static let shared = TerminalRegistry()
    private var pages: [(page: WeakBox<TerminalPage>, controller: WeakBox<BrowserWindowController>)] = []
    var onChange: (() -> Void)?

    func add(_ page: TerminalPage, in controller: BrowserWindowController) {
        pages.removeAll { $0.page.value == nil || $0.page.value === page }
        pages.append((WeakBox(page), WeakBox(controller)))
        onChange?()
    }

    func remove(_ page: TerminalPage) {
        pages.removeAll { $0.page.value == nil || $0.page.value === page }
        onChange?()
    }

    /// Every pane: its page, window, status and title.
    var entries: [(page: TerminalPage, pane: TerminalPane, controller: BrowserWindowController)] {
        pages.compactMap { e -> [(TerminalPage, TerminalPane, BrowserWindowController)]? in
            guard let p = e.page.value, let c = e.controller.value else { return nil }
            return p.panes.map { (p, $0, c) }
        }.flatMap { $0 }
    }

    /// Brings a pane to the front: its window, its tab, the pane itself.
    func reveal(_ pane: TerminalPane) {
        guard let e = entries.first(where: { $0.pane === pane }) else { return }
        e.controller.showTerminal(e.page)
        e.page.focus(pane)
        NSApp.activate()
        e.controller.window?.makeKeyAndOrderFront(nil)
    }

    func reveal(paneID: String) {
        if let e = entries.first(where: { $0.pane.id == paneID }) { reveal(e.pane) }
    }
}

final class WeakBox<T: AnyObject> {
    weak var value: T?
    init(_ v: T) { value = v }
}

// MARK: - "an agent needs you" notifications

@MainActor
enum AgentNotifier {
    static var enabled: Bool { UserDefaults.standard.object(forKey: "terminalAgentNotifications") as? Bool ?? true }
    private static var asked = false

    /// A notification that `pane`'s agent waits (only when its tab or the app is not in front).
    static func notify(_ pane: TerminalPane, tabTitle: String) {
        guard enabled else { return }
        let center = UNUserNotificationCenter.current()
        let send = {
            let c = UNMutableNotificationContent()
            c.title = String(localized: "\(pane.activity.program ?? "Agent") is waiting for you")
            c.body = ProcessInspect.title(pane.activity) + " · " + tabTitle
            c.sound = .default
            c.userInfo = ["pane": pane.id]
            center.add(UNNotificationRequest(identifier: "agent-\(pane.id)", content: c, trigger: nil))
        }
        if asked { return send() }
        asked = true
        center.requestAuthorization(options: [.alert, .sound]) { ok, _ in
            if ok { DispatchQueue.main.async { MainActor.assumeIsolated { send() } } }
        }
    }
}

// MARK: - the Agents panel

/// Window › Agents (⌥⌘A): every terminal pane in every window with what it is doing (an agent working ◌ or waiting for you
/// ◐, a command running, the prompt), its folder and tab; a click goes there. Updated live.
@MainActor
final class AgentsPanel: NSObject, NSTableViewDataSource, NSTableViewDelegate {
    static let shared = AgentsPanel()
    private lazy var panel: NSPanel = {
        let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 520, height: 320), styleMask: [.titled, .closable, .resizable, .utilityWindow, .nonactivatingPanel], backing: .buffered, defer: false)
        p.title = String(localized: "Agents")
        p.isFloatingPanel = true
        p.hidesOnDeactivate = false
        p.isReleasedWhenClosed = false
        p.setFrameAutosaveName("pulse.agents")
        build(in: p)
        return p
    }()
    private let table = NSTableView()
    private let empty = NSTextField(labelWithString: String(localized: "No terminals open. ⌃` opens one."))
    private var rows: [(page: TerminalPage, pane: TerminalPane, controller: BrowserWindowController)] = []
    private var timer: Timer?

    func toggle() {
        if panel.isVisible {
            panel.orderOut(nil)
            timer?.invalidate()
            return
        }
        reload()
        if panel.frame.origin == .zero { panel.center() }
        panel.orderFront(nil)
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.reload() } }
    }

    func reload() {
        // waiting first, then working, then the rest
        let order: [AgentStatus: Int] = [.waiting: 0, .working: 1, .running: 2, .idle: 3]
        rows = TerminalRegistry.shared.entries.sorted { (order[$0.pane.status] ?? 9) < (order[$1.pane.status] ?? 9) }
        table.reloadData()
        empty.isHidden = !rows.isEmpty
        let waiting = rows.filter { $0.pane.status == .waiting }.count
        panel.title = waiting == 0 ? String(localized: "Agents") : String(localized: "Agents · \(waiting) waiting")
    }

    private func build(in p: NSPanel) {
        for (id, title, w) in [("state", "", 26.0), ("what", String(localized: "Running"), 150.0), ("status", String(localized: "Status"), 120.0), ("where", String(localized: "Folder"), 200.0)] {
            let c = NSTableColumn(identifier: .init(id))
            c.title = title
            c.width = w
            table.addTableColumn(c)
        }
        table.dataSource = self
        table.delegate = self
        table.rowHeight = 26
        table.style = .inset
        table.target = self
        table.action = #selector(go)
        let scroll = NSScrollView()
        scroll.documentView = table
        scroll.hasVerticalScroller = true
        scroll.translatesAutoresizingMaskIntoConstraints = false
        empty.textColor = .secondaryLabelColor
        empty.translatesAutoresizingMaskIntoConstraints = false
        let content = NSView()
        content.addSubview(scroll)
        content.addSubview(empty)
        p.contentView = content
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: content.leadingAnchor), scroll.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: content.topAnchor), scroll.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            empty.centerXAnchor.constraint(equalTo: content.centerXAnchor), empty.centerYAnchor.constraint(equalTo: content.centerYAnchor),
        ])
    }

    @objc private func go() {
        let r = table.clickedRow
        guard rows.indices.contains(r) else { return }
        TerminalRegistry.shared.reveal(rows[r].pane)
    }

    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let pane = rows[row].pane
        let text: String
        var color = NSColor.labelColor
        switch tableColumn?.identifier.rawValue {
        case "state":
            text = pane.status == .waiting ? "◐" : pane.status == .working ? "◌" : pane.status == .running ? "▸" : "·"
            if pane.status == .waiting { color = .systemOrange }
        case "what": text = pane.activity.program ?? String(localized: "shell")
        case "status":
            text = pane.status.label
            color = pane.status == .waiting ? .systemOrange : .secondaryLabelColor
        default: text = pane.activity.directory.map { TerminalWelcome.shortPath($0, home: NSHomeDirectory(), max: 40) } ?? "—"
        }
        let t = NSTextField(labelWithString: text)
        t.textColor = color
        t.lineBreakMode = .byTruncatingMiddle
        return t
    }
}
