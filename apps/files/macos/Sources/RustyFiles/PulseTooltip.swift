import AppKit

/// Pulse's tooltip on the Mac (the Windows app's gpui tooltips): a small glass label under a button, its name and, dimmed
/// beside it, its shortcut. It comes after a short rest on the button (at once while another one was just showing), fades in
/// with a few points of rise, and goes on a click or when the pointer leaves.
///
/// (AppKit's own `toolTip` does not work on these buttons: their hover tracking replaces the view's tracking areas, the
/// tooltip's among them.)
@MainActor
enum PulseTooltip {
    private static var panel: TipPanel?
    private static var pending: DispatchWorkItem?
    private static weak var owner: NSView?
    /// When the last tooltip went: within a moment the next one shows without waiting.
    private static var lastHidden = Date.distantPast

    static func schedule(for view: NSView, text: String, shortcut: String?) {
        pending?.cancel()
        let warm = Date().timeIntervalSince(lastHidden) < 0.6 || panel?.isVisible == true
        let work = DispatchWorkItem { MainActor.assumeIsolated { show(for: view, text: text, shortcut: shortcut) } }
        pending = work
        DispatchQueue.main.asyncAfter(deadline: .now() + (warm ? 0.05 : 0.45), execute: work)
    }

    static func hide(for view: NSView? = nil) {
        if let view, let owner, owner !== view { return }
        pending?.cancel()
        pending = nil
        guard let p = panel, p.isVisible else { return }
        lastHidden = Date()
        owner = nil
        if Motion.on {
            NSAnimationContext.runAnimationGroup({ ctx in
                ctx.duration = 0.08
                p.animator().alphaValue = 0
            }, completionHandler: { MainActor.assumeIsolated { if p.alphaValue == 0 { p.orderOut(nil) } } })
        } else {
            p.orderOut(nil)
        }
    }

    private static func show(for view: NSView, text: String, shortcut: String?) {
        guard let window = view.window, window.isVisible, view.superview != nil else { return }
        let p = panel ?? TipPanel()
        panel = p
        owner = view
        p.set(text: text, shortcut: shortcut, dark: Palette.of(view).dark)
        let size = p.frame.size
        let button = window.convertToScreen(view.convert(view.bounds, to: nil))
        let area = (window.screen ?? NSScreen.main)?.visibleFrame ?? .infinite
        var x = button.midX - size.width / 2
        x = min(max(x, area.minX + 4), area.maxX - size.width - 4)
        // under the button; above it when there is no room below
        var y = button.minY - 6 - size.height
        if y < area.minY { y = button.maxY + 6 }
        let final = NSRect(x: x, y: y, width: size.width, height: size.height)
        if Motion.on && !p.isVisible {
            p.setFrame(final.offsetBy(dx: 0, dy: 3), display: false)
            p.alphaValue = 0
            p.orderFront(nil)
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.14
                ctx.timingFunction = Motion.ease
                p.animator().alphaValue = 1
                p.animator().setFrame(final, display: true)
            }
        } else {
            p.setFrame(final, display: true)
            p.alphaValue = 1
            p.orderFront(nil)
        }
    }
}

private final class TipPanel: NSPanel {
    private let label = NSTextField(labelWithString: "")
    private let glass = NSVisualEffectView()

    init() {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 10, height: 26), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        level = .popUpMenu
        backgroundColor = .clear
        isOpaque = false
        hasShadow = true
        ignoresMouseEvents = true
        hidesOnDeactivate = true
        isReleasedWhenClosed = false
        animationBehavior = .none
        glass.material = .toolTip
        glass.blendingMode = .behindWindow
        glass.state = .active
        glass.wantsLayer = true
        glass.layer?.cornerRadius = 7
        glass.layer?.masksToBounds = true
        glass.layer?.borderWidth = 0.5
        contentView = glass
        glass.addSubview(label)
    }

    func set(text: String, shortcut: String?, dark: Bool) {
        let s = NSMutableAttributedString(string: text, attributes: [.font: NSFont.systemFont(ofSize: 12, weight: .medium), .foregroundColor: NSColor.labelColor])
        if let shortcut, !shortcut.isEmpty {
            s.append(NSAttributedString(string: "   " + shortcut, attributes: [.font: NSFont.systemFont(ofSize: 12), .foregroundColor: NSColor.secondaryLabelColor]))
        }
        label.attributedStringValue = s
        label.sizeToFit()
        let w = ceil(label.frame.width) + 20
        setContentSize(NSSize(width: w, height: 26))
        glass.frame = NSRect(x: 0, y: 0, width: w, height: 26)
        label.frame.origin = NSPoint(x: 10, y: (26 - label.frame.height) / 2)
        glass.layer?.borderColor = (dark ? NSColor.white.withAlphaComponent(0.12) : NSColor.black.withAlphaComponent(0.10)).cgColor
        appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
    }
}
