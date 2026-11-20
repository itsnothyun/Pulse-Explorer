import Foundation

/// The Shelf: files gathered from anywhere, to move or copy together in one go (the Windows app's shelf_view.rs).
/// The list is the user's, kept between launches; items that were deleted or moved away drop off by themselves.
public final class ShelfStore: @unchecked Sendable {
    private let defaults: UserDefaults
    private let key: String
    public static let limit = 500

    public init(defaults: UserDefaults = .standard, key: String = "pulseShelf") {
        self.defaults = defaults
        self.key = key
    }

    /// What is on the shelf and still exists, in the order added.
    public var items: [URL] {
        let paths = defaults.stringArray(forKey: key) ?? []
        return paths.map { URL(fileURLWithPath: $0) }.filter { FileManager.default.fileExists(atPath: $0.path) }
    }

    /// Adds (no doubles; the oldest go past the limit). Returns how many were new.
    @discardableResult
    public func add(_ urls: [URL]) -> Int {
        var paths = items.map(\.standardizedFileURL.path)
        var added = 0
        for u in urls where u.isFileURL && FileManager.default.fileExists(atPath: u.path) {
            let p = u.standardizedFileURL.path
            if !paths.contains(p) {
                paths.append(p)
                added += 1
            }
        }
        defaults.set(Array(paths.suffix(Self.limit)), forKey: key)
        return added
    }

    public func remove(_ urls: [URL]) {
        let gone = Set(urls.map(\.standardizedFileURL.path))
        defaults.set(items.map(\.standardizedFileURL.path).filter { !gone.contains($0) }, forKey: key)
    }

    public func clear() { defaults.removeObject(forKey: key) }

    /// Where each item would land in `folder`: its own name, or the next free one ("a 2.txt") when taken there or by an
    /// item before it. Items already in `folder` are left out (nothing to do for them).
    public static func destinations(for items: [URL], in folder: URL, exists: (String) -> Bool) -> [(from: URL, to: URL)] {
        var planned = Set<String>()
        var out: [(URL, URL)] = []
        for item in items where item.deletingLastPathComponent().standardizedFileURL.path != folder.standardizedFileURL.path {
            let ext = item.pathExtension
            let base = ext.isEmpty ? item.lastPathComponent : String(item.lastPathComponent.dropLast(ext.count + 1))
            let name = Naming.unique(base: base, ext: ext, sanitizing: false) { n in exists(n) || planned.contains(n.lowercased()) }
            planned.insert(name.lowercased())
            out.append((item, folder.appendingPathComponent(name)))
        }
        return out.map { (from: $0.0, to: $0.1) }
    }
}
