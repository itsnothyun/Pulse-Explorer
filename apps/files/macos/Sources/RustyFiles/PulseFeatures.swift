import AppKit
import PulseKit

// Pulse's everyday tools in the Mac file manager. The logic lives in PulseKit (tested there); this file is the menus,
// sheets and panels that use it.

// MARK: - a short message over the window

@MainActor
enum Toast {
    private static var panel: NSPanel?
    private static var hide: DispatchWorkItem?

    /// A small glass message at the bottom of `window` for a moment ("Text copied", "3 images made").
    static func show(_ text: String, in window: NSWindow?, isError: Bool = false) {
        guard let window else { return }
        let p = panel ?? {
            let p = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            p.isOpaque = false
            p.backgroundColor = .clear
            p.hasShadow = true
            p.ignoresMouseEvents = true
            p.level = .floating
            p.animationBehavior = .none
            let glass = NSVisualEffectView()
            glass.material = .hudWindow
            glass.blendingMode = .behindWindow
            glass.state = .active
            glass.wantsLayer = true
            glass.layer?.cornerRadius = 15
            glass.layer?.masksToBounds = true
            let label = NSTextField(labelWithString: "")
            label.font = .systemFont(ofSize: 13, weight: .medium)
            label.tag = 1
            glass.addSubview(label)
            p.contentView = glass
            panel = p
            return p
        }()
        guard let label = p.contentView?.viewWithTag(1) as? NSTextField else { return }
        label.stringValue = text
        label.textColor = isError ? .systemRed : .labelColor
        label.sizeToFit()
        let size = NSSize(width: min(label.frame.width + 32, 560), height: 30)
        label.frame = NSRect(x: 16, y: (30 - label.frame.height) / 2, width: size.width - 32, height: label.frame.height)
        let f = window.frame
        p.setFrame(NSRect(x: f.midX - size.width / 2, y: f.minY + 48, width: size.width, height: size.height), display: true)
        if p.parent !== window {
            p.parent?.removeChildWindow(p)
            window.addChildWindow(p, ordered: .above)
        }
        p.alphaValue = 0
        p.orderFront(nil)
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = Motion.on ? 0.16 : 0
            p.animator().alphaValue = 1
        }
        hide?.cancel()
        let work = DispatchWorkItem {
            MainActor.assumeIsolated {
                NSAnimationContext.runAnimationGroup({ ctx in
                    ctx.duration = Motion.on ? 0.2 : 0
                    p.animator().alphaValue = 0
                }, completionHandler: { MainActor.assumeIsolated { if p.alphaValue == 0 { p.orderOut(nil) } } })
            }
        }
        hide = work
        DispatchQueue.main.asyncAfter(deadline: .now() + (isError ? 3.5 : 2.2), execute: work)
    }
}

// MARK: - the menus

@MainActor
enum PulseFeatureMenus {
    /// Items for a selection: Copy text, Image tools, Run script, Add to Shelf.
    static func forItems(_ urls: [URL], list: FileListController, into b: MenuBuilder) {
        guard !urls.isEmpty, urls.allSatisfy(\.isFileURL) else { return }
        let window = list.card.window
        if urls.allSatisfy(TextRecognition.canRead) {
            b.add(String(localized: "Copy text"), "scan-text") { copyText(urls, window: window) }
        }
        let images = urls.filter(ImageTools.canProcess)
        if images.count == urls.count {
            b.sub(String(localized: "Image tools"), "image") { s in
                s.add(String(localized: "Convert to JPEG")) { imageTool(.convert(to: "jpeg"), images, list: list) }
                s.add(String(localized: "Convert to PNG")) { imageTool(.convert(to: "png"), images, list: list) }
                s.add(String(localized: "Convert to HEIC")) { imageTool(.convert(to: "heic"), images, list: list) }
                s.separator()
                s.add(String(localized: "Resize to 50%")) { imageTool(.resize(percent: 50), images, list: list) }
                s.add(String(localized: "Resize to 25%")) { imageTool(.resize(percent: 25), images, list: list) }
                s.separator()
                s.add(String(localized: "Compress for email")) { imageTool(.compress(maxSide: 2048), images, list: list) }
            }
        }
        if urls.count == 1, ProjectScripts.handles(urls[0]) {
            let scripts = ProjectScripts.scripts(in: urls[0])
            b.sub(String(localized: "Run script"), "play") { s in
                if scripts.isEmpty { s.add(String(localized: "No scripts found"), enabled: false) {} }
                for sc in scripts.prefix(40) {
                    let item = s.add(sc.name, nil) { ScriptRunner.run(sc, in: urls[0].deletingLastPathComponent(), window: window) }
                    item.toolTip = sc.detail.isEmpty ? sc.command : "\(sc.command)\n\(sc.detail)"
                }
            }
        }
        b.add(String(localized: "Add to Shelf"), "inbox") {
            let n = ShelfStore().add(urls)
            ShelfPanel.shared.reload()
            Toast.show(n == 0 ? String(localized: "Already on the Shelf") : String(localized: "\(n) added to the Shelf"), in: window)
        }
    }

    /// Items for the folder itself: Paste as file, its note, what takes space, what changed today.
    static func forFolder(_ dir: URL, list: FileListController, into b: MenuBuilder) {
        guard dir.isFileURL else { return }
        let window = list.card.window
        if !Clipboard.hasFiles, PasteAsFile.available {
            b.add(String(localized: "Paste as file"), "clipboard-paste", key: "v") { PasteAsFile.paste(into: dir, list: list) }
        }
        let note = FolderNotes.read(dir)
        b.add(note == nil ? String(localized: "Add a note…") : String(localized: "Edit note…"), "sticky-note") {
            NoteEditor.edit(dir, in: window) { list.refreshNote() }
        }
        b.add(String(localized: "What’s taking space here…"), "hard-drive") { DiskLensWindow.show(dir) }
        b.add(String(localized: "Changed today"), "clock") { AppDelegate.shared.frontController?.navigate(to: TodayPlace.url(in: dir)) }
    }

    // MARK: actions

    static func copyText(_ urls: [URL], window: NSWindow?) {
        Toast.show(String(localized: "Reading text…"), in: window)
        Task.detached(priority: .userInitiated) {
            var parts: [String] = []
            var failure: String?
            for u in urls {
                do { parts.append(try TextRecognition.text(of: u)) } catch { failure = error.localizedDescription }
            }
            let text = parts.filter { !$0.isEmpty }.joined(separator: "\n\n")
            await MainActor.run {
                if text.isEmpty {
                    Toast.show(failure ?? String(localized: "No text found"), in: window, isError: true)
                    return
                }
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(text, forType: .string)
                let lines = text.split(whereSeparator: \.isNewline).count
                Toast.show(String(localized: "Text copied (\(lines) lines)"), in: window)
            }
        }
    }

    static func imageTool(_ action: ImageTools.Action, _ urls: [URL], list: FileListController) {
        let window = list.card.window
        Task.detached(priority: .userInitiated) {
            var made: [URL] = []
            var errors: [String] = []
            var planned = Set<String>()
            for u in urls {
                let dir = u.deletingLastPathComponent()
                let existing = Set(((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []).map { $0.lowercased() })
                guard let plan = ImageTools.plan(action, source: u, size: ImageTools.pixelSize(u), taken: { existing.contains($0.lowercased()) || planned.contains($0.lowercased()) }) else {
                    errors.append(u.lastPathComponent)
                    continue
                }
                planned.insert(plan.name.lowercased())
                let out = dir.appendingPathComponent(plan.name)
                if let e = ImageTools.run(args: plan.args, source: u, output: out) { errors.append("\(u.lastPathComponent): \(e)") } else { made.append(out) }
            }
            let done = made, skipped = errors
            await MainActor.run {
                if !done.isEmpty {
                    FileUndo.shared.record(.trash(done), title: String(localized: "Image tools"))
                    list.reloadAndSelect(done.map(\.lastPathComponent))
                }
                if done.isEmpty {
                    Toast.show(String(localized: "Nothing to make (already in that format?)"), in: window, isError: true)
                } else {
                    Toast.show(skipped.isEmpty ? String(localized: "\(done.count) made") : String(localized: "\(done.count) made, \(skipped.count) skipped"), in: window)
                }
            }
        }
    }
}

// MARK: - paste as file

@MainActor
enum PasteAsFile {
    /// Whether the clipboard holds something this can make a file of (and no files, which ⌘V pastes as themselves).
    static var available: Bool {
        let pb = NSPasteboard.general
        let types = pb.types ?? []
        return types.contains(.png) || types.contains(.tiff) || types.contains(.pdf) || types.contains(.string)
    }

    static func paste(into dir: URL, list: FileListController) {
        let pb = NSPasteboard.general
        var png = pb.data(forType: .png)
        if png == nil, let tiff = pb.data(forType: .tiff), let rep = NSBitmapImageRep(data: tiff) {
            png = rep.representation(using: .png, properties: [:])
        }
        let title = pb.string(forType: NSPasteboard.PasteboardType("public.url-name"))
        guard let content = ClipboardFile.choose(image: png, pdf: pb.data(forType: .pdf), string: pb.string(forType: .string), urlTitle: title) else {
            return Toast.show(String(localized: "Nothing on the clipboard to paste"), in: list.card.window, isError: true)
        }
        let existing = Set(((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []).map { $0.lowercased() })
        let out = ClipboardFile.output(for: content) { existing.contains($0.lowercased()) }
        let dest = dir.appendingPathComponent(out.name)
        do {
            try out.data.write(to: dest, options: .withoutOverwriting)
            FileUndo.shared.record(.trash([dest]), title: String(localized: "Paste as File"))
            list.reloadAndSelect([out.name])
            Toast.show(String(localized: "Pasted as “\(out.name)”"), in: list.card.window)
        } catch {
            Toast.show(error.localizedDescription, in: list.card.window, isError: true)
        }
    }
}

// MARK: - folder notes

@MainActor
enum NoteEditor {
    static func edit(_ dir: URL, in window: NSWindow?, done: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = String(localized: "Note for “\(dir.lastPathComponent)”")
        alert.informativeText = String(localized: "Shown at the top of the folder. It is kept on the folder, so it moves and copies with it.")
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 380, height: 120))
        let text = NSTextView(frame: scroll.bounds)
        text.string = FolderNotes.read(dir) ?? ""
        text.font = .systemFont(ofSize: 13)
        text.isRichText = false
        text.autoresizingMask = [.width]
        scroll.documentView = text
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        alert.accessoryView = scroll
        alert.addButton(withTitle: String(localized: "Save"))
        alert.addButton(withTitle: String(localized: "Cancel"))
        if FolderNotes.read(dir) != nil { alert.addButton(withTitle: String(localized: "Remove note")) }
        let handle = { (r: NSApplication.ModalResponse) in
            do {
                switch r {
                case .alertFirstButtonReturn: try FolderNotes.write(text.string, to: dir)
                case .alertThirdButtonReturn: try FolderNotes.write("", to: dir)
                default: return
                }
                done()
            } catch {
                Toast.show(error.localizedDescription, in: window, isError: true)
            }
        }
        if let window {
            alert.beginSheetModal(for: window) { r in MainActor.assumeIsolated { handle(r) } }
            alert.window.makeFirstResponder(text)
        } else {
            handle(alert.runModal())
        }
    }
}

/// The note, at the top of the folder: a calm strip with the text and an edit button.
@MainActor
final class NoteBanner: FlippedView {
    private let label = NSTextField(wrappingLabelWithString: "")
    private let edit = IconButton(icon: "pencil", size: NSSize(width: 26, height: 26), iconSize: 13, tooltip: String(localized: "Edit note"))
    var onEdit: (() -> Void)?
    static let height: CGFloat = 40

    override init(frame: NSRect) {
        super.init(frame: frame)
        label.font = .systemFont(ofSize: 12)
        label.maximumNumberOfLines = 2
        label.lineBreakMode = .byTruncatingTail
        addSubview(label)
        addSubview(edit)
        edit.action = { [weak self] _ in self?.onEdit?() }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    var text: String? {
        didSet {
            label.stringValue = text ?? ""
            isHidden = text == nil
        }
    }

    override func layout() {
        super.layout()
        label.frame = NSRect(x: 34, y: 4, width: bounds.width - 34 - 40, height: bounds.height - 8)
        edit.frame = NSRect(x: bounds.width - 34, y: (bounds.height - 26) / 2, width: 26, height: 26)
    }

    override func draw(_ dirtyRect: NSRect) {
        let p = Palette.of(self)
        let r = bounds.insetBy(dx: 8, dy: 4)
        Draw.roundedRect(r, radius: 8, fill: p.accent.withAlphaComponent(0.08))
        Draw.icon("sticky-note", in: NSRect(x: 14, y: bounds.midY - 7, width: 14, height: 14), size: 14, color: p.accent)
        label.textColor = p.text
    }
}

// MARK: - run a project's script

@MainActor
enum ScriptRunner {
    /// Opens a Terminal window in `dir` running the script: a small .command file Terminal opens (no Automation
    /// permission needed), which stays open afterwards so the output can be read.
    static func run(_ script: ProjectScripts.Script, in dir: URL, window: NSWindow?) {
        let quoted = "'" + dir.path.replacingOccurrences(of: "'", with: "'\\''") + "'"
        let body = """
            #!/bin/zsh -l
            cd \(quoted) || exit 1
            printf '\\033]0;%s\\007' \(ProjectScripts.quoteArg(script.name))
            echo "▶ \(script.command.replacingOccurrences(of: "\"", with: "\\\""))"
            \(script.command)
            echo
            echo "[Pulse] finished with exit code $?"
            exec $SHELL -l
            """
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("pulse-run-\(UUID().uuidString.prefix(8)).command")
        do {
            try body.write(to: file, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: file.path)
            let terminal = URL(fileURLWithPath: "/System/Applications/Utilities/Terminal.app")
            NSWorkspace.shared.open([file], withApplicationAt: terminal, configuration: NSWorkspace.OpenConfiguration())
            Toast.show(String(localized: "Running “\(script.name)” in Terminal"), in: window)
        } catch {
            Toast.show(error.localizedDescription, in: window, isError: true)
        }
    }
}

// MARK: - changed today (a tab, as a search's results)

enum TodayPlace {
    nonisolated static func url(in dir: URL) -> URL {
        var c = URLComponents()
        c.scheme = "rustyfiles"
        c.path = "today"
        c.queryItems = [URLQueryItem(name: "in", value: dir.path)]
        return c.url!
    }

    nonisolated static func parse(_ url: URL) -> URL? {
        guard url.scheme == "rustyfiles", let c = URLComponents(url: url, resolvingAgainstBaseURL: false), c.path == "today",
            let dir = c.queryItems?.first(where: { $0.name == "in" })?.value
        else { return nil }
        return URL(fileURLWithPath: dir)
    }

    /// Today's files, newest first.
    nonisolated static func paths(_ dir: URL) -> [String] {
        ChangedToday.group(ChangedToday.scan(dir)).flatMap(\.files).map(\.path)
    }
}

// MARK: - workspaces

@MainActor
enum WorkspaceActions {
    static func saveCurrent(_ controller: BrowserWindowController) {
        let alert = NSAlert()
        alert.messageText = String(localized: "Save tabs as a workspace")
        alert.informativeText = String(localized: "Open these \(controller.tabAddresses.count) tabs again later, from File › Open Workspace or ⌘K.")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
        field.placeholderString = String(localized: "Name, e.g. Client X")
        alert.accessoryView = field
        alert.addButton(withTitle: String(localized: "Save"))
        alert.addButton(withTitle: String(localized: "Cancel"))
        guard let window = controller.window else { return }
        alert.beginSheetModal(for: window) { r in
            MainActor.assumeIsolated {
                guard r == .alertFirstButtonReturn else { return }
                let w = Workspace(name: field.stringValue, tabs: controller.tabAddresses, active: controller.activeTab)
                if WorkspaceStore().save(w) {
                    Toast.show(String(localized: "Workspace “\(w.name.trimmingCharacters(in: .whitespaces))” saved"), in: window)
                    NSApp.mainMenu = MainMenu.make()
                } else {
                    Toast.show(String(localized: "Give it a name"), in: window, isError: true)
                }
            }
        }
        alert.window.makeFirstResponder(field)
    }

    static func open(_ w: Workspace) {
        let wc = AppDelegate.shared.makeController(at: BrowserTab.homeURL)
        wc.restore(w.tabs, active: w.active)
        wc.showWindow(nil)
    }

    /// File › Open Workspace: one item each, and Remove.
    static func menu() -> NSMenu {
        let b = MenuBuilder()
        let all = WorkspaceStore().all
        if all.isEmpty { b.add(String(localized: "No workspaces yet"), enabled: false) {} }
        for w in all {
            let item = b.add(w.name, "layout-grid") { open(w) }
            item.toolTip = w.tabs.joined(separator: "\n")
        }
        if !all.isEmpty {
            b.separator()
            b.sub(String(localized: "Remove"), "trash") { s in
                for w in all {
                    s.add(w.name) {
                        WorkspaceStore().remove(named: w.name)
                        NSApp.mainMenu = MainMenu.make()
                    }
                }
            }
        }
        return b.done()
    }
}
