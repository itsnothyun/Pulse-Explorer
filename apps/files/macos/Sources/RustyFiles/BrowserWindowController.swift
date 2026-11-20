import AppKit

/// One tab: its folder, its own back/forward history, and what to restore when it comes back.
@MainActor
final class BrowserTab {
    var url: URL
    var back: [URL] = []
    var forward: [URL] = []
    var folder: Folder?
    var error: String?
    /// Set while the tab shows a folder inside an archive.
    var archive: ArchiveView?
    var selection: [String] = []
    var scrollY: CGFloat?
    var loadID = 0

    init(url: URL) { self.url = url.isFileURL ? url.standardizedFileURL : url }

    /// Pulse Explorer's browser tabs (WebTabs.swift): a web page or an .html file, shown by `page`.
    var isWeb: Bool { WebAddress.isWeb(url) }
    var page: WebPage?

    /// The Settings page is a place a tab goes to, like a folder (Location::Settings on Windows).
    static let settingsURL = URL(string: "rustyfiles:settings")!
    /// The Home page (Location::Home on Windows): quick access, drives, recent items.
    static let homeURL = URL(string: "rustyfiles:home")!
    var isSettings: Bool { url == Self.settingsURL }
    var isHome: Bool { url == Self.homeURL }
    /// A page of the app's own rather than a folder.
    var isPage: Bool { isSettings || isHome || isWeb }
    /// A tag's results (rustyfiles:tag/<name>): the files that have it, from anywhere.
    var tagName: String? { TagStore.name(of: url) }
    /// A search's results (rustyfiles:search?in=…&q=…, SearchPlace).
    var search: (dir: URL, query: String)? { SearchPlace.parse(url) }

    var info: TabInfo {
        if isSettings { return TabInfo(title: String(localized: "Settings"), icon: "settings") }
        if isHome { return TabInfo(title: String(localized: "Home"), icon: "house") }
        if isWeb {
            let title = page?.title ?? (url == WebAddress.blank ? String(localized: "New browser tab") : (url.isFileURL ? url.lastPathComponent : url.host ?? url.absoluteString))
            return TabInfo(title: title, icon: "globe")
        }
        if let tag = tagName { return TabInfo(title: tag, icon: "tag") }
        if let s = search { return TabInfo(title: "“\(s.query)”", icon: "search") }
        let fm = FileManager.default
        let home = fm.homeDirectoryForCurrentUser.standardizedFileURL
        if url == home { return TabInfo(title: fm.displayName(atPath: url.path), icon: "house") }
        if url.lastPathComponent == ".Trash" { return TabInfo(title: String(localized: "Trash"), icon: "trash") }
        let isVolume = (try? url.resourceValues(forKeys: [.isVolumeKey]).isVolume) ?? false
        if isVolume || url.path == "/" {
            let name = (try? url.resourceValues(forKeys: [.volumeLocalizedNameKey]).volumeLocalizedName) ?? url.lastPathComponent
            return TabInfo(title: name, icon: "hard-drive")
        }
        return TabInfo(title: fm.displayName(atPath: url.path), icon: "folder")
    }
}

/// Everything in the window, on the glass: the palette's `window_bg` wash, then the bars,
/// the sidebar and the card.
@MainActor
final class RootView: FlippedView {
    var onLayout: (() -> Void)?

    override func layout() {
        super.layout()
        onLayout?()
    }

    override func draw(_ dirtyRect: NSRect) {
        Palette.of(self).windowBg.setFill()
        dirtyRect.fill()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
        subviews.forEach { $0.needsDisplay = true }
    }
}

/// A browser window laid out as rustyfiles on Windows: title bar with tabs, navigation row,
/// sidebar, and the content card.
@MainActor
final class BrowserWindowController: NSWindowController, NSWindowDelegate, NSMenuItemValidation {
    private let root = RootView()
    private var frameView: FlippedView?
    private var backdrop: NSView?
    private let titleBar = TitleBarView()
    private let navBar = NavBarView()
    private let sidebar = SidebarView()
    private let handle = SidebarResizeHandle()
    let list = FileListController()
    private var tabs: [BrowserTab] = []
    private var active = 0
    private var tab: BrowserTab { tabs[active] }
    private var watcher: DirectoryWatcher?

    private var sidebarWidth: CGFloat = {
        let w = UserDefaults.standard.double(forKey: "sidebarWidth")
        return w > 0 ? w : Metrics.sidebarWidth
    }()
    private var sidebarShown = !UserDefaults.standard.bool(forKey: "sidebarHidden")

    var onClose: ((BrowserWindowController) -> Void)?

    var current: URL { tab.url }

    init(url: URL, selecting name: String? = nil) {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 800),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.tabbingMode = .disallowed
        // An empty compact toolbar makes the title bar 40 px tall with the window buttons
        // centred in it, where the Windows app has its title bar. (Moving AppKit's title bar
        // views by hand instead stops the window from redrawing.)
        window.toolbar = NSToolbar(identifier: "rustyfiles.titlebar")
        window.toolbarStyle = .unifiedCompact
        window.minSize = NSSize(width: 720, height: 420)
        super.init(window: window)

        let frame = FlippedView()
        frameView = frame
        root.frame = frame.bounds
        root.autoresizingMask = [.width, .height]
        frame.addSubview(root)
        window.contentView = frame
        applyMaterial()
        [sidebar, handle, list.card, navBar, titleBar].forEach(root.addSubview)
        sidebar.isHidden = !sidebarShown
        root.onLayout = { [weak self] in self?.layoutRoot() }

        window.center()
        window.setFrameAutosaveName("rustyfiles.window")
        window.delegate = self
        wire()
        NotificationCenter.default.addObserver(self, selector: #selector(settingsChanged(_:)), name: .rfSettingsChanged, object: nil)

        tabs = [BrowserTab(url: url)]
        tab.selection = name.map { [$0] } ?? []
        load(tab)
        refreshTabs()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override func showWindow(_ sender: Any?) {
        super.showWindow(sender)
        list.focus()
    }

    // MARK: layout

    private func layoutRoot() {
        let b = root.bounds
        titleBar.frame = NSRect(x: 0, y: 0, width: b.width, height: Metrics.titleBarHeight)
        navBar.frame = NSRect(x: 0, y: Metrics.titleBarHeight, width: b.width, height: Metrics.navRowHeight)
        let top = Metrics.titleBarHeight + Metrics.navRowHeight
        let sw = sidebarShown ? sidebarWidth : 0
        // while it slides away the sidebar stays in the view, going narrower and fading (toggleSidebar hides it after)
        if sidebarShown { sidebar.isHidden = false }
        handle.isHidden = !sidebarShown
        sidebar.alphaValue = sidebarShown ? 1 : 0
        sidebar.frame = NSRect(x: 0, y: top, width: sidebarShown ? sw : sidebarWidth, height: b.height - top)
        if !sidebarShown { sidebar.frame.origin.x = -sidebarWidth * 0.25 }
        handle.frame = NSRect(x: sw - 3, y: top, width: 6, height: b.height - top)
        // no sidebar: the card keeps the 8 px margin on the left too
        let left = sidebarShown ? sw : 8
        list.card.frame = NSRect(x: left, y: top, width: b.width - left - Metrics.cardRightMargin, height: b.height - top - Metrics.bottomSpacer)
        for t in tabs { t.page?.container.frame = list.card.frame }
    }

    func windowDidBecomeKey(_ notification: Notification) { list.updateCommands() }

    /// Edit › Undo and Redo, ⌘Z and ⇧⌘Z, work on file operations (text being edited keeps its own).
    func windowWillReturnUndoManager(_ window: NSWindow) -> UndoManager? { FileUndo.shared.manager }

    func windowWillClose(_ notification: Notification) { onClose?(self) }

    /// A setting changed: the list takes what concerns it; colours redraw everywhere (and
    /// lenses find their places again, or go, when the material changed).
    @objc private func settingsChanged(_ note: Notification) {
        let key = AppSettings.changedKey(note)
        if key == "material" || key == "theme" { applyMaterial() }
        list.apply(settingKey: key)
        func redraw(_ v: NSView) {
            v.needsDisplay = true
            v.needsLayout = true
            v.subviews.forEach(redraw)
        }
        redraw(root)
    }

    /// What the window is made of (Settings › Appearance › Window material).
    ///
    /// - Liquid Glass: one sheet of glass for the whole window, as HyperGlass is one sheet on
    ///   Windows; frosted so text reads over anything behind it, reaching the window's edge,
    ///   where it bends the light. No window shadow: with it macOS draws a black 1 px outline
    ///   round the window, a dark line round the glass.
    /// - Translucent: macOS's translucent window material, the desktop's tone showing.
    /// - Solid: an opaque window, as Finder; the palette paints it.
    private func applyMaterial() {
        guard let window, let frameView else { return }
        backdrop?.removeFromSuperview()
        backdrop = nil
        // Black (OLED) is opaque whatever the material
        let material: AppSettings.Material = AppSettings.theme == .black ? .solid : AppSettings.material
        let view: NSView?
        switch material {
        case .glass:
            let g = NSGlassEffectView()
            g.style = .regular
            g.cornerRadius = Metrics.windowRadius
            view = g
        case .finder:
            let v = NSVisualEffectView()
            v.material = .sidebar
            v.blendingMode = .behindWindow
            v.state = .followsWindowActiveState
            view = v
        case .solid:
            view = nil
        }
        let glass = material == .glass
        window.isOpaque = material == .solid
        window.backgroundColor = material == .solid ? .windowBackgroundColor : .clear
        window.hasShadow = !glass
        if let view {
            view.frame = frameView.bounds
            view.autoresizingMask = [.width, .height]
            frameView.addSubview(view, positioned: .below, relativeTo: nil)
            backdrop = view
        }
        window.invalidateShadow()
    }

    // MARK: wiring

    private func wire() {
        navBar.sidebarToggle.action = { [weak self] _ in self?.toggleSidebar(nil) }
        titleBar.plus.action = { [weak self] _ in self?.newTab(nil) }
        // the "+" button's right click: a folder tab or a browser tab
        titleBar.plus.menuProvider = { [weak self] in
            let b = MenuBuilder()
            b.add(String(localized: "New tab"), "plus", key: "t") { self?.newTab(nil) }
            b.add(String(localized: "New browser tab"), "globe", key: "t", mods: [.command, .option]) { self?.newBrowserTab(nil) }
            return b.done()
        }
        list.onOpenWeb = { [weak self] url in self?.openTab(url, activate: true) }
        titleBar.strip.onSelect = { [weak self] i in self?.activate(i) }
        titleBar.strip.onClose = { [weak self] i in self?.closeTab(at: i) }

        navBar.back.action = { [weak self] _ in self?.goBack(nil) }
        navBar.forward.action = { [weak self] _ in self?.goForward(nil) }
        navBar.up.action = { [weak self] _ in self?.goUp(nil) }
        navBar.refresh.action = { [weak self] _ in self?.refresh(nil) }
        navBar.statusCenter.action = { [weak self] _ in self?.toggleStatusCenter() }
        NotificationCenter.default.addObserver(self, selector: #selector(statusChanged), name: .rfStatusCenterChanged, object: nil)
        let omni = navBar.omnibar
        omni.breadcrumb.onNavigate = { [weak self] url in self?.navigate(to: url) }
        omni.breadcrumb.onHome = { [weak self] in self?.goHome(nil) }
        omni.onSubmitPath = { [weak self] text in self?.submitPath(text) }
        omni.onSearch = { [weak self] text in self?.searchSubfolders(text) }
        omni.onFilter = { [weak self] text in
            self?.list.filter = text
            self?.list.commandBar.filter.isOn = !text.isEmpty
        }

        sidebar.onSelect = { [weak self] item in
            guard let self else { return }
            if let url = item.url { self.navigate(to: url) }
        }
        sidebar.onEject = { [weak self] url in self?.eject(url) }
        handle.currentWidth = { [weak self] in self?.sidebarWidth ?? Metrics.sidebarWidth }
        handle.onDrag = { [weak self] w in
            guard let self else { return }
            self.sidebarWidth = w
            UserDefaults.standard.set(Double(w), forKey: "sidebarWidth")
            self.root.needsLayout = true
        }

        list.onOpenFolder = { [weak self] url in self?.navigate(to: url) }
        list.onOpenInNewTab = { [weak self] url in self?.openTab(url) }
        list.onOpenInNewWindow = { url in AppDelegate.shared.openWindow(at: url) }
        list.onRefresh = { [weak self] in self?.refresh(nil) }
        list.onGoUp = { [weak self] in self?.goUp(nil) }
        sidebar.onOpenInNewTab = { [weak self] url in self?.openTab(url) }
        sidebar.onOpenInNewWindow = { url in AppDelegate.shared.openWindow(at: url) }
        titleBar.strip.menuFor = { [weak self] i in self?.tabMenu(i) }
        list.onOpenDiskImage = { [weak self] url in self?.openDiskImage(url) }
        list.onBack = { [weak self] in self?.goBack(nil) }
        list.onChange = { [weak self] in self?.updateChrome() }
        list.onError = { [weak self] text in self?.showError(text) }
        list.onReload = { [weak self] names, rename in self?.reload(selecting: names, rename: rename) }
        list.commandBar.filter.action = { [weak self] _ in self?.focusSearch(nil) }
    }

    // MARK: tabs

    private func refreshTabs() {
        defer { AppDelegate.shared.saveSession() }
        titleBar.strip.tabs = tabs.map(\.info)
        titleBar.strip.active = active
        titleBar.needsLayout = true
        window?.title = tab.info.title
    }

    private func saveTabState() {
        guard tabs.indices.contains(active), list.url == tab.url else { return }
        tab.selection = list.selectedNames
        tab.scrollY = list.scrollY
    }

    private func activate(_ i: Int) {
        guard i != active, tabs.indices.contains(i) else { return }
        saveTabState()
        active = i
        navBar.omnibar.end()
        showTab()
        refreshTabs()
    }

    /// What the card showed last (a tab, a page or a folder), so a change of it cross-fades and a refresh does not.
    private var shownKey: (ObjectIdentifier, URL)?

    private func showTab() {
        let key = (ObjectIdentifier(tab), tab.url)
        if let k = shownKey, k.0 != key.0 || k.1 != key.1 { Motion.crossFade(list.card) }
        shownKey = key
        // only the active tab's page shows; the card stays under it
        for t in tabs where t !== tab { t.page?.container.isHidden = true }
        if tab.isWeb {
            let page = webPage(for: tab)
            page.container.frame = list.card.frame
            if page.container.isHidden || page.container.alphaValue < 1 {
                page.container.isHidden = false
                Motion.fadeIn(page.container)
            }
            watch()
            updateChrome()
            window?.makeFirstResponder(page.view)
            return
        }
        if tab.isSettings {
            list.showSettings()
        } else if tab.isHome {
            list.showHome()
        } else if let folder = tab.folder {
            list.show(folder, at: tab.url, selecting: tab.selection, scrollTo: tab.scrollY, archive: tab.archive)
        } else if let error = tab.error {
            list.show(error: error, at: tab.url)
        }
        watch()
        updateChrome()
        list.focus()
    }

    @objc func newTab(_ sender: Any?) {
        saveTabState()
        // General › A new tab opens: Home, or the folder of the tab it opens from
        let here = tab.isPage ? BrowserTab.homeURL : tab.url
        let t = BrowserTab(url: AppSettings.newTabOpens == "current" ? here : BrowserTab.homeURL)
        tabs.insert(t, at: active + 1)
        active += 1
        navBar.omnibar.end()
        load(t)
        refreshTabs()
    }

    override func newWindowForTab(_ sender: Any?) { newTab(sender) }

    @objc func closeTab(_ sender: Any?) { closeTab(at: active) }

    /// Tabs closed in this window, newest last ("Reopen closed tab", ⇧⌘T).
    private var closedTabs: [URL] = []

    /// A new tab right after the active one, showing `url`.
    func openTab(_ url: URL, activate: Bool? = nil) {
        saveTabState()
        let t = BrowserTab(url: url)
        tabs.insert(t, at: active + 1)
        // General › Always switch to a newly opened tab; off: it waits behind the current one
        guard activate ?? AppSettings.switchToNewTab else {
            refreshTabs()
            return
        }
        active += 1
        navBar.omnibar.end()
        load(t)
        refreshTabs()
    }

    /// The tabs' addresses, in order (paths, or rustyfiles:home / :settings).
    var tabAddresses: [String] { tabs.map { Sessions.string($0.url) } }
    var activeTab: Int { active }

    /// Opens these addresses as the window's tabs (a saved session).
    func restore(_ addresses: [String], active a: Int) {
        let urls = addresses.compactMap(Sessions.url)
        guard !urls.isEmpty else { return }
        tabs = urls.map { BrowserTab(url: $0) }
        active = min(max(a, 0), tabs.count - 1)
        load(tab)
        refreshTabs()
    }

    @objc func reopenClosedTab(_ sender: Any?) {
        guard let url = closedTabs.popLast() else { return }
        openTab(url)
    }

    private func closeTabs(_ indices: [Int]) {
        guard !indices.isEmpty else { return }
        let keep = tabs.indices.filter { !indices.contains($0) }
        guard !keep.isEmpty else { return window?.performClose(nil) ?? () }
        saveTabState()
        let current = tabs[active]
        closedTabs += indices.map { tabs[$0].url }
        indices.forEach { dropPage(tabs[$0]) }
        tabs = keep.map { tabs[$0] }
        active = tabs.firstIndex { $0 === current } ?? min(keep.firstIndex { $0 > indices.min()! } ?? 0, tabs.count - 1)
        showTab()
        refreshTabs()
    }

    /// The tab menu (workspace.rs `tab_menu`).
    private func tabMenu(_ i: Int) -> NSMenu {
        let b = MenuBuilder()
        let n = tabs.count
        b.add(String(localized: "New tab"), "plus", key: "t") { [weak self] in self?.newTab(nil) }
        b.add(String(localized: "New browser tab"), "globe", key: "t", mods: [.command, .option]) { [weak self] in self?.newBrowserTab(nil) }
        b.add(String(localized: "Duplicate tab"), "copy") { [weak self] in
            guard let self else { return }
            self.activate(i)
            self.openTab(self.tabs[i].url)
        }
        b.add(String(localized: "Move to new window"), "app-window", enabled: n > 1) { [weak self] in
            guard let self, self.tabs.indices.contains(i) else { return }
            let url = self.tabs[i].url
            self.closeTabs([i])
            AppDelegate.shared.openWindow(at: url)
        }
        b.separator()
        b.add(String(localized: "Close other tabs"), enabled: n > 1) { [weak self] in self?.closeTabs((0..<n).filter { $0 != i }) }
        b.add(String(localized: "Close tabs to the left"), enabled: i > 0) { [weak self] in self?.closeTabs(Array(0..<i)) }
        b.add(String(localized: "Close tabs to the right"), enabled: i < n - 1) { [weak self] in self?.closeTabs(Array((i + 1)..<n)) }
        b.add(String(localized: "Close all tabs")) { [weak self] in self?.window?.performClose(nil) }
        b.add(String(localized: "Close tab"), "x", key: "w") { [weak self] in self?.closeTab(at: i) }
        b.separator()
        b.add(String(localized: "Reopen closed tab"), "rotate-ccw", key: "t", mods: [.command, .shift], enabled: !closedTabs.isEmpty) { [weak self] in
            self?.reopenClosedTab(nil)
        }
        return b.done()
    }

    private func closeTab(at i: Int) {
        guard tabs.indices.contains(i) else { return }
        if tabs.count == 1 {
            window?.performClose(nil)
            return
        }
        if i == active { saveTabState() }
        closedTabs.append(tabs[i].url)
        dropPage(tabs[i])
        tabs.remove(at: i)
        if i < active || active >= tabs.count { active = max(active - 1, 0) }
        showTab()
        refreshTabs()
    }

    @objc func selectNextTab(_ sender: Any?) { activate((active + 1) % tabs.count) }
    @objc func selectPreviousTab(_ sender: Any?) { activate((active - 1 + tabs.count) % tabs.count) }

    // MARK: navigation

    func navigate(to url: URL, selecting name: String? = nil) {
        let url = url.isFileURL ? url.standardizedFileURL : url
        guard url != tab.url else { return }
        // a page going to another page stays in its WebKit history
        if tab.isWeb, WebAddress.isWeb(url), let page = tab.page {
            tab.url = url
            page.load(url)
            navBar.omnibar.end()
            refreshTabs()
            return updateChrome()
        }
        saveTabState()
        tab.back.append(tab.url)
        tab.forward.removeAll()
        tab.url = url
        CommandPalette.noteVisit(url)
        tab.selection = name.map { [$0] } ?? []
        tab.scrollY = nil
        navBar.omnibar.end()
        load(tab)
        refreshTabs()
    }

    /// Lists the tab's folder off the main thread: a slow or hung disk never stalls the window.
    private func load(_ t: BrowserTab, keepScroll: Bool = false) {
        // a tab that left its page for a folder drops the page
        if !t.isWeb, t.page != nil { dropPage(t) }
        t.loadID += 1
        let id = t.loadID
        let url = t.url
        if t.isPage {
            if t === tab { showTab() }
            return
        }
        if t === tab, ArchivePlace.locate(url) == nil { list.prepareLayout(for: url) }
        let (column, ascending, first, hidden) = (list.sortKey.sort, list.ascending, list.foldersFirst, list.showHidden)
        if t === tab { updateChrome() }
        Task.detached(priority: .userInitiated) {
            // a place inside an archive is listed from the archive (once; then from memory)
            if let place = ArchivePlace.locate(url) {
                let (cached, pw) = await MainActor.run { (ArchiveStore.cached(place.archive), ArchiveStore.password(for: place.archive)) }
                let opened: Result<Archive, Error> = cached.map { .success($0) } ?? Result { try Archive.open(path: place.archive.path, password: pw) }
                await MainActor.run { [weak self] in
                    guard let self, t.loadID == id else { return }
                    self.finishArchiveLoad(t, place: place, opened: opened, triedPassword: pw != nil)
                }
                return
            }
            let began = Date()
            let result: Result<Folder, Error>
            if let s = SearchPlace.parse(url) {
                let paths = SearchPlace.run(s.dir, s.query)
                result = .success(Folder.gathered(label: url.absoluteString, paths: paths, column: column, ascending: ascending, foldersFirst: first, showHidden: hidden))
            } else if let tag = TagStore.name(of: url) {
                let paths = TagStore.files(tagged: tag)
                result = .success(Folder.gathered(label: url.absoluteString, paths: paths, column: column, ascending: ascending, foldersFirst: first, showHidden: hidden))
            } else {
                result = Result { try Folder.open(path: url.path, column: column, ascending: ascending, foldersFirst: first, showHidden: hidden) }
            }
            await MainActor.run { [weak self] in
                guard let self, t.loadID == id else { return }
                t.archive = nil
                switch result {
                case .success(let f):
                    t.folder = f
                    t.error = nil
                case .failure(let e):
                    t.folder = nil
                    t.error = Self.describe(e, at: url)
                }
                guard t === self.tab else { return }
                if keepScroll { t.scrollY = self.list.scrollY }
                self.showTab()
                // Advanced › Performance in the status bar
                let ms = Date().timeIntervalSince(began) * 1000
                self.list.status.performance = AppSettings.performanceInfo
                    ? String(localized: "Listed in \(String(format: "%.0f", ms)) ms") : ""
                if self.pendingRename {
                    self.pendingRename = false
                    self.list.beginRename()
                }
            }
        }
    }

    private var pendingRename = false

    /// The archive is listed (or not): show the folder in it, or ask for its password.
    private func finishArchiveLoad(_ t: BrowserTab, place: ArchivePlace, opened: Result<Archive, Error>, triedPassword: Bool) {
        switch opened {
        case .success(let archive):
            ArchiveStore.store(archive, for: place.archive)
            if archive.hasFolder(inner: place.inner),
                let f = archive.folder(inner: place.inner, column: list.sortKey.sort, ascending: list.ascending, foldersFirst: list.foldersFirst, showHidden: list.showHidden)
            {
                t.folder = f
                t.error = nil
                t.archive = ArchiveView(place: place, archive: archive)
            } else {
                t.folder = nil
                t.archive = nil
                t.error = String(localized: "“\(place.inner)” is not in “\(place.archive.lastPathComponent)”.")
            }
        case .failure(ArchiveError.PasswordNeeded):
            guard t === tab else { return }
            if let pw = ArchiveStore.askPassword(for: place.archive, in: window, wrong: triedPassword) {
                ArchiveStore.setPassword(pw, for: place.archive)
                return load(t)
            }
            t.folder = nil
            t.archive = nil
            t.error = String(localized: "“\(place.archive.lastPathComponent)” needs a password.")
        case .failure(let e):
            t.folder = nil
            t.archive = nil
            t.error = String(localized: "“\(place.archive.lastPathComponent)” can’t be opened: \(e.localizedDescription)")
        }
        guard t === tab else { return }
        showTab()
    }

    /// Ejects a disk; a tab showing it goes Home.
    func eject(_ volume: URL) {
        let path = volume.standardizedFileURL.path
        for t in tabs where t.url.path == path || t.url.path.hasPrefix(path + "/") {
            if t === tab { goHome(nil) } else { t.url = FileManager.default.homeDirectoryForCurrentUser }
        }
        watcher = nil
        Task.detached(priority: .userInitiated) {
            let result = Result { try NSWorkspace.shared.unmountAndEjectDevice(at: volume) }
            if case .failure(let e) = result {
                await MainActor.run { [weak self] in self?.showError(e.localizedDescription) }
            }
        }
    }

    /// Mounts a disk image and shows the disk (it also appears under Drives).
    func openDiskImage(_ url: URL) {
        Task.detached(priority: .userInitiated) {
            let result = Result { try DiskImages.attach(url) }
            await MainActor.run { [weak self] in
                switch result {
                case .success(let mount): self?.navigate(to: mount)
                case .failure(let e): self?.showError(e.localizedDescription)
                }
            }
        }
    }

    /// Lists the folder again in place: selection and scroll kept, or `names` selected.
    private func reload(selecting names: [String]? = nil, rename: Bool = false) {
        if let names, !names.isEmpty {
            tab.selection = names
            tab.scrollY = nil
        } else {
            tab.selection = list.selectedNames
        }
        pendingRename = rename
        load(tab, keepScroll: names?.isEmpty ?? true)
    }

    private func watch() {
        watcher = tab.isPage || !tab.url.isFileURL ? nil : DirectoryWatcher(url: tab.url) { [weak self] in self?.reload() }
    }

    private static func describe(_ error: Error, at url: URL) -> String {
        let name = FileManager.default.displayName(atPath: url.path)
        switch error as? FsError {
        case .NotFound:
            return String(localized: "“\(name)” can’t be found.")
        case .PermissionDenied:
            return String(localized: "Pulse Explorer can’t open “\(name)” because it doesn’t have permission. You can give it access in System Settings › Privacy & Security › Full Disk Access.")
        default:
            return String(localized: "“\(name)” can’t be opened: \(error.localizedDescription)")
        }
    }

    private func updateChrome() {
        if tab.isWeb {
            let page = tab.page
            navBar.back.isEnabled = (page?.view.canGoBack ?? false) || !tab.back.isEmpty
            navBar.forward.isEnabled = (page?.view.canGoForward ?? false) || !tab.forward.isEmpty
            navBar.up.isEnabled = false
            let shown = page?.url ?? tab.url
            let text = shown == WebAddress.blank ? "" : (shown.isFileURL ? shown.path : shown.absoluteString)
            navBar.omnibar.breadcrumb.segments = [BreadcrumbView.Segment(title: text.isEmpty ? String(localized: "New browser tab") : text, url: shown)]
            navBar.omnibar.currentPath = text
            sidebar.selectedURL = nil
            return
        }
        navBar.back.isEnabled = !tab.back.isEmpty
        navBar.forward.isEnabled = !tab.forward.isEmpty
        navBar.up.isEnabled = !tab.isHome && (tab.isSettings || tab.tagName != nil || tab.url.path != "/")
        if tab.isSettings {
            navBar.omnibar.breadcrumb.segments = [BreadcrumbView.Segment(title: String(localized: "Settings"), url: BrowserTab.settingsURL)]
        } else if tab.isHome {
            navBar.omnibar.breadcrumb.segments = [BreadcrumbView.Segment(title: String(localized: "Home"), url: BrowserTab.homeURL)]
        } else if let s = tab.search {
            navBar.omnibar.breadcrumb.segments = BreadcrumbView.segments(for: s.dir)
                + [BreadcrumbView.Segment(title: String(localized: "Search “\(s.query)”"), url: tab.url)]
        } else if let tag = tab.tagName {
            navBar.omnibar.breadcrumb.segments = [BreadcrumbView.Segment(title: String(localized: "Tags"), url: BrowserTab.homeURL), BreadcrumbView.Segment(title: tag, url: tab.url)]
        } else {
            navBar.omnibar.breadcrumb.segments = BreadcrumbView.segments(for: tab.url)
        }
        navBar.omnibar.currentPath = tab.isPage || !tab.url.isFileURL ? "" : tab.url.path
        sidebar.selectedURL = tab.url
    }

    private func submitPath(_ text: String) {
        // "home" is the Home page, as on Windows
        if text.trimmingCharacters(in: .whitespaces).lowercased() == "home" { return goHome(nil) }
        // "@name": a folder alias (Files › Folder aliases), "@name/sub" goes inside it
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("@") {
            let parts = trimmed.dropFirst().split(separator: "/", maxSplits: 1).map(String.init)
            if let first = parts.first, let target = AppSettings.folderAliases[first] ?? AppSettings.folderAliases.first(where: { $0.key.lowercased() == first.lowercased() })?.value {
                return submitPath(parts.count > 1 ? target + "/" + parts[1] : target)
            }
        }
        let path = (text.trimmingCharacters(in: .whitespaces) as NSString).expandingTildeInPath
        // a web address opens as a page (Pulse's browser tabs); a file or folder by that name comes first
        let base = tab.url.isFileURL && !tab.isWeb ? tab.url : FileManager.default.homeDirectoryForCurrentUser
        let url = path.hasPrefix("/") ? URL(fileURLWithPath: path) : base.appendingPathComponent(path)
        var isDir: ObjCBool = false
        let exists = FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir)
        if let web = WebAddress.parse(trimmed), !(exists && !path.hasPrefix("http")) {
            return navigate(to: web)
        }
        if exists, !isDir.boolValue, WebAddress.isHTMLFile(url) { return navigate(to: url) }
        guard exists else {
            // Files › Run programs from the address bar
            if AppSettings.addressCommands, !tab.isPage, AddressCommand.run(text, in: tab.url) { return }
            showError(String(localized: "“\(text)” can’t be found."))
            return
        }
        if isDir.boolValue {
            navigate(to: url)
        } else {
            navigate(to: url.deletingLastPathComponent(), selecting: url.lastPathComponent)
        }
    }

    func showError(_ text: String) {
        Log.write(text)
        guard let window else { return }
        let alert = NSAlert()
        alert.messageText = text
        alert.alertStyle = .warning
        alert.beginSheetModal(for: window)
    }

    // MARK: actions (menus, buttons, keys)

    @objc func goBack(_ sender: Any?) {
        if tab.isWeb, let page = tab.page, page.view.canGoBack { page.view.goBack(); return }
        guard let url = tab.back.popLast() else { return }
        saveTabState()
        tab.forward.append(tab.url)
        tab.url = url
        tab.selection = []
        tab.scrollY = nil
        load(tab)
        refreshTabs()
    }

    @objc func goForward(_ sender: Any?) {
        if tab.isWeb, let page = tab.page, page.view.canGoForward { page.view.goForward(); return }
        guard let url = tab.forward.popLast() else { return }
        saveTabState()
        tab.back.append(tab.url)
        tab.url = url
        tab.selection = []
        tab.scrollY = nil
        load(tab)
        refreshTabs()
    }

    @objc func goUp(_ sender: Any?) {
        // Settings goes up to Home, as on Windows
        if tab.isSettings { return goHome(sender) }
        if tab.isHome || tab.isWeb { return }
        if tab.tagName != nil { return goHome(sender) }
        if let s = tab.search { return navigate(to: s.dir) }
        let parent = tab.url.deletingLastPathComponent()
        guard parent.path != tab.url.path else { return }
        navigate(to: parent, selecting: AppSettings.upSelectsPrevious ? tab.url.lastPathComponent : nil)
    }

    @objc func goHome(_ sender: Any?) { navigate(to: BrowserTab.homeURL) }
    @objc func goHomeFolder(_ sender: Any?) { navigate(to: FileManager.default.homeDirectoryForCurrentUser) }
    @objc func goDocuments(_ sender: Any?) { go(.documentDirectory) }
    @objc func goDesktop(_ sender: Any?) { go(.desktopDirectory) }
    @objc func goDownloads(_ sender: Any?) { go(.downloadsDirectory) }
    @objc func goApplications(_ sender: Any?) { navigate(to: URL(fileURLWithPath: "/Applications")) }

    private func go(_ dir: FileManager.SearchPathDirectory) {
        if let url = FileManager.default.urls(for: dir, in: .userDomainMask).first { navigate(to: url) }
    }

    @objc func refresh(_ sender: Any?) {
        if tab.isHome { return list.reloadHome() }
        if tab.isWeb { tab.page?.view.reload(); return }
        reload()
    }
    @objc func openSelection(_ sender: Any?) { list.openSelected() }
    @objc func toggleHidden(_ sender: Any?) { AppSettings.showHidden.toggle() }
    @objc func openSettings(_ sender: Any?) { navigate(to: BrowserTab.settingsURL) }
    func showSettingsPage(_ page: SettingsPage) { list.showSettings(page: page) }

    /// Development aid (RF_DEMO_PREVIEW): the pane open on `row`, the setting left as it was.
    func demoPreview(row: Int) {
        let was = UserDefaults.standard.bool(forKey: "previewShown")
        list.previewShown = true
        UserDefaults.standard.set(was, forKey: "previewShown")
        list.table.selectRowIndexes([row], byExtendingSelection: false)
    }

    /// Development aid (RF_DEMO_MENU): opens the list's menu as a right-click would.
    func demoMenu(item: Bool) {
        if item { list.table.selectRowIndexes([0], byExtendingSelection: false) } else { list.table.deselectAll(nil) }
        let menu = list.contextMenu()
        let at = NSPoint(x: 300, y: item ? 20 : 200)
        if Motion.on, let w = list.table.window {
            PulseMenu.show(menu, for: nil, in: list.table, at: w.convertPoint(toScreen: list.table.convert(at, to: nil)))
        } else {
            menu.popUp(positioning: nil, at: at, in: list.table)
        }
    }

    func openSettings(page: SettingsPage) {
        openSettings(nil)
        showSettingsPage(page)
    }

    // MARK: Status Center

    private lazy var statusPopover: NSPopover = {
        let p = NSPopover()
        p.behavior = .transient
        let v = StatusCenterView()
        let vc = NSViewController()
        vc.view = v
        v.onResize = { [weak p] size in p?.contentSize = size }
        p.contentViewController = vc
        p.contentSize = v.frame.size
        return p
    }()

    func toggleStatusCenter() {
        if statusPopover.isShown { return statusPopover.performClose(nil) }
        StatusCenter.shared.unseenFailure = false
        statusChanged()
        statusPopover.show(relativeTo: navBar.statusCenter.bounds, of: navBar.statusCenter, preferredEdge: .maxY)
    }

    /// The ☑ button: accent while something runs, ⚠ after a failure nobody has seen.
    @objc private func statusChanged() {
        let sc = StatusCenter.shared
        navBar.statusCenter.icon = sc.unseenFailure ? "circle-alert" : "list-checks"
        navBar.statusCenter.tint = { p in sc.unseenFailure ? p.danger : (sc.isBusy ? p.accent : p.text) }
        // a ring fills round the button while something runs
        navBar.statusCenter.ring = sc.isBusy ? (sc.overallProgress ?? 0) : nil
        navBar.statusCenter.iconSize = sc.isBusy ? 14 : 16
        navBar.statusCenter.needsDisplay = true
    }
    @objc func focusSearch(_ sender: Any?) { navBar.omnibar.mode == .filter ? navBar.omnibar.end() : navBar.omnibar.begin(.filter) }
    @objc func focusAddress(_ sender: Any?) { navBar.omnibar.begin(.path) }
    /// ⌘K: every command and place, by typing (CommandPalette.swift).
    @objc func showCommandPalette(_ sender: Any?) { CommandPalette.toggle(for: self) }
    /// ⇧⌘F: the search field for this folder and everything under it.
    @objc func focusDeepSearch(_ sender: Any?) { navBar.omnibar.begin(.search) }

    private func searchSubfolders(_ text: String) {
        let dir = tab.search?.dir ?? (tab.url.isFileURL && !tab.isWeb ? tab.url : FileManager.default.homeDirectoryForCurrentUser)
        navigate(to: SearchPlace.url(in: dir, query: text))
    }
    @objc func newFolder(_ sender: Any?) { list.newFolder() }
    @objc func cut(_ sender: Any?) { list.cutItems() }
    @objc func copy(_ sender: Any?) { list.copyItems() }
    @objc func paste(_ sender: Any?) { list.pasteItems() }
    @objc func rename(_ sender: Any?) { list.beginRename() }
    @objc func moveToTrash(_ sender: Any?) { list.trashSelected() }
    @objc func toggleQuickLook(_ sender: Any?) { list.toggleQuickLook() }
    @objc func showDetails(_ sender: Any?) { list.setViewMode(.details) }
    @objc func showTiles(_ sender: Any?) { list.setViewMode(.tiles) }
    @objc func zoomIn(_ sender: Any?) { list.zoom(1) }
    @objc func zoomOut(_ sender: Any?) { list.zoom(-1) }
    @objc func zoomReset(_ sender: Any?) { list.zoom(0) }

    /// Properties of the selection, or of the folder shown when nothing is selected (⌘I).
    @objc func showProperties(_ sender: Any?) { list.showProperties() }

    @objc func togglePreviewPane(_ sender: Any?) {
        list.togglePreviewPane(nil)
        // every window follows
        for c in AppDelegate.shared.controllers where c !== self { c.list.previewShown = list.previewShown }
    }

    @objc func toggleSidebar(_ sender: Any?) {
        sidebarShown.toggle()
        UserDefaults.standard.set(!sidebarShown, forKey: "sidebarHidden")
        let shown = sidebarShown
        if shown {
            // it comes in from a little to the left, faded, at its full width
            sidebar.isHidden = false
            sidebar.alphaValue = 0
        }
        Motion.animate(0.26, { [self] in
            layoutRoot()
            root.layoutSubtreeIfNeeded()
        }, completion: { [weak self] in
            guard let self, !self.sidebarShown, !shown else { return }
            self.sidebar.isHidden = true
        })
    }

    // MARK: browser tabs (WebTabs.swift)

    /// A new tab on a blank page with the address field ready for a URL (workspace.rs `open_browser_tab`).
    @objc func newBrowserTab(_ sender: Any?) {
        openTab(WebAddress.blank, activate: true)
        navBar.omnibar.begin(.path)
    }

    /// The tab's page, made the first time the tab shows.
    private func webPage(for t: BrowserTab) -> WebPage {
        if let p = t.page { return p }
        let p = WebPage()
        t.page = p
        root.addSubview(p.container, positioned: .above, relativeTo: list.card)
        p.onChange = { [weak self, weak t] in
            guard let self, let t, let page = t.page else { return }
            if let u = page.url, u != t.url, WebAddress.isWeb(u) { t.url = u }
            self.refreshTabs()
            if t === self.tab { self.updateChrome() }
        }
        p.onNewTab = { [weak self] url in self?.openTab(url, activate: true) }
        if t.url != WebAddress.blank { p.load(t.url) }
        return p
    }

    private func dropPage(_ t: BrowserTab) {
        t.page?.container.removeFromSuperview()
        t.page = nil
    }

    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        let selected = !list.selectedNames.isEmpty
        switch item.action {
        case #selector(goBack(_:)): return !tab.back.isEmpty
        case #selector(goForward(_:)): return !tab.forward.isEmpty
        case #selector(goUp(_:)): return !tab.isWeb && tab.url.path != "/"
        case #selector(openSelection(_:)), #selector(cut(_:)), #selector(BrowserWindowController.copy(_:) as (BrowserWindowController) -> (Any?) -> Void), #selector(moveToTrash(_:)),
            #selector(toggleQuickLook(_:)):
            return selected
        case #selector(rename(_:)): return !list.selectedNames.isEmpty
        case #selector(paste(_:)): return Clipboard.hasFiles && list.folder != nil
        case #selector(newFolder(_:)): return list.folder != nil
        case #selector(selectNextTab(_:)), #selector(selectPreviousTab(_:)): return tabs.count > 1
        case #selector(reopenClosedTab(_:)): return !closedTabs.isEmpty
        case #selector(showDetails(_:)):
            item.state = list.viewMode == .details ? .on : .off
            return true
        case #selector(showTiles(_:)):
            item.state = list.viewMode == .tiles ? .on : .off
            return true
        case #selector(toggleHidden(_:)):
            item.state = AppSettings.showHidden ? .on : .off
            return true
        case #selector(showProperties(_:)): return list.archiveIsNil && list.url != nil
        case #selector(togglePreviewPane(_:)):
            item.title = list.previewShown ? String(localized: "Hide Preview") : String(localized: "Show Preview")
            return true
        case #selector(toggleSidebar(_:)):
            item.title = sidebarShown ? String(localized: "Hide Sidebar") : String(localized: "Show Sidebar")
            return true
        default: return true
        }
    }
}
