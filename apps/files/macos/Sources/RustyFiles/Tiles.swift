import AppKit
import Quartz
import QuickLookThumbnailing

/// The grid view's Tiles style, sized as on Windows at its default size (folder_view.rs
/// `GRID_SIZES[2]`): tiles 124 wide in rows 150 high with 4 between them, the picture asked
/// for at 128 and drawn at 96, the label `text_xs`, centred, at most two lines.
enum TileMetrics {
    /// The picture's size at each zoom level (⌘+ / ⌘−, ⌃+ / ⌃−, ⌘-scroll, pinch); level 2 is the Windows default.
    static let levels: [CGFloat] = [48, 64, 96, 128, 176, 256]
    static let defaultLevel = 2
    static var level: Int {
        get {
            let v = UserDefaults.standard.object(forKey: "tileZoom") as? Int ?? defaultLevel
            return min(max(v, 0), levels.count - 1)
        }
        set { UserDefaults.standard.set(min(max(newValue, 0), levels.count - 1), forKey: "tileZoom") }
    }
    static var visual: CGFloat { levels[level] }
    /// 124 × 150 at the default size: the picture, 28 across for the tile's padding, 54 down for two lines of name.
    static var width: CGFloat { visual + 28 }
    static var rowHeight: CGFloat { visual + 54 }
    static let gap: CGFloat = 4
    /// The grid's own padding (`py_2`, `px 6`).
    static let padX: CGFloat = 6
    static let padY: CGFloat = 8
}

/// The details list's row heights (zoom in details: compact, the Windows default, roomy).
enum ListZoom {
    static let levels: [CGFloat] = [24, 30, 38]
    static let defaultLevel = 1
    static var level: Int {
        get { min(max(UserDefaults.standard.object(forKey: "rowZoom") as? Int ?? defaultLevel, 0), levels.count - 1) }
        set { UserDefaults.standard.set(min(max(newValue, 0), levels.count - 1), forKey: "rowZoom") }
    }
    static var rowHeight: CGFloat { levels[level] }
}

/// Thumbnails from Quick Look, made off the main thread and kept for the session. A file
/// Quick Look can't picture keeps its icon.
@MainActor
final class ThumbnailCache {
    static let shared = ThumbnailCache()
    private var images: [String: NSImage] = [:]
    private var failed: Set<String> = []
    private var pending: [String: [(NSImage) -> Void]] = [:]

    func cached(_ path: String) -> NSImage? { images["\(Int(TileMetrics.visual))|" + path] }

    /// Calls `done` with the thumbnail when there is one (not at all when there is none).
    func request(_ path: String, scale: CGFloat, done: @escaping (NSImage) -> Void) {
        let side = TileMetrics.visual
        let key = "\(Int(side))|" + path
        if let image = images[key] { return done(image) }
        guard !failed.contains(path) else { return }
        if pending[key] != nil {
            pending[key]?.append(done)
            return
        }
        pending[key] = [done]
        let request = QLThumbnailGenerator.Request(
            fileAt: URL(fileURLWithPath: path), size: CGSize(width: side, height: side), scale: scale, representationTypes: .thumbnail)
        QLThumbnailGenerator.shared.generateBestRepresentation(for: request) { rep, _ in
            let cg = rep?.cgImage
            Task { @MainActor in
                let waiting = ThumbnailCache.shared.pending.removeValue(forKey: key) ?? []
                guard let cg else {
                    ThumbnailCache.shared.failed.insert(path)
                    return
                }
                let image = NSImage(cgImage: cg, size: NSSize(width: CGFloat(cg.width) / scale, height: CGFloat(cg.height) / scale))
                ThumbnailCache.shared.images[key] = image
                waiting.forEach { $0(image) }
            }
        }
    }

    /// Forgets every thumbnail (Advanced › Cache › Clear).
    func clear() {
        images = [:]
        failed = []
    }

    /// Forgets a folder's thumbnails (its files changed).
    func forget(under dir: String) {
        let prefix = dir.hasSuffix("/") ? dir : dir + "/"
        images = images.filter { !($0.key.split(separator: "|", maxSplits: 1).last.map(String.init) ?? "").hasPrefix(prefix) }
        failed = failed.filter { !$0.hasPrefix(prefix) }
    }
}

/// One tile (folder_view.rs, grid): radius 8, `p_1`, the picture in a box 4 larger than it,
/// the name under it. Selected: selection fill and a 1 px `selection_border`; hover: hover fill.
final class TileView: HoverView {
    let picture = NSImageView()
    let label = NSTextField(wrappingLabelWithString: "")
    var isSelected = false { didSet { needsDisplay = true } }
    var isThumbnail = false { didSet { picture.layer?.cornerRadius = isThumbnail ? 4 : 0 } }

    override init(frame: NSRect) {
        super.init(frame: frame)
        picture.imageScaling = .scaleProportionallyUpOrDown
        picture.wantsLayer = true
        picture.layer?.masksToBounds = true
        label.font = Metrics.textXs
        label.alignment = .center
        // two lines at most, the second ending in "…" (a name cut at both ends reads as broken)
        label.maximumNumberOfLines = 2
        label.lineBreakMode = .byWordWrapping
        label.cell?.truncatesLastVisibleLine = true
        label.cell?.lineBreakMode = .byWordWrapping
        addSubview(picture)
        addSubview(label)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override func layout() {
        super.layout()
        let box = TileMetrics.visual + 4
        let boxX = (bounds.width - box) / 2
        picture.frame = NSRect(x: boxX + 2, y: 4 + 2, width: TileMetrics.visual, height: TileMetrics.visual)
        label.frame = NSRect(x: 4, y: 4 + box + 4, width: bounds.width - 8, height: bounds.height - (4 + box + 4) - 4)
    }

    override func draw(_ dirtyRect: NSRect) {
        let p = Palette.of(self)
        let r = bounds.insetBy(dx: 0.5, dy: 0.5)
        let path = NSBezierPath(roundedRect: r, xRadius: Metrics.radius, yRadius: Metrics.radius)
        if isSelected {
            p.selection.setFill()
            path.fill()
            p.selectionBorder.setStroke()
            path.lineWidth = 1
            path.stroke()
        } else if hovered {
            p.hover.setFill()
            path.fill()
        }
    }
}

final class TileItem: NSCollectionViewItem {
    static let id = NSUserInterfaceItemIdentifier("tile")
    var path = ""

    var tile: TileView { view as! TileView }

    override func loadView() {
        view = TileView(frame: NSRect(x: 0, y: 0, width: TileMetrics.width, height: TileMetrics.rowHeight - TileMetrics.gap))
        textField = tile.label
        imageView = tile.picture
    }

    override var isSelected: Bool { didSet { tile.isSelected = isSelected } }
}

/// The grid itself, with the same keys as the list.
@MainActor
final class TileCollectionView: NSCollectionView, NSServicesMenuRequestor {
    weak var list: FileListController?

    override func keyDown(with event: NSEvent) {
        if list?.handleKey(event) == true { return }
        super.keyDown(with: event)
    }

    override func scrollWheel(with event: NSEvent) {
        if !event.modifierFlags.intersection([.command, .control]).isEmpty, let list {
            list.zoomGesture(event.scrollingDeltaY, notch: event.hasPreciseScrollingDeltas ? 24 : 1)
            return
        }
        super.scrollWheel(with: event)
    }

    override func magnify(with event: NSEvent) {
        list?.zoomGesture(event.magnification, notch: 0.18)
    }

    /// Where a Shift-click's range starts: the item clicked last without Shift.
    private var anchor: IndexPath?

    /// Clicks select as in Finder's icon view: a click picks one item, ⌘ adds or takes away one, Shift picks the range
    /// from the last clicked item (⇧⌘ adds the range to what is picked). Done here because the collection view's own
    /// Shift-click did not extend the selection in this grid.
    override func mouseDown(with event: NSEvent) {
        let at = indexPathForItem(at: convert(event.locationInWindow, from: nil))
        let mods = event.modifierFlags.intersection([.shift, .command])
        if let at, event.clickCount == 1, !mods.isEmpty {
            window?.makeFirstResponder(self)
            var picked = selectionIndexPaths
            if mods.contains(.shift), let from = anchor ?? picked.min() {
                let lo = min(from.item, at.item), hi = max(from.item, at.item)
                let range = Set((lo...hi).map { IndexPath(item: $0, section: at.section) })
                picked = mods.contains(.command) ? picked.union(range) : range
            } else {
                // ⌘ alone: this one in or out
                if picked.contains(at) { picked.remove(at) } else { picked.insert(at) }
                anchor = at
            }
            setSelection(picked)
            return
        }
        super.mouseDown(with: event)
        if let at, mods.isEmpty { anchor = at }
        if at == nil, mods.isEmpty { anchor = nil }
        if event.clickCount == 2, at != nil {
            list?.openSelected()
        }
    }

    /// Picks exactly `picked`, telling the list what came and went (as a click would).
    private func setSelection(_ picked: Set<IndexPath>) {
        let old = selectionIndexPaths
        let gone = old.subtracting(picked)
        let new = picked.subtracting(old)
        selectionIndexPaths = picked
        if !gone.isEmpty { delegate?.collectionView?(self, didDeselectItemsAt: gone) }
        if !new.isEmpty { delegate?.collectionView?(self, didSelectItemsAt: new) }
    }

    /// Pulse's right-click menu (PulseMenu): the same menu, opening with motion.
    override func rightMouseDown(with event: NSEvent) {
        guard Motion.on, let m = menu(for: event) else { return super.rightMouseDown(with: event) }
        PulseMenu.show(m, for: event, in: self)
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        let at = indexPathForItem(at: convert(event.locationInWindow, from: nil))
        if let at, !selectionIndexPaths.contains(at) {
            selectionIndexPaths = [at]
            anchor = at
            delegate?.collectionView?(self, didSelectItemsAt: [at])
        }
        if at == nil {
            let old = selectionIndexPaths
            selectionIndexPaths = []
            delegate?.collectionView?(self, didDeselectItemsAt: old)
        }
        return list?.contextMenu()
    }

    // macOS's Services and Quick Actions (the Windows app's "Show more options") work on the
    // selected files: the menu shows the ones that take file URLs.
    override func validRequestor(forSendType sendType: NSPasteboard.PasteboardType?, returnType: NSPasteboard.PasteboardType?) -> Any? {
        if sendType == .fileURL, returnType == nil, let list, !list.selectedURLs.isEmpty, list.archiveIsNil { return self }
        return super.validRequestor(forSendType: sendType, returnType: returnType)
    }

    func writeSelection(to pboard: NSPasteboard, types: [NSPasteboard.PasteboardType]) -> Bool {
        guard let urls = list?.selectedURLs, !urls.isEmpty else { return false }
        pboard.clearContents()
        return pboard.writeObjects(urls as [NSURL])
    }

    override func acceptsPreviewPanelControl(_ panel: QLPreviewPanel!) -> Bool { true }
    override func beginPreviewPanelControl(_ panel: QLPreviewPanel!) { list?.beginQuickLook(panel) }
    override func endPreviewPanelControl(_ panel: QLPreviewPanel!) { list?.endQuickLook(panel) }
}
