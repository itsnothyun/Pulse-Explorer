import CoreServices
import CryptoKit
import Foundation

/// "What's eating space here": big files nobody opened for a long time, and copies of the same file. Scanning reads only
/// what the disk already knows (sizes, dates); duplicates are confirmed by content, and only among files of equal size.
public enum DiskLens {
    public struct Item: Equatable, Sendable {
        public let url: URL
        public let size: Int64
        /// When it was last opened (Spotlight's / the file system's "last used"), else its modification date.
        public let lastUsed: Date
        public init(url: URL, size: Int64, lastUsed: Date) {
            self.url = url
            self.size = size
            self.lastUsed = lastUsed
        }
    }

    public struct Options: Sendable {
        public var minSize: Int64 = 100 * 1024 * 1024
        public var unusedFor: TimeInterval = 180 * 86_400
        /// A walk stops after this many files (a whole disk is not what this is for).
        public var maxFiles = 200_000
        public init() {}
    }

    /// Every regular file under `folder` (hidden ones and package insides skipped), with size and last use.
    public static func scan(_ folder: URL, options: Options = Options(), cancelled: () -> Bool = { false }) -> [Item] {
        let keys: [URLResourceKey] = [.isRegularFileKey, .fileSizeKey, .totalFileAllocatedSizeKey, .contentAccessDateKey, .contentModificationDateKey, .isSymbolicLinkKey]
        guard let walk = FileManager.default.enumerator(at: folder, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles, .skipsPackageDescendants])
        else { return [] }
        var out: [Item] = []
        for case let u as URL in walk {
            if out.count >= options.maxFiles || cancelled() { break }
            guard let v = try? u.resourceValues(forKeys: Set(keys)), v.isRegularFile == true, v.isSymbolicLink != true else { continue }
            let size = Int64(v.totalFileAllocatedSize ?? v.fileSize ?? 0)
            let used = lastUsedDate(u) ?? v.contentAccessDate ?? v.contentModificationDate ?? .distantPast
            out.append(Item(url: u, size: size, lastUsed: used))
        }
        return out
    }

    /// Spotlight's "last opened" (kMDItemLastUsedDate), which is what Finder shows; nil when Spotlight doesn't know.
    public static func lastUsedDate(_ url: URL) -> Date? {
        guard let item = MDItemCreateWithURL(nil, url as CFURL) else { return nil }
        return MDItemCopyAttribute(item, kMDItemLastUsedDate) as? Date
    }

    /// Big and not opened for a while, biggest first.
    public static func bigAndUnused(_ items: [Item], options: Options = Options(), now: Date = Date()) -> [Item] {
        items.filter { $0.size >= options.minSize && now.timeIntervalSince($0.lastUsed) >= options.unusedFor }
            .sorted { $0.size > $1.size }
    }

    /// Groups of files with the same content (two or more each), the biggest waste first. Files under `minSize` bytes are
    /// left out (thousands of tiny copies are rarely what one is after, and hashing them all is slow).
    public static func duplicates(_ items: [Item], minSize: Int64 = 1024 * 1024, cancelled: () -> Bool = { false }) -> [[Item]] {
        let bySize = Dictionary(grouping: items.filter { $0.size >= minSize }, by: \.size).values.filter { $0.count > 1 }
        var groups: [[Item]] = []
        for same in bySize {
            if cancelled() { break }
            // a cheap first look (first and last 64 KB), then the whole file only for those still alike
            let byQuick = Dictionary(grouping: same) { quickHash($0.url) ?? UUID().uuidString }.values.filter { $0.count > 1 }
            for candidates in byQuick {
                let byFull = Dictionary(grouping: candidates) { fullHash($0.url) ?? UUID().uuidString }.values.filter { $0.count > 1 }
                groups += byFull.map { $0.sorted { $0.url.path < $1.url.path } }
            }
        }
        return groups.sorted { wasted($0) > wasted($1) }
    }

    /// Space the extra copies take (all but one).
    public static func wasted(_ group: [Item]) -> Int64 { group.dropFirst().reduce(0) { $0 + $1.size } }

    static func quickHash(_ url: URL) -> String? {
        guard let h = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? h.close() }
        var sha = SHA256()
        let chunk = 64 * 1024
        if let head = try? h.read(upToCount: chunk) { sha.update(data: head) }
        if let end = try? h.seekToEnd(), end > UInt64(chunk * 2) {
            try? h.seek(toOffset: end - UInt64(chunk))
            if let tail = try? h.read(upToCount: chunk) { sha.update(data: tail) }
        }
        return sha.finalize().map { String(format: "%02x", $0) }.joined()
    }

    static func fullHash(_ url: URL) -> String? {
        guard let h = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? h.close() }
        var sha = SHA256()
        while let data = try? h.read(upToCount: 1 << 20), !data.isEmpty { sha.update(data: data) }
        return sha.finalize().map { String(format: "%02x", $0) }.joined()
    }
}
