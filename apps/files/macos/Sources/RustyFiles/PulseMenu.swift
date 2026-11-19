import AppKit
import QuartzCore

/// Pulse's right-click menu on the Mac: the same NSMenu the app builds (MenuBuilder), shown in a glass panel that opens
/// with motion instead of AppKit's menu window, whose entrance cannot be changed. The panel grows out of the point it was
/// opened at on a spring while it fades in, and its rows follow it in one after another (as the Windows menu, fluent_menu.rs);
/// a submenu slides out from its row. Keys work as in a menu: arrows, → / ← for submenus, Return, Esc.
///
/// With Settings › Animations off (or Reduce motion) the native menu is used, unchanged.
@MainActor
final class PulseMenu {
    private static var current: PulseMenu?

    /// Opens `menu` at the pointer (or `point`, in screen coordinates). `view` is the view it belongs to: macOS's Services
    /// for it stay one click away under "More options".
    static func show(_ menu: NSMenu, for event: NSEvent?, in view: NSView, at point: NSPoint? = nil) {
        closeAll()
        let at = point ?? NSEvent.mouseLocation
        guard Motion.on else {
            let local = view.convert(view.window?.convertPoint(fromScreen: at) ?? .zero, from: nil)
            menu.popUp(positioning: nil, at: local, in: view)
            return
        }
        let m = PulseMenu(menu, view: view)
        current = m
        m.open(at: at)
    }

    static func closeAll() {
        current?.close(animated: false)
        current = nil
    }

    static var isOpen: Bool { current != nil }

    private let root: NSMenu
    private weak var owner: NSView?
    private var levels: [MenuLevel] = []
    private var monitors: [Any] = []
    private var observers: [NSObjectProtocol] = []

    private init(_ menu: NSMenu, view: NSView) {
        root = menu
        owner = view
    }

    private func open(at point: NSPoint) {
        root.update()
        // the native menu's own extras (Services) are a click away, as Windows' "Show more options"
        if owner is NSServicesMenuRequestor, root.items.contains(where: { !$0.isSeparatorItem }) {
            root.addItem(.separator())
            let more = ClosureMenuItem(title: String(localized: "Show more options")) { [weak self] in self?.showNative() }
            more.image = Icons.named("ellipsis")
            root.addItem(more)
        }
        let level = MenuLevel(menu: root, depth: 0, owner: self)
        levels = [level]
        level.present(at: point, from: nil)
        watch()
    }

    /// The menu as AppKit shows it (with Services and Quick Actions), at the same place.
    private func showNative() {
        guard let view = owner, let window = view.window else { return }
        let at = levels.first?.panel.frame.origin ?? NSEvent.mouseLocation
        if let more = root.items.last, more.title == String(localized: "Show more options") {
            root.removeItem(more)
            if root.items.last?.isSeparatorItem == true { root.removeItem(at: root.items.count - 1) }
        }
        let topLeft = NSPoint(x: at.x, y: (levels.first?.panel.frame.maxY ?? at.y))
        close(animated: false)
        Self.current = nil
        DispatchQueue.main.async {
            self.root.popUp(positioning: nil, at: view.convert(window.convertPoint(fromScreen: topLeft), from: nil), in: view)
        }
    }

    // MARK: levels

    fileprivate func openSubmenu(of item: NSMenuItem, row: NSRect, from level: MenuLevel) {
        guard let sub = item.submenu else { return }
        closeLevels(after: level.depth)
        sub.update()
        let child = MenuLevel(menu: sub, depth: level.depth + 1, owner: self)
        levels.append(child)
        child.present(at: NSPoint(x: row.maxX - 4, y: row.maxY + 6), from: row)
    }

    fileprivate func closeLevels(after depth: Int) {
        while levels.count > depth + 1 { levels.removeLast().close(animated: true) }
    }

    fileprivate func perform(_ item: NSMenuItem) {
        close(animated: true)
        Self.current = nil
        guard let action = item.action else { return }
        // after the panel has started to go, as a menu's action runs after the menu closed
        DispatchQueue.main.async { NSApp.sendAction(action, to: item.target, from: item) }
    }

    fileprivate func dismiss(_ why: String = "") {
        close(animated: true)
        Self.current = nil
    }

    private func close(animated: Bool) {
        monitors.forEach(NSEvent.removeMonitor)
        monitors = []
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        levels.reversed().forEach { $0.close(animated: animated) }
        levels = []
    }

    // MARK: events

    private func watch() {
        // a click anywhere else closes the menu (and still does what it does there)
        monitors.append(NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]) { [weak self] e in
            guard let self else { return e }
            if !self.levels.contains(where: { $0.panel === e.window }) { self.dismiss("local click") }
            return e
        } as Any)
        if let g = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown], handler: { [weak self] _ in
            MainActor.assumeIsolated { self?.dismiss("global click") }
        }) { monitors.append(g) }
        monitors.append(NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] e in
            guard let self else { return e }
            return self.key(e) ? nil : e
        } as Any)
        observers.append(NotificationCenter.default.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.dismiss("resign active") }
        })
    }

    /// Arrows move, → opens a submenu, ← and Esc go back, Return runs.
    private func key(_ e: NSEvent) -> Bool {
        guard let level = levels.last else { return false }
        switch Int(e.keyCode) {
        case 125: level.content.move(1); return true  // down
        case 126: level.content.move(-1); return true  // up
        case 124:  // right
            if let i = level.content.highlighted, let item = level.content.item(i), item.hasSubmenu {
                openSubmenu(of: item, row: level.content.screenRect(ofRow: i), from: level)
                levels.last?.content.move(1)
            }
            return true
        case 123:  // left
            if levels.count > 1 { closeLevels(after: levels.count - 2) } else { dismiss() }
            return true
        case 53: dismiss(); return true  // esc
        case 36, 76:  // return, enter
            if let i = level.content.highlighted, let item = level.content.item(i) {
                if item.hasSubmenu {
                    openSubmenu(of: item, row: level.content.screenRect(ofRow: i), from: level)
                    levels.last?.content.move(1)
                } else if item.isEnabled {
                    perform(item)
                }
            }
            return true
        default:
            // a key equivalent of a row (⌘C…) runs it, as in an open menu
            if let item = level.menu.items.first(where: { $0.isEnabled && !$0.keyEquivalent.isEmpty && $0.keyEquivalent == e.charactersIgnoringModifiers?.lowercased()
                && $0.keyEquivalentModifierMask == e.modifierFlags.intersection([.command, .shift, .option, .control]) })
            {
                perform(item)
                return true
            }
            return false
        }
    }
}

// MARK: - one panel

@MainActor
private final class MenuLevel {
    let menu: NSMenu
    let depth: Int
    let panel: MenuPanel
    let content: MenuContentView
    private let body = NSView()

    init(menu: NSMenu, depth: Int, owner: PulseMenu) {
        self.menu = menu
        self.depth = depth
        content = MenuContentView(menu: menu)
        let size = content.fittingSize
        panel = MenuPanel(contentRect: NSRect(origin: .zero, size: size))
        content.level = self
        content.owner = owner

        // the glass, the rows over it, both in `body`, which grows and fades on open
        let base = NSView(frame: NSRect(origin: .zero, size: size))
        base.wantsLayer = true
        panel.contentView = base
        body.frame = base.bounds
        body.wantsLayer = true
        base.addSubview(body)
        let glass = NSVisualEffectView(frame: body.bounds)
        glass.material = .menu
        glass.blendingMode = .behindWindow
        glass.state = .active
        glass.wantsLayer = true
        glass.layer?.cornerRadius = 12
        glass.layer?.masksToBounds = true
        glass.layer?.borderWidth = 0.5
        glass.layer?.borderColor = NSColor.white.withAlphaComponent(0.12).cgColor
        body.addSubview(glass)
        content.frame = body.bounds
        body.addSubview(content)
        body.shadow = {
            let s = NSShadow()
            s.shadowBlurRadius = 16
            s.shadowOffset = NSSize(width: 0, height: -6)
            s.shadowColor = NSColor.black.withAlphaComponent(0.35)
            return s
        }()
        _ = owner
    }

    /// Places the panel with its top-left at `point` (screen), kept on the screen: flipped left / up when it would leave it.
    /// `row`: the row a submenu opens from (it flips to the row's left side).
    func present(at point: NSPoint, from row: NSRect?) {
        let size = panel.frame.size
        let screen = NSScreen.screens.first { NSMouseInRect(point, $0.frame, false) } ?? NSScreen.main
        let area = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 4000, height: 4000)
        var x = point.x
        var top = point.y
        var fromRight = false
        var fromBottom = false
        if x + size.width > area.maxX {
            x = (row.map { $0.minX + 4 } ?? point.x) - size.width
            fromRight = true
        }
        if top - size.height < area.minY {
            if row == nil {
                top = point.y + size.height
                fromBottom = true
            } else {
                top = area.minY + size.height
            }
        }
        x = max(area.minX, x)
        top = min(area.maxY, top)
        panel.setFrame(NSRect(x: x, y: top - size.height, width: size.width, height: size.height), display: false)
        panel.alphaValue = 0
        // (never key: the window it opened over keeps its focus look, as with a menu; keys come through PulseMenu's monitor)
        panel.orderFrontRegardless()

        // grow out of the corner it opened from, on a spring, while fading in
        let layer = body.layer!
        let anchor = CGPoint(x: fromRight ? 1 : 0, y: fromBottom ? 0 : 1)
        layer.anchorPoint = anchor
        layer.position = CGPoint(x: anchor.x * size.width, y: anchor.y * size.height)
        let grow = CASpringAnimation(keyPath: "transform.scale")
        grow.fromValue = depth == 0 ? 0.92 : 0.96
        grow.toValue = 1
        grow.mass = 1
        grow.stiffness = 420
        grow.damping = 30
        grow.initialVelocity = 0
        grow.duration = grow.settlingDuration
        layer.add(grow, forKey: "pulse.menu.grow")
        if depth > 0 {
            // a submenu also slides out from its row's side
            let slide = CABasicAnimation(keyPath: "transform.translation.x")
            slide.fromValue = fromRight ? 8 : -8
            slide.toValue = 0
            slide.duration = 0.22
            slide.timingFunction = Motion.ease
            layer.add(slide, forKey: "pulse.menu.slide")
        }
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.16
            ctx.timingFunction = Motion.ease
            panel.animator().alphaValue = 1
        }
        content.unfold()
    }

    func close(animated: Bool) {
        let panel = self.panel
        guard animated else {
            panel.orderOut(nil)
            return
        }
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.12
            ctx.timingFunction = Motion.ease
            panel.animator().alphaValue = 0
        }, completionHandler: { MainActor.assumeIsolated { panel.orderOut(nil) } })
    }
}

/// A borderless panel that takes keys without taking the app's main window away.
private final class MenuPanel: NSPanel {
    init(contentRect: NSRect) {
        super.init(contentRect: contentRect, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        isFloatingPanel = true
        level = .popUpMenu
        backgroundColor = .clear
        isOpaque = false
        hasShadow = false
        hidesOnDeactivate = true
        isReleasedWhenClosed = false
        animationBehavior = .none
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

// MARK: - the rows

@MainActor
private final class MenuContentView: FlippedView {
    let source: NSMenu
    weak var level: MenuLevel?
    weak var owner: PulseMenu?
    private(set) var highlighted: Int?
    private var rows: [NSRect] = []
    private var hoverTimer: Timer?
    private var tracking: NSTrackingArea?

    private static let pad: CGFloat = 6
    private static let rowH: CGFloat = 28
    private static let sepH: CGFloat = 9

    init(menu: NSMenu) {
        source = menu
        super.init(frame: .zero)
        wantsLayer = true
        var y = Self.pad
        var width: CGFloat = 220
        for item in source.items {
            if let v = item.view {
                // a row of its own (the quick buttons): it sits in the panel as it would in the menu
                v.removeFromSuperview()
                v.frame.origin = NSPoint(x: Self.pad - 6, y: y)
                addSubview(v)
                rows.append(NSRect(x: 0, y: y, width: 0, height: v.frame.height))
                width = max(width, v.frame.width + 2 * Self.pad - 12)
                y += v.frame.height
            } else if item.isSeparatorItem {
                rows.append(NSRect(x: 0, y: y, width: 0, height: Self.sepH))
                y += Self.sepH
            } else if item.isHidden {
                rows.append(NSRect(x: 0, y: y, width: 0, height: 0))
            } else {
                rows.append(NSRect(x: 0, y: y, width: 0, height: Self.rowH))
                let key = Self.keyText(item)
                let w = 12 + 16 + 10 + Draw.textWidth(item.title, font: Metrics.textSm) + 24 + (key.isEmpty ? 0 : Draw.textWidth(key, font: Metrics.textXs) + 8) + 12 + 16
                width = max(width, min(w, 420))
                y += Self.rowH
            }
        }
        width = ceil(width)
        rows = rows.map { NSRect(x: Self.pad, y: $0.minY, width: width - 2 * Self.pad, height: $0.height) }
        frame = NSRect(x: 0, y: 0, width: width, height: y + Self.pad)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override var fittingSize: NSSize { frame.size }
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    func item(_ i: Int) -> NSMenuItem? { source.items.indices.contains(i) ? source.items[i] : nil }

    private func selectable(_ i: Int) -> Bool {
        guard let it = item(i) else { return false }
        return !it.isSeparatorItem && it.view == nil && !it.isHidden && (it.isEnabled || it.hasSubmenu)
    }

    /// The rows come in one after another (14 ms apart, the first ten): a fade with a few pixels of drop.
    func unfold() {
        guard Motion.on, let host = layer else { return }
        // the rows are drawn into this one view: a gradient mask sweeping down shows them one after another
        let mask = CAGradientLayer()
        mask.frame = host.bounds
        mask.colors = [NSColor.black.cgColor, NSColor.black.cgColor, NSColor.clear.cgColor]
        // flipped view: y grows downward, so the sweep starts at the top
        mask.startPoint = CGPoint(x: 0.5, y: 0)
        mask.endPoint = CGPoint(x: 0.5, y: 1)
        mask.locations = [0, 1, 1.15]
        host.mask = mask
        let sweep = CABasicAnimation(keyPath: "locations")
        sweep.fromValue = [0, 0, 0.15]
        sweep.toValue = [0, 1, 1.15]
        sweep.duration = 0.16 + Double(min(rows.count, 10)) * 0.014
        sweep.timingFunction = Motion.ease
        sweep.delegate = MaskRemover(host)
        mask.add(sweep, forKey: "pulse.menu.unfold")
        let drop = CABasicAnimation(keyPath: "transform.translation.y")
        drop.fromValue = -4
        drop.toValue = 0
        drop.duration = 0.2
        drop.timingFunction = Motion.ease
        host.add(drop, forKey: "pulse.menu.drop")
    }

    func move(_ step: Int) {
        let n = source.items.count
        guard n > 0 else { return }
        var i = highlighted ?? (step > 0 ? -1 : n)
        for _ in 0..<n {
            i = (i + step + n) % n
            if selectable(i) { break }
        }
        guard selectable(i) else { return }
        highlighted = i
        needsDisplay = true
    }

    func screenRect(ofRow i: Int) -> NSRect {
        guard let window, rows.indices.contains(i) else { return .zero }
        return window.convertToScreen(convert(rows[i], to: nil))
    }

    // MARK: pointer

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let t = NSTrackingArea(rect: bounds, options: [.mouseMoved, .mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
        addTrackingArea(t)
        tracking = t
    }

    private func row(at p: NSPoint) -> Int? { rows.firstIndex { $0.height > 0 && $0.contains(p) } }

    override func mouseMoved(with event: NSEvent) {
        let i = row(at: convert(event.locationInWindow, from: nil))
        let next = i.flatMap { selectable($0) ? $0 : nil }
        guard next != highlighted else { return }
        highlighted = next
        needsDisplay = true
        hoverTimer?.invalidate()
        guard let level, let owner else { return }
        if let i = next, let item = item(i), item.hasSubmenu {
            // a submenu opens after a moment on its row, as in a menu
            hoverTimer = Timer.scheduledTimer(withTimeInterval: 0.12, repeats: false) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self, self.highlighted == i else { return }
                    owner.openSubmenu(of: item, row: self.screenRect(ofRow: i), from: level)
                }
            }
        } else {
            hoverTimer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: false) { _ in
                MainActor.assumeIsolated { owner.closeLevels(after: level.depth) }
            }
        }
    }

    override func mouseExited(with event: NSEvent) {
        // the highlight stays on a row whose submenu is open
        if let i = highlighted, item(i)?.hasSubmenu == true { return }
        highlighted = nil
        needsDisplay = true
    }

    override func mouseUp(with event: NSEvent) {
        guard let i = row(at: convert(event.locationInWindow, from: nil)), selectable(i), let item = item(i), let level, let owner else { return }
        if item.hasSubmenu {
            owner.openSubmenu(of: item, row: screenRect(ofRow: i), from: level)
        } else {
            owner.perform(item)
        }
    }

    override func rightMouseUp(with event: NSEvent) { mouseUp(with: event) }

    // MARK: drawing

    override func draw(_ dirtyRect: NSRect) {
        let p = Palette.of(self)
        for (i, item) in source.items.enumerated() where rows.indices.contains(i) {
            let r = rows[i]
            guard r.height > 0, item.view == nil else { continue }
            if item.isSeparatorItem {
                p.divider.setFill()
                NSRect(x: r.minX + 6, y: r.midY, width: r.width - 12, height: 1).fill()
                continue
            }
            let on = highlighted == i
            if on {
                // the Pulse highlight: a soft capsule, not the system's accent bar
                Draw.roundedRect(r, radius: 7, fill: p.dark ? NSColor.white.withAlphaComponent(0.10) : NSColor.black.withAlphaComponent(0.07))
            }
            let enabled = item.isEnabled || item.hasSubmenu
            let color = enabled ? p.text : p.textTertiary
            var x = r.minX + 8
            if item.state == .on {
                Draw.icon("check", in: NSRect(x: x, y: r.midY - 8, width: 16, height: 16), size: 14, color: color)
            } else if let image = item.image {
                Self.tinted(image, color).draw(in: NSRect(x: x, y: r.midY - 8, width: 16, height: 16), from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
            }
            x += 16 + 10
            let key = Self.keyText(item)
            let right = r.maxX - 10 - (item.hasSubmenu ? 16 : 0)
            let keyW = key.isEmpty ? 0 : Draw.textWidth(key, font: Metrics.textXs) + 8
            Draw.text(item.title, in: NSRect(x: x, y: r.minY, width: right - keyW - x, height: r.height), font: Metrics.textSm, color: color)
            if !key.isEmpty {
                Draw.text(key, in: NSRect(x: right - keyW, y: r.minY, width: keyW, height: r.height), font: Metrics.textXs, color: p.textSecondary, align: .right)
            }
            if item.hasSubmenu {
                Draw.icon("chevron-right", in: NSRect(x: r.maxX - 22, y: r.midY - 7, width: 14, height: 14), size: 12, color: p.textSecondary)
            }
        }
    }

    private static var tintCache: [ObjectIdentifier: (NSColor, NSImage)] = [:]

    private static func tinted(_ image: NSImage, _ color: NSColor) -> NSImage {
        guard image.isTemplate else { return image }
        if let (c, img) = tintCache[ObjectIdentifier(image)], c == color { return img }
        let out = NSImage(size: NSSize(width: 16, height: 16), flipped: false) { rect in
            image.draw(in: rect)
            color.set()
            rect.fill(using: .sourceAtop)
            return true
        }
        tintCache[ObjectIdentifier(image)] = (color, out)
        return out
    }

    /// ⌘C, ⇧⌘N, F2… as the menu writes a row's key.
    static func keyText(_ item: NSMenuItem) -> String {
        guard !item.keyEquivalent.isEmpty else { return "" }
        let m = item.keyEquivalentModifierMask
        var s = ""
        if m.contains(.control) { s += "⌃" }
        if m.contains(.option) { s += "⌥" }
        if m.contains(.shift) { s += "⇧" }
        if m.contains(.command) { s += "⌘" }
        let k = item.keyEquivalent
        switch k {
        case MenuBuilder.up: s += "↑"
        case MenuBuilder.down: s += "↓"
        case MenuBuilder.backspace: s += "⌫"
        case MenuBuilder.f2: s += "F2"
        case "\r": s += "↩"
        case "\u{1b}": s += "⎋"
        case " ": s += "Space"
        default: s += k.uppercased()
        }
        return s
    }
}

/// Takes the unfolding mask off when its sweep is done (the rows are then drawn as they are).
private final class MaskRemover: NSObject, CAAnimationDelegate {
    private weak var layer: CALayer?
    init(_ layer: CALayer) { self.layer = layer }
    func animationDidStop(_ anim: CAAnimation, finished flag: Bool) {
        DispatchQueue.main.async { [layer] in layer?.mask = nil }
    }
}
