import AppKit
import WebKit

/// Pulse Explorer's browser tabs on the Mac (crates/rf-app/src/web_view.rs on Windows): a tab whose address is a web page
/// (http/https, about:blank) or an .html file shows the page in WebKit over the content card.
///
/// One page per tab, made when the tab first shows and kept while it lives: switching tabs hides it, closing the tab drops
/// it. The page keeps its own history; the tab's back/forward reach past it (to the folder the tab came from).
enum WebAddress {
    /// A blank page with the address field ready (the "New browser tab" command).
    static let blank = URL(string: "about:blank")!

    static func isWeb(_ url: URL) -> Bool {
        if url == blank { return true }
        if let s = url.scheme?.lowercased(), s == "http" || s == "https" { return true }
        return isHTMLFile(url)
    }

    static func isHTMLFile(_ url: URL) -> Bool {
        guard url.isFileURL, ["html", "htm", "xhtml"].contains(url.pathExtension.lowercased()) else { return false }
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir) && !isDir.boolValue
    }

    /// What the address field's text means as a web address: a URL with its scheme, or something that looks like a
    /// host ("example.com", "localhost:3000"), which gets https:// (http:// for localhost). Nil when it is not one.
    static func parse(_ text: String) -> URL? {
        let t = text.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty, !t.contains(" ") else { return nil }
        let lower = t.lowercased()
        if lower.hasPrefix("http://") || lower.hasPrefix("https://") || lower == "about:blank" { return URL(string: t) }
        // paths, aliases and commands stay the file manager's
        if t.hasPrefix("/") || t.hasPrefix("~") || t.hasPrefix(".") || t.hasPrefix("@") { return nil }
        let host = t.split(separator: "/", maxSplits: 1).first.map(String.init) ?? t
        let name = host.split(separator: ":").first.map(String.init) ?? host
        if name == "localhost" || name == "127.0.0.1" { return URL(string: "http://" + t) }
        // a dot inside the host, and a last part of letters ("example.com", not "notes.txt" next to a folder: checked first)
        let parts = name.split(separator: ".")
        guard parts.count >= 2, let tld = parts.last, tld.count >= 2, tld.allSatisfy(\.isLetter) else { return nil }
        return URL(string: "https://" + t)
    }
}

/// One tab's page: WebKit in a rounded container laid over the content card.
@MainActor
final class WebPage: NSObject, WKNavigationDelegate, WKUIDelegate {
    let container = NSView()
    let view: WKWebView
    /// The page's address or title changed; a link asked for a new tab.
    var onChange: (() -> Void)?
    var onNewTab: ((URL) -> Void)?
    private var observers: [NSKeyValueObservation] = []

    override init() {
        let config = WKWebViewConfiguration()
        config.preferences.isElementFullscreenEnabled = true
        view = WKWebView(frame: .zero, configuration: config)
        super.init()
        view.navigationDelegate = self
        view.uiDelegate = self
        view.allowsBackForwardNavigationGestures = true
        view.allowsMagnification = true
        view.autoresizingMask = [.width, .height]
        container.wantsLayer = true
        container.layer?.cornerRadius = Metrics.radius
        container.layer?.masksToBounds = true
        container.addSubview(view)
        observers = [
            view.observe(\.url, options: [.new]) { [weak self] _, _ in MainActor.assumeIsolated { self?.onChange?() } },
            view.observe(\.title, options: [.new]) { [weak self] _, _ in MainActor.assumeIsolated { self?.onChange?() } },
            view.observe(\.canGoBack, options: [.new]) { [weak self] _, _ in MainActor.assumeIsolated { self?.onChange?() } },
            view.observe(\.canGoForward, options: [.new]) { [weak self] _, _ in MainActor.assumeIsolated { self?.onChange?() } },
        ]
    }

    func load(_ url: URL) {
        if url.isFileURL {
            // an .html file may load what sits next to it (its images, styles, scripts)
            view.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        } else {
            view.load(URLRequest(url: url))
        }
    }

    /// The address the page is at (it moves with links and redirects).
    var url: URL? { view.url }
    var title: String? { view.title.flatMap { $0.isEmpty ? nil : $0 } }

    // links that ask for a new window open as a new tab
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { onNewTab?(url) }
        return nil
    }

    // ⌘-click, or a link the page marks for a new window
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        if navigationAction.navigationType == .linkActivated, navigationAction.modifierFlags.contains(.command), let url = navigationAction.request.url {
            onNewTab?(url)
            return decisionHandler(.cancel)
        }
        // mailto:, facetime: and the like belong to the apps that handle them
        if let url = navigationAction.request.url, let s = url.scheme?.lowercased(), !["http", "https", "about", "file", "data", "blob"].contains(s) {
            NSWorkspace.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping @MainActor @Sendable ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.begin { completionHandler($0 == .OK ? panel.urls : nil) }
    }
}
