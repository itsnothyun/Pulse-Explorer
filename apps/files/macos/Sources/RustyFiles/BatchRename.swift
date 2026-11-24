import AppKit

/// Rename several items at once (the Windows app's bulk_rename.rs): find & replace (text or regular expression),
/// a prefix and a suffix, numbering, a change of case, with every new name previewed before anything moves. Names that
/// would clash (with each other or with what is already in the folder) are marked and stop the rename. One undo takes it
/// all back.
@MainActor
final class BatchRename: NSObject, NSTableViewDataSource, NSTableViewDelegate, NSTextFieldDelegate {
    private static var open: BatchRename?

    static func show(_ urls: [URL], in window: NSWindow, done: @escaping ([URL]) -> Void) {
        guard !urls.isEmpty else { return }
        let b = BatchRename(urls.sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }, done: done)
        open = b
        window.beginSheet(b.panel) { _ in open = nil }
    }

    private let urls: [URL]
    private let done: ([URL]) -> Void
    private let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 680, height: 560), styleMask: [.titled, .resizable], backing: .buffered, defer: false)

    private let find = NSTextField()
    private let replace = NSTextField()
    private let regex = NSButton(checkboxWithTitle: String(localized: "Regular expression"), target: nil, action: nil)
    private let matchCase = NSButton(checkboxWithTitle: String(localized: "Match case"), target: nil, action: nil)
    private let prefix = NSTextField()
    private let suffix = NSTextField()
    private let numbering = NSPopUpButton()
    private let start = NSTextField()
    private let digits = NSPopUpButton()
    private let caseMode = NSPopUpButton()
    private let keepExt = NSButton(checkboxWithTitle: String(localized: "Leave extensions as they are"), target: nil, action: nil)
    private let table = NSTableView()
    private let summary = NSTextField(labelWithString: "")
    private let apply = NSButton(title: String(localized: "Rename"), target: nil, action: nil)

    private var names: [String] = []
    private var clashes: Set<Int> = []
    private var invalid: String?

    private init(_ urls: [URL], done: @escaping ([URL]) -> Void) {
        self.urls = urls
        self.done = done
        super.init()
        build()
        recompute()
    }

    // MARK: the sheet

    private func label(_ s: String) -> NSTextField {
        let l = NSTextField(labelWithString: s)
        l.alignment = .right
        l.textColor = .secondaryLabelColor
        return l
    }

    private func build() {
        panel.title = String(localized: "Rename \(urls.count) items")
        panel.minSize = NSSize(width: 560, height: 460)
        for f in [find, replace, prefix, suffix, start] {
            f.delegate = self
            f.bezelStyle = .roundedBezel
        }
        find.placeholderString = String(localized: "Text to find")
        replace.placeholderString = String(localized: "Replace with")
        prefix.placeholderString = String(localized: "Before the name")
        suffix.placeholderString = String(localized: "After the name")
        start.stringValue = "1"
        start.alignment = .right
        for c in [regex, matchCase, keepExt] {
            c.target = self
            c.action = #selector(changed)
        }
        keepExt.state = .on
        numbering.addItems(withTitles: [String(localized: "No numbers"), String(localized: "Number before the name"), String(localized: "Number after the name")])
        digits.addItems(withTitles: ["1", "01", "001", "0001"])
        digits.selectItem(at: 1)
        caseMode.addItems(withTitles: [String(localized: "Case as it is"), String(localized: "lowercase"), String(localized: "UPPERCASE"), String(localized: "Title Case"), String(localized: "kebab-case"), String(localized: "snake_case")])
        for p in [numbering, digits, caseMode] {
            p.target = self
            p.action = #selector(changed)
        }

        let grid = NSGridView(views: [
            [label(String(localized: "Find")), find],
            [label(String(localized: "Replace")), replace],
            [NSGridCell.emptyContentView, row([regex, matchCase])],
            [label(String(localized: "Add")), row([prefix, suffix])],
            [label(String(localized: "Numbers")), row([numbering, NSTextField(labelWithString: String(localized: "from")), start, NSTextField(labelWithString: String(localized: "as")), digits])],
            [label(String(localized: "Case")), row([caseMode, keepExt])],
        ])
        grid.rowSpacing = 8
        grid.columnSpacing = 10
        grid.column(at: 0).xPlacement = .trailing
        grid.column(at: 0).width = 70
        start.widthAnchor.constraint(equalToConstant: 56).isActive = true
        for c in [find, replace] { c.widthAnchor.constraint(greaterThanOrEqualToConstant: 420).isActive = true }

        let old = NSTableColumn(identifier: .init("old"))
        old.title = String(localized: "Now")
        let new = NSTableColumn(identifier: .init("new"))
        new.title = String(localized: "After")
        for c in [old, new] {
            c.width = 300
            table.addTableColumn(c)
        }
        table.dataSource = self
        table.delegate = self
        table.usesAlternatingRowBackgroundColors = true
        table.style = .inset
        let scroll = NSScrollView()
        scroll.documentView = table
        scroll.hasVerticalScroller = true
        scroll.borderType = .noBorder

        summary.textColor = .secondaryLabelColor
        summary.lineBreakMode = .byTruncatingTail
        let cancel = NSButton(title: String(localized: "Cancel"), target: self, action: #selector(cancelSheet))
        cancel.keyEquivalent = "\u{1b}"
        apply.target = self
        apply.action = #selector(applyRename)
        apply.keyEquivalent = "\r"
        let buttons = row([summary, NSView(), cancel, apply])
        summary.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let stack = NSStackView(views: [grid, scroll, buttons])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 14
        stack.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 18, right: 20)
        stack.translatesAutoresizingMaskIntoConstraints = false
        let content = NSView()
        content.addSubview(stack)
        panel.contentView = content
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            stack.topAnchor.constraint(equalTo: content.topAnchor),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -40),
            buttons.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -40),
            scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 180),
        ])
        panel.initialFirstResponder = find
    }

    private func row(_ views: [NSView]) -> NSStackView {
        let s = NSStackView(views: views)
        s.orientation = .horizontal
        s.spacing = 8
        return s
    }

    // MARK: the names

    func controlTextDidChange(_ obj: Notification) { recompute() }
    @objc private func changed() { recompute() }

    private func transform(_ name: String, index: Int) -> String {
        var base = name
        var ext = ""
        if keepExt.state == .on, let dot = name.lastIndex(of: "."), dot != name.startIndex {
            base = String(name[..<dot])
            ext = String(name[dot...])
        }
        let f = find.stringValue
        if !f.isEmpty {
            if regex.state == .on {
                if let re = try? NSRegularExpression(pattern: f, options: matchCase.state == .on ? [] : [.caseInsensitive]) {
                    base = re.stringByReplacingMatches(in: base, range: NSRange(base.startIndex..., in: base), withTemplate: replace.stringValue)
                }
            } else {
                base = base.replacingOccurrences(of: f, with: replace.stringValue, options: matchCase.state == .on ? [] : [.caseInsensitive])
            }
        }
        switch caseMode.indexOfSelectedItem {
        case 1: base = base.lowercased()
        case 2: base = base.uppercased()
        case 3: base = base.capitalized
        case 4: base = words(base).joined(separator: "-").lowercased()
        case 5: base = words(base).joined(separator: "_").lowercased()
        default: break
        }
        base = prefix.stringValue + base + suffix.stringValue
        if numbering.indexOfSelectedItem > 0 {
            let n = (Int(start.stringValue) ?? 1) + index
            let width = digits.indexOfSelectedItem + 1
            let num = String(repeating: "0", count: max(0, width - String(n).count)) + String(n)
            base = numbering.indexOfSelectedItem == 1 ? "\(num) \(base)" : "\(base) \(num)"
        }
        return base + ext
    }

    private func words(_ s: String) -> [String] {
        // splits on spaces, dashes, underscores and dots, and between a lower- and an upper-case letter (camelCase)
        var out: [String] = []
        var cur = ""
        var prevLower = false
        for ch in s {
            if " -_.".contains(ch) {
                if !cur.isEmpty { out.append(cur) }
                cur = ""
                prevLower = false
                continue
            }
            if ch.isUppercase && prevLower {
                out.append(cur)
                cur = ""
            }
            cur.append(ch)
            prevLower = ch.isLowercase
        }
        if !cur.isEmpty { out.append(cur) }
        return out
    }

    private func recompute() {
        invalid = nil
        if regex.state == .on, !find.stringValue.isEmpty, (try? NSRegularExpression(pattern: find.stringValue)) == nil {
            invalid = String(localized: "The regular expression isn’t valid.")
        }
        names = urls.enumerated().map { transform($0.element.lastPathComponent, index: $0.offset) }
        // a clash: two new names alike, a name taken by something not being renamed, or a name that can't be
        clashes = []
        let moving = Set(urls.map { $0.path.lowercased() })
        var seen: [String: Int] = [:]
        for (i, n) in names.enumerated() {
            let key = n.lowercased()
            if n.isEmpty || n.contains("/") || n == "." || n == ".." { clashes.insert(i) }
            if let j = seen[key] {
                clashes.insert(i)
                clashes.insert(j)
            }
            seen[key] = i
            let dest = urls[i].deletingLastPathComponent().appendingPathComponent(n).path
            if dest.lowercased() != urls[i].path.lowercased(), !moving.contains(dest.lowercased()), FileManager.default.fileExists(atPath: dest) {
                clashes.insert(i)
            }
        }
        let changing = zip(urls, names).filter { $0.0.lastPathComponent != $0.1 }.count
        if let invalid {
            summary.stringValue = invalid
        } else if !clashes.isEmpty {
            summary.stringValue = String(localized: "\(clashes.count) names clash or aren’t allowed (in red).")
        } else {
            summary.stringValue = changing == 0 ? String(localized: "No names change yet.") : String(localized: "\(changing) of \(urls.count) names change.")
        }
        summary.textColor = invalid != nil || !clashes.isEmpty ? .systemRed : .secondaryLabelColor
        apply.isEnabled = invalid == nil && clashes.isEmpty && changing > 0
        table.reloadData()
    }

    func numberOfRows(in tableView: NSTableView) -> Int { urls.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let isNew = tableColumn?.identifier.rawValue == "new"
        let t = NSTextField(labelWithString: isNew ? names[row] : urls[row].lastPathComponent)
        t.lineBreakMode = .byTruncatingMiddle
        if isNew {
            let same = names[row] == urls[row].lastPathComponent
            t.textColor = clashes.contains(row) ? .systemRed : (same ? .tertiaryLabelColor : .labelColor)
            t.font = same ? .systemFont(ofSize: 13) : .systemFont(ofSize: 13, weight: .medium)
        } else {
            t.textColor = .secondaryLabelColor
        }
        return t
    }

    // MARK: doing it

    @objc private func cancelSheet() { panel.sheetParent?.endSheet(panel) }

    @objc private func applyRename() {
        let pairs = zip(urls, names).filter { $0.0.lastPathComponent != $0.1 }.map { (from: $0.0, name: $0.1) }
        let done = self.done
        let window = panel.sheetParent
        panel.sheetParent?.endSheet(panel)
        Task.detached(priority: .userInitiated) {
            // two steps, so names that trade places (a → b, b → a) never meet: everything to a passing name first
            var made: [(from: URL, to: URL)] = []
            var failure: String?
            var parked: [(tmp: URL, final: URL, original: URL)] = []
            for p in pairs {
                let tmp = p.from.deletingLastPathComponent().appendingPathComponent(".pulse-rename-\(UUID().uuidString)")
                do {
                    try FileManager.default.moveItem(at: p.from, to: tmp)
                    parked.append((tmp, p.from.deletingLastPathComponent().appendingPathComponent(p.name), p.from))
                } catch {
                    failure = error.localizedDescription
                    break
                }
            }
            for p in parked {
                do {
                    try FileManager.default.moveItem(at: p.tmp, to: p.final)
                    made.append((from: p.final, to: p.original))
                } catch {
                    // put it back as it was
                    try? FileManager.default.moveItem(at: p.tmp, to: p.original)
                    failure = failure ?? error.localizedDescription
                }
            }
            let undo = made
            let fail = failure
            await MainActor.run {
                if !undo.isEmpty { FileUndo.shared.record(.moves(undo), title: String(localized: "Rename")) }
                done(undo.map(\.from))
                if let fail, let window {
                    let a = NSAlert()
                    a.messageText = String(localized: "Some items couldn’t be renamed.")
                    a.informativeText = fail
                    a.beginSheetModal(for: window)
                }
            }
        }
    }
}
