import AppKit
import PulseKit

// MARK: - what's taking space

/// "What's taking space here": big files not opened for a while, and duplicates, under a folder. Nothing is removed
/// without being ticked first; removing moves to the Trash (⌘Z puts it back).
@MainActor
final class DiskLensWindow: NSWindowController, NSTableViewDataSource, NSTableViewDelegate, NSWindowDelegate {
    private static var open: [DiskLensWindow] = []

    static func show(_ dir: URL) {
        let w = DiskLensWindow(dir)
        open.append(w)
        w.showWindow(nil)
        w.window?.center()
        w.scan()
    }

    private struct Row {
        let item: DiskLens.Item
        /// Duplicates: the group's number (rows of a group sit together); 0 for big & unused.
        let group: Int
        var ticked: Bool
    }

    private let dir: URL
    private let mode = NSSegmentedControl(labels: [String(localized: "Big & unused"), String(localized: "Duplicates")], trackingMode: .selectOne, target: nil, action: nil)
    private let minSize = NSPopUpButton()
    private let unused = NSPopUpButton()
    private let table = NSTableView()
    private let summary = NSTextField(labelWithString: "")
    private let spinner = NSProgressIndicator()
    private let trash = NSButton(title: String(localized: "Move to Trash"), target: nil, action: nil)
    private var items: [DiskLens.Item] = []
    private var rows: [Row] = []
    private var scanning: Task<Void, Never>?
    private var cancelled = false

    private init(_ dir: URL) {
        self.dir = dir
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 520), styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        w.title = String(localized: "Space in “\(dir.lastPathComponent)”")
        w.minSize = NSSize(width: 600, height: 380)
        w.isReleasedWhenClosed = false
        w.animationBehavior = Motion.on ? .documentWindow : .none
        super.init(window: w)
        w.delegate = self
        build()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    func windowWillClose(_ notification: Notification) {
        cancelled = true
        scanning?.cancel()
        Self.open.removeAll { $0 === self }
    }

    private func build() {
        mode.selectedSegment = 0
        mode.target = self
        mode.action = #selector(refilter)
        minSize.addItems(withTitles: ["50 MB", "100 MB", "500 MB", "1 GB"])
        minSize.selectItem(at: 1)
        unused.addItems(withTitles: [String(localized: "not opened in 3 months"), String(localized: "in 6 months"), String(localized: "in a year"), String(localized: "any age")])
        unused.selectItem(at: 1)
        for p in [minSize, unused] {
            p.target = self
            p.action = #selector(refilter)
        }
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false

        for (id, title, width) in [("tick", "", 28.0), ("name", String(localized: "File"), 300.0), ("size", String(localized: "Size"), 90.0), ("used", String(localized: "Last opened"), 130.0), ("where", String(localized: "Folder"), 200.0)] {
            let c = NSTableColumn(identifier: .init(id))
            c.title = title
            c.width = width
            table.addTableColumn(c)
        }
        table.dataSource = self
        table.delegate = self
        table.usesAlternatingRowBackgroundColors = true
        table.style = .inset
        table.target = self
        table.doubleAction = #selector(reveal)
        let scroll = NSScrollView()
        scroll.documentView = table
        scroll.hasVerticalScroller = true

        summary.textColor = .secondaryLabelColor
        summary.lineBreakMode = .byTruncatingTail
        summary.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        trash.target = self
        trash.action = #selector(moveToTrash)
        trash.bezelColor = .systemRed
        let rescan = NSButton(title: String(localized: "Scan again"), target: self, action: #selector(scanAgain))

        let top = NSStackView(views: [mode, NSView(), NSTextField(labelWithString: String(localized: "At least")), minSize, unused])
        top.spacing = 8
        let bottom = NSStackView(views: [spinner, summary, NSView(), rescan, trash])
        bottom.spacing = 8
        let stack = NSStackView(views: [top, scroll, bottom])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)
        stack.translatesAutoresizingMaskIntoConstraints = false
        let content = NSView()
        content.addSubview(stack)
        window?.contentView = content
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor), stack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            stack.topAnchor.constraint(equalTo: content.topAnchor), stack.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            top.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -32),
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -32),
            bottom.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -32),
            scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 200),
        ])
    }

    private var options: DiskLens.Options {
        var o = DiskLens.Options()
        o.minSize = [50, 100, 500, 1024][minSize.indexOfSelectedItem] * 1024 * 1024
        o.unusedFor = [90.0, 180, 365, 0][unused.indexOfSelectedItem] * 86_400
        return o
    }

    @objc private func scanAgain() { scan() }

    private func scan() {
        scanning?.cancel()
        cancelled = false
        spinner.startAnimation(nil)
        summary.stringValue = String(localized: "Looking through “\(dir.lastPathComponent)”…")
        trash.isEnabled = false
        let dir = self.dir
        scanning = Task.detached(priority: .userInitiated) { [weak self] in
            let found = DiskLens.scan(dir, cancelled: { Task.isCancelled })
            await MainActor.run {
                guard let self, !Task.isCancelled else { return }
                self.items = found
                self.refilter()
            }
        }
    }

    @objc private func refilter() {
        let dupes = mode.selectedSegment == 1
        unused.isEnabled = !dupes
        let items = self.items
        let options = self.options
        if !dupes {
            rows = DiskLens.bigAndUnused(items, options: options).map { Row(item: $0, group: 0, ticked: false) }
            finish()
            return
        }
        spinner.startAnimation(nil)
        summary.stringValue = String(localized: "Comparing files of the same size…")
        let minSize = min(options.minSize, 1024 * 1024)
        Task.detached(priority: .userInitiated) { [weak self] in
            let groups = DiskLens.duplicates(items, minSize: minSize, cancelled: { Task.isCancelled })
            await MainActor.run {
                guard let self else { return }
                // every copy but the first of a group is offered ticked (one stays, always)
                self.rows = groups.enumerated().flatMap { gi, g in g.enumerated().map { Row(item: $0.element, group: gi + 1, ticked: $0.offset > 0) } }
                self.finish()
            }
        }
    }

    private func finish() {
        spinner.stopAnimation(nil)
        table.reloadData()
        updateSummary()
    }

    private func updateSummary() {
        let fmt = ByteCountFormatter()
        let ticked = rows.filter(\.ticked)
        let total = rows.reduce(Int64(0)) { $0 + $1.item.size }
        if rows.isEmpty {
            summary.stringValue = items.isEmpty ? String(localized: "Nothing here.") : String(localized: "Nothing matches. \(items.count) files looked at.")
        } else if mode.selectedSegment == 1 {
            let groups = Set(rows.map(\.group)).count
            summary.stringValue = String(localized: "\(groups) sets of copies · \(fmt.string(fromByteCount: ticked.reduce(0) { $0 + $1.item.size })) ticked")
        } else {
            summary.stringValue = String(localized: "\(rows.count) files · \(fmt.string(fromByteCount: total)) · \(ticked.count) ticked")
        }
        trash.isEnabled = !ticked.isEmpty
        trash.title = ticked.isEmpty ? String(localized: "Move to Trash") : String(localized: "Move \(ticked.count) to Trash")
    }

    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let r = rows[row]
        switch tableColumn?.identifier.rawValue {
        case "tick":
            let b = NSButton(checkboxWithTitle: "", target: self, action: #selector(toggle(_:)))
            b.state = r.ticked ? .on : .off
            b.tag = row
            return b
        case "name":
            let v = NSTableCellView()
            let img = NSImageView(image: NSWorkspace.shared.icon(forFile: r.item.url.path))
            img.frame = NSRect(x: 2, y: 2, width: 16, height: 16)
            let t = NSTextField(labelWithString: r.item.url.lastPathComponent)
            t.lineBreakMode = .byTruncatingMiddle
            t.frame = NSRect(x: 24, y: 1, width: 270, height: 17)
            t.autoresizingMask = [.width]
            if r.group > 0 && rows.first(where: { $0.group == r.group })?.item.url == r.item.url { t.font = .systemFont(ofSize: 13, weight: .semibold) }
            v.addSubview(img)
            v.addSubview(t)
            return v
        case "size":
            let t = NSTextField(labelWithString: ByteCountFormatter.string(fromByteCount: r.item.size, countStyle: .file))
            t.alignment = .right
            return t
        case "used":
            let f = RelativeDateTimeFormatter()
            return NSTextField(labelWithString: r.item.lastUsed == .distantPast ? "—" : f.localizedString(for: r.item.lastUsed, relativeTo: Date()))
        default:
            let rel = r.item.url.deletingLastPathComponent().path.replacingOccurrences(of: dir.path, with: "")
            let t = NSTextField(labelWithString: rel.isEmpty ? "/" : rel)
            t.textColor = .secondaryLabelColor
            t.lineBreakMode = .byTruncatingHead
            return t
        }
    }

    @objc private func toggle(_ sender: NSButton) {
        guard rows.indices.contains(sender.tag) else { return }
        rows[sender.tag].ticked = sender.state == .on
        // never every copy of a set: one always stays
        if mode.selectedSegment == 1 {
            let g = rows[sender.tag].group
            if rows.filter({ $0.group == g }).allSatisfy(\.ticked) {
                rows[sender.tag].ticked = false
                sender.state = .off
                NSSound.beep()
            }
        }
        updateSummary()
    }

    @objc private func reveal() {
        let row = table.clickedRow
        guard rows.indices.contains(row) else { return }
        let u = rows[row].item.url
        AppDelegate.shared.openWindow(at: u.deletingLastPathComponent(), selecting: u.lastPathComponent)
    }

    @objc private func moveToTrash() {
        let urls = rows.filter(\.ticked).map(\.item.url)
        guard !urls.isEmpty else { return }
        do {
            let moved = try FileOps.trash(urls)
            FileUndo.shared.record(.moves(moved), title: String(localized: "Move to Trash"))
            let gone = Set(urls)
            items.removeAll { gone.contains($0.url) }
            rows.removeAll { gone.contains($0.item.url) }
            if mode.selectedSegment == 1 {
                // a set left with one file is no set any more
                let counts = Dictionary(grouping: rows, by: \.group).mapValues(\.count)
                rows.removeAll { (counts[$0.group] ?? 0) < 2 }
            }
            table.reloadData()
            updateSummary()
            Toast.show(String(localized: "\(moved.count) moved to the Trash (⌘Z puts them back)"), in: window)
        } catch {
            Toast.show(error.localizedDescription, in: window, isError: true)
        }
    }
}

// MARK: - the Shelf

/// A small floating tray: drop files on it from any folder (or "Add to Shelf"), then copy or move them all into the
/// folder in front, in one go. The list is kept between launches.
@MainActor
final class ShelfPanel: NSObject, NSTableViewDataSource, NSTableViewDelegate {
    static let shared = ShelfPanel()

    private let store = ShelfStore()
    private lazy var panel: NSPanel = {
        let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 300, height: 380), styleMask: [.titled, .closable, .resizable, .utilityWindow, .nonactivatingPanel], backing: .buffered, defer: false)
        p.title = String(localized: "Shelf")
        p.isFloatingPanel = true
        p.hidesOnDeactivate = false
        p.isReleasedWhenClosed = false
        p.minSize = NSSize(width: 240, height: 220)
        p.setFrameAutosaveName("pulse.shelf")
        build(in: p)
        return p
    }()
    private let table = ShelfTable()
    private let hint = NSTextField(labelWithString: String(localized: "Drop files here from any folder"))
    private var items: [URL] = []

    func toggle() {
        if panel.isVisible { panel.orderOut(nil) } else { show() }
    }

    func show() {
        reload()
        if !panel.isVisible && panel.frame.origin == .zero, let main = NSApp.mainWindow {
            panel.setFrameTopLeftPoint(NSPoint(x: main.frame.maxX - 320, y: main.frame.maxY - 80))
        }
        panel.orderFront(nil)
    }

    func reload() {
        items = store.items
        table.reloadData()
        hint.isHidden = !items.isEmpty
    }

    private func build(in p: NSPanel) {
        let col = NSTableColumn(identifier: .init("f"))
        col.width = 280
        table.addTableColumn(col)
        table.headerView = nil
        table.rowHeight = 26
        table.dataSource = self
        table.delegate = self
        table.allowsMultipleSelection = true
        table.registerForDraggedTypes([.fileURL])
        table.setDraggingSourceOperationMask([.copy, .move], forLocal: false)
        table.onDelete = { [weak self] in self?.removeSelected() }
        let scroll = NSScrollView()
        scroll.documentView = table
        scroll.hasVerticalScroller = true
        hint.textColor = .tertiaryLabelColor
        hint.alignment = .center

        let copy = NSButton(title: String(localized: "Copy here"), target: self, action: #selector(copyHere))
        let move = NSButton(title: String(localized: "Move here"), target: self, action: #selector(moveHere))
        let clear = NSButton(title: String(localized: "Clear"), target: self, action: #selector(clearAll))
        let buttons = NSStackView(views: [copy, move, NSView(), clear])
        buttons.spacing = 6
        let stack = NSStackView(views: [scroll, buttons])
        stack.orientation = .vertical
        stack.spacing = 8
        stack.edgeInsets = NSEdgeInsets(top: 8, left: 8, bottom: 8, right: 8)
        stack.translatesAutoresizingMaskIntoConstraints = false
        let content = NSView()
        content.addSubview(stack)
        content.addSubview(hint)
        hint.translatesAutoresizingMaskIntoConstraints = false
        p.contentView = content
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor), stack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            stack.topAnchor.constraint(equalTo: content.topAnchor), stack.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            hint.centerXAnchor.constraint(equalTo: content.centerXAnchor), hint.centerYAnchor.constraint(equalTo: content.centerYAnchor, constant: -16),
        ])
    }

    // the folder in front, where Copy here / Move here go
    private var target: (URL, BrowserWindowController)? {
        guard let c = AppDelegate.shared.frontController, c.current.isFileURL, !TrashBin.contains(c.current) else { return nil }
        return (c.current, c)
    }

    @objc private func copyHere() { transfer(.copy) }
    @objc private func moveHere() { transfer(.move) }

    private func transfer(_ kind: Transfer.Kind) {
        guard let (dest, controller) = target else { return Toast.show(String(localized: "Open a folder to put them in"), in: panel, isError: true) }
        let chosen = table.selectedRowIndexes.isEmpty ? items : table.selectedRowIndexes.compactMap { items.indices.contains($0) ? items[$0] : nil }
        let todo = chosen.filter { $0.deletingLastPathComponent().standardizedFileURL != dest.standardizedFileURL }
        guard !todo.isEmpty else { return Toast.show(String(localized: "They are already in this folder"), in: panel, isError: true) }
        controller.list.transfer(todo, into: dest, kind: kind, selectHere: true)
        if kind == .move {
            store.remove(todo)
            reload()
        }
    }

    @objc private func clearAll() {
        store.clear()
        reload()
    }

    private func removeSelected() {
        store.remove(table.selectedRowIndexes.compactMap { items.indices.contains($0) ? items[$0] : nil })
        reload()
    }

    func numberOfRows(in tableView: NSTableView) -> Int { items.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let u = items[row]
        let v = NSTableCellView()
        let img = NSImageView(image: NSWorkspace.shared.icon(forFile: u.path))
        img.frame = NSRect(x: 4, y: 4, width: 18, height: 18)
        let t = NSTextField(labelWithString: u.lastPathComponent)
        t.lineBreakMode = .byTruncatingMiddle
        t.frame = NSRect(x: 28, y: 4, width: 240, height: 18)
        t.autoresizingMask = [.width]
        t.toolTip = u.path
        v.addSubview(img)
        v.addSubview(t)
        return v
    }

    // dropping files on the shelf adds them; dragging from it takes them anywhere
    func tableView(_ tableView: NSTableView, validateDrop info: NSDraggingInfo, proposedRow row: Int, proposedDropOperation: NSTableView.DropOperation) -> NSDragOperation {
        info.draggingSource as? NSTableView === tableView ? [] : .copy
    }

    func tableView(_ tableView: NSTableView, acceptDrop info: NSDraggingInfo, row: Int, dropOperation: NSTableView.DropOperation) -> Bool {
        let urls = info.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
        let n = store.add(urls)
        reload()
        return n > 0
    }

    func tableView(_ tableView: NSTableView, pasteboardWriterForRow row: Int) -> NSPasteboardWriting? { items[row] as NSURL }
}

/// ⌫ removes the chosen items from the shelf (not from the disk).
private final class ShelfTable: NSTableView {
    var onDelete: (() -> Void)?
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 51 || event.keyCode == 117 { onDelete?() } else { super.keyDown(with: event) }
    }
}
