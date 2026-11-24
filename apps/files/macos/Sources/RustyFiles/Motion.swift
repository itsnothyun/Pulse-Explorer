import AppKit
import QuartzCore

/// Pulse's motion on the Mac: the sidebar and panes slide, pages cross-fade, panels fade and grow in. Everything follows
/// Settings › Appearance › Animations and the system's Reduce motion, and nothing waits for an animation to finish.
@MainActor
enum Motion {
    static var on: Bool { AppSettings.animations && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

    /// The ease Pulse uses everywhere (ease-out quint, as the Windows app's `ease_out_quint`).
    static let ease = CAMediaTimingFunction(controlPoints: 0.22, 1, 0.36, 1)

    /// Runs `changes` animated (frames set inside slide there), or at once when motion is off.
    static func animate(_ duration: TimeInterval = 0.24, _ changes: () -> Void, completion: (() -> Void)? = nil) {
        guard on else {
            changes()
            completion?()
            return
        }
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = duration
            ctx.timingFunction = ease
            ctx.allowsImplicitAnimation = true
            changes()
        }, completionHandler: { MainActor.assumeIsolated { completion?() } })
    }

    /// The view's next contents cross-fade from what it shows now (a page or a tab changing).
    static func crossFade(_ view: NSView, duration: TimeInterval = 0.16) {
        guard on else { return }
        view.wantsLayer = true
        let t = CATransition()
        t.type = .fade
        t.duration = duration
        t.timingFunction = ease
        view.layer?.add(t, forKey: "pulse.crossfade")
    }

    /// Fades a view in (a pane or a page coming into sight).
    static func fadeIn(_ view: NSView, duration: TimeInterval = 0.2) {
        guard on else { view.alphaValue = 1; return }
        view.alphaValue = 0
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = duration
            ctx.timingFunction = ease
            view.animator().alphaValue = 1
        }
    }

    /// Shows a window or panel fading in (a toast appearing). Titled windows get AppKit's own grow-in instead
    /// (`animationBehavior`, set where they are made).
    static func present(_ window: NSWindow, duration: TimeInterval = 0.2) {
        guard on else {
            window.alphaValue = 1
            return
        }
        window.alphaValue = 0
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = duration
            ctx.timingFunction = ease
            window.animator().alphaValue = 1
        }
    }
}
