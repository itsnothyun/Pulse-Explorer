import AppKit

/// ⌘K: every command of the app and every place, found by typing a few letters of it (the Windows app's
/// command_palette.rs). The commands are the menu bar's own (so the palette never falls behind it), shown with their
/// menu and shortcut; the places are the pinned folders, the drives, the folders visited lately and the folders here.
/// A typed path ("~/Dev", "/etc") is a result too. ↑ ↓ choose, Return runs, Esc closes.
@MainActor
final class CommandPalette: NSObject, NSTextFieldDelegate, NSTableViewDataSource, NSTableViewDelegate {
    private static var shown: CommandPalette?

    static func toggle(for controller: BrowserWindowController) {
        if let s = shown {
            s.close()
            return
        }
        guard let window = controller.window else { return }
        let p = CommandPalette(controller: controller)
        shown = p
        p.present(over: window)
    }

    // MARK: recent folders (the palette's own memory of where you went)

    private static let recentKey = "paletteRecentFolders"
    static func noteVisit(_ url: URL) {
        guard url.isFileURL else { return }
        var list = UserDefaults.standard.stringArray(forKey: recentKey) ?? []
        list.removeAll { $0 == url.path }
        list.insert(url.path, at: 0)
        UserDefaults.standard.set(Array(list.prefix(30)), forKey: recentKey)
    }

    // MARK: entries

    private struct Entry {
        enum Kind { case command(NSMenuItem), place(URL) }
        let kind: Kind
        let title: String
        let detail: String
        let icon: String
        let keys: String
        var score = 0
    }

    private weak var controller: BrowserWindowController?
    private let panel = PalettePanel(contentRect: NSRect(x: 0, y: 0, width: 620, height: 420), styleMask: [.borderless], backing: .buffered, defer: false)
    private let field = NSTextField()
    private let table = NSTableView()
    private var all: [Entry] = []
    private var results: [Entry] = []
    private var monitor: Any?

    private init(controller: BrowserWindowController) {
        self.controller = controller
        super.init()
        all = commands() + places()
        build()
        filter("")
    }

    private func commands() -> [Entry] {
        var out: [Entry] = []
        func walk(_ menu: NSMenu, path: [String]) {
            menu.update()
            for item in menu.items where !item.isSeparatorItem && !item.isHidden {
                if let sub = item.submenu {
                    // the app menu's title is the app's name; its items read better without it
                    walk(sub, path: path.isEmpty && menu === NSApp.mainMenu && item === NSApp.mainMenu?.items.first ? [] : path + [item.title.isEmpty ? sub.title : item.title])
                } else if item.action != nil, item.isEnabled, !item.title.isEmpty {
                    out.append(Entry(kind: .command(item), title: item.title, detail: path.joined(separator: " › "), icon: "command", keys: Self.keys(item)))
                }
            }
        }
        if let main = NSApp.mainMenu { walk(main, path: []) }
        return out
    }

    private func places() -> [Entry] {
        var seen = Set<String>()
        var out: [Entry] = []
        func add(_ url: URL, icon: String, detail: String) {
            let path = url.standardizedFileURL.path
            guard !seen.contains(path), FileManager.default.fileExists(atPath: path) else { return }
            seen.insert(path)
            let home = FileManager.default.homeDirectoryForCurrentUser.path
            let shown = path.hasPrefix(home) ? "~" + path.dropFirst(home.count) : path
            out.append(Entry(kind: .place(url), title: FileManager.default.displayName(atPath: path), detail: "\(detail)  ·  \(shown)", icon: icon, keys: ""))
        }
        for p in HomeView.quickAccess() { add(p.url, icon: p.icon, detail: String(localized: "Pinned")) }
        for path in UserDefaults.standard.stringArray(forKey: Self.recentKey) ?? [] { add(URL(fileURLWithPath: path), icon: "clock", detail: String(localized: "Recent")) }
        if let here = controller?.current, here.isFileURL,
            let kids = try? FileManager.default.contentsOfDirectory(at: here, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles])
        {
            for k in kids.prefix(300) where (try? k.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true {
                add(k, icon: "folder", detail: String(localized: "In this folder"))
            }
        }
        for v in FileManager.default.mountedVolumeURLs(includingResourceValuesForKeys: nil, options: [.skipHiddenVolumes]) ?? [] {
            add(v, icon: "hard-drive", detail: String(localized: "Drive"))
        }
        return out
    }

    static func keys(_ item: NSMenuItem) -> String {
        guard !item.keyEquivalent.isEmpty else { return "" }
        let m = item.keyEquivalentModifierMask
        var s = ""
        if m.contains(.control) { s += "⌃" }
        if m.contains(.option) { s += "⌥" }
        if m.contains(.shift) { s += "⇧" }
        if m.contains(.command) { s += "⌘" }
        switch item.keyEquivalent {
        case String(Character(UnicodeScalar(NSUpArrowFunctionKey)!)): s += "↑"
        case String(Character(UnicodeScalar(NSDownArrowFunctionKey)!)): s += "↓"
        case String(Character(UnicodeScalar(NSF2FunctionKey)!)): s += "F2"
        case String(Character(UnicodeScalar(NSBackspaceCharacter)!)): s += "⌫"
        default: s += item.keyEquivalent.uppercased()
        }
        return s
    }

    /// Letters of `q` in order in `text`: a score (higher better), or nil. Starts of words and runs count most.
    private static func score(_ q: String, _ text: String) -> Int? {
        if q.isEmpty { return 0 }
        let t = Array(text.lowercased())
        let qs = Array(q.lowercased())
        var ti = 0
        var score = 0
        var run = 0
        for c in qs {
            var found = false
            while ti < t.count {
                if t[ti] == c {
                    let wordStart = ti == 0 || " ›/-_.".contains(t[ti - 1])
                    run += 1
                    score += 1 + (wordStart ? 8 : 0) + run * 2
                    ti += 1
                    found = true
                    break
                }
                run = 0
                ti += 1
            }
            if !found { return nil }
        }
        // a shorter text with the same letters is the better match
        return score * 10 - t.count
    }

    private func filter(_ text: String) {
        let q = text.trimmingCharacters(in: .whitespaces)
        var list: [Entry] = []
        // a path typed in: go there
        if q.hasPrefix("/") || q.hasPrefix("~") {
            let path = (q as NSString).expandingTildeInPath
            var isDir: ObjCBool = false
            if FileManager.default.fileExists(atPath: path, isDirectory: &isDir) {
                let u = URL(fileURLWithPath: path)
                list.append(Entry(kind: .place(isDir.boolValue ? u : u.deletingLastPathComponent()), title: String(localized: "Go to “\(q)”"), detail: path, icon: "corner-down-right", keys: "↩", score: .max))
            }
        }
        for var e in all {
            guard let s = Self.score(q, e.title) ?? Self.score(q, e.title + " " + e.detail).map({ $0 / 3 }) else { continue }
            var isCommand = false
            if case .command = e.kind { isCommand = true }
            // with nothing typed, the places come first (they are what one opens the palette for most)
            e.score = s + (q.isEmpty && !isCommand ? 1 : 0)
            list.append(e)
        }
        if !q.isEmpty { list.sort { $0.score > $1.score } }
        results = Array(list.prefix(60))
        table.reloadData()
        if !results.isEmpty { table.selectRowIndexes([0], byExtendingSelection: false) }
    }

    // MARK: the panel

    private func build() {
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        panel.isReleasedWhenClosed = false
        panel.animationBehavior = .none

        let glass = NSVisualEffectView(frame: panel.contentView!.bounds)
        glass.material = .hudWindow
        glass.blendingMode = .behindWindow
        glass.state = .active
        glass.wantsLayer = true
        glass.layer?.cornerRadius = 16
        glass.layer?.masksToBounds = true
        glass.layer?.borderWidth = 0.5
        glass.layer?.borderColor = NSColor.white.withAlphaComponent(0.14).cgColor
        glass.autoresizingMask = [.width, .height]
        panel.contentView = glass

        let icon = NSImageView(image: Icons.named("search"))
        icon.contentTintColor = .secondaryLabelColor
        icon.frame = NSRect(x: 18, y: 420 - 44, width: 18, height: 18)
        glass.addSubview(icon)
        field.frame = NSRect(x: 44, y: 420 - 48, width: 560, height: 26)
        field.isBordered = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.font = .systemFont(ofSize: 17)
        field.placeholderString = String(localized: "Type a command, a folder or a path")
        field.delegate = self
        glass.addSubview(field)
        let line = NSBox(frame: NSRect(x: 0, y: 420 - 62, width: 620, height: 1))
        line.boxType = .separator
        glass.addSubview(line)

        let col = NSTableColumn(identifier: .init("e"))
        col.width = 600
        table.addTableColumn(col)
        table.headerView = nil
        table.rowHeight = 40
        table.backgroundColor = .clear
        table.style = .plain
        table.intercellSpacing = NSSize(width: 0, height: 2)
        table.dataSource = self
        table.delegate = self
        table.target = self
        table.doubleAction = #selector(runSelected)
        table.action = #selector(runSelected)
        let scroll = NSScrollView(frame: NSRect(x: 8, y: 8, width: 604, height: 420 - 74))
        scroll.documentView = table
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        glass.addSubview(scroll)
    }

    private func present(over window: NSWindow) {
        let f = window.frame
        let size = panel.frame.size
        let origin = NSPoint(x: f.midX - size.width / 2, y: f.maxY - 96 - size.height)
        panel.setFrameOrigin(origin)
        window.addChildWindow(panel, ordered: .above)
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(field)
        if Motion.on {
            panel.alphaValue = 0
            panel.setFrameOrigin(NSPoint(x: origin.x, y: origin.y + 8))
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.18
                ctx.timingFunction = Motion.ease
                panel.animator().alphaValue = 1
                panel.animator().setFrameOrigin(origin)
            }
        }
        // a click outside closes it
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] e in
            if let self, e.window !== self.panel { self.close() }
            return e
        }
        panel.onResign = { [weak self] in self?.close() }
    }

    private func close() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        panel.onResign = nil
        panel.parent?.removeChildWindow(panel)
        panel.orderOut(nil)
        Self.shown = nil
    }

    // MARK: keys and choosing

    func controlTextDidChange(_ obj: Notification) { filter(field.stringValue) }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        switch selector {
        case #selector(NSResponder.moveDown(_:)): move(1)
        case #selector(NSResponder.moveUp(_:)): move(-1)
        case #selector(NSResponder.insertNewline(_:)): runSelected()
        case #selector(NSResponder.cancelOperation(_:)): close()
        default: return false
        }
        return true
    }

    private func move(_ d: Int) {
        guard !results.isEmpty else { return }
        let i = min(max((table.selectedRow < 0 ? -1 : table.selectedRow) + d, 0), results.count - 1)
        table.selectRowIndexes([i], byExtendingSelection: false)
        table.scrollRowToVisible(i)
    }

    @objc private func runSelected() {
        let row = table.selectedRow
        guard results.indices.contains(row), let controller else { return }
        let e = results[row]
        close()
        controller.window?.makeKeyAndOrderFront(nil)
        switch e.kind {
        case .command(let item):
            // through the responder chain of the window in front, as the menu bar would
            DispatchQueue.main.async {
                if let action = item.action { NSApp.sendAction(action, to: item.target, from: item) }
            }
        case .place(let url):
            controller.navigate(to: url)
        }
    }

    func numberOfRows(in tableView: NSTableView) -> Int { results.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let e = results[row]
        let v = NSView(frame: NSRect(x: 0, y: 0, width: 600, height: 40))
        let img = NSImageView(frame: NSRect(x: 12, y: 12, width: 16, height: 16))
        img.image = Icons.named(e.icon)
        img.contentTintColor = .secondaryLabelColor
        v.addSubview(img)
        let title = NSTextField(labelWithString: e.title)
        title.font = .systemFont(ofSize: 13, weight: .medium)
        title.frame = NSRect(x: 40, y: 20, width: 440, height: 17)
        title.lineBreakMode = .byTruncatingTail
        v.addSubview(title)
        let detail = NSTextField(labelWithString: e.detail)
        detail.font = .systemFont(ofSize: 11)
        detail.textColor = .secondaryLabelColor
        detail.frame = NSRect(x: 40, y: 4, width: 440, height: 15)
        detail.lineBreakMode = .byTruncatingMiddle
        v.addSubview(detail)
        if !e.keys.isEmpty {
            let k = NSTextField(labelWithString: e.keys)
            k.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
            k.textColor = .secondaryLabelColor
            k.alignment = .right
            k.frame = NSRect(x: 480, y: 12, width: 104, height: 16)
            v.addSubview(k)
        }
        return v
    }

    func tableView(_ tableView: NSTableView, rowViewForRow row: Int) -> NSTableRowView? { PaletteRow() }
}

/// The palette's window: takes keys, and says when it loses them.
private final class PalettePanel: NSPanel {
    var onResign: (() -> Void)?
    override var canBecomeKey: Bool { true }
    override func resignKey() {
        super.resignKey()
        onResign?()
    }
}

/// A soft rounded highlight for the chosen row.
private final class PaletteRow: NSTableRowView {
    override func drawSelection(in dirtyRect: NSRect) {
        let r = bounds.insetBy(dx: 4, dy: 0)
        NSColor.labelColor.withAlphaComponent(0.10).setFill()
        NSBezierPath(roundedRect: r, xRadius: 8, yRadius: 8).fill()
    }
    override var isEmphasized: Bool { get { false } set {} }
}
