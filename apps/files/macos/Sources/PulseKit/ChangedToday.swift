import Foundation

/// "What changed today": files modified since the start of the day under a folder, newest first, grouped by hour.
public enum ChangedToday {
    public struct Group: Equatable, Sendable {
        /// The hour's start.
        public let hour: Date
        public let files: [URL]
    }

    /// `items` (path and modification date) changed on or after the start of `now`'s day, in hourly groups, newest first.
    public static func group(_ items: [(url: URL, modified: Date)], now: Date = Date(), calendar: Calendar = .current) -> [Group] {
        let start = calendar.startOfDay(for: now)
        let today = items.filter { $0.modified >= start && $0.modified <= now.addingTimeInterval(60) }
        let byHour = Dictionary(grouping: today) { calendar.dateInterval(of: .hour, for: $0.modified)?.start ?? start }
        return byHour.keys.sorted(by: >).map { h in
            Group(hour: h, files: byHour[h]!.sorted { $0.modified > $1.modified }.map(\.url))
        }
    }

    /// Files under `folder` modified today (hidden items and package insides skipped), capped.
    public static func scan(_ folder: URL, now: Date = Date(), calendar: Calendar = .current, limit: Int = 2000) -> [(url: URL, modified: Date)] {
        let start = calendar.startOfDay(for: now)
        let keys: Set<URLResourceKey> = [.isRegularFileKey, .contentModificationDateKey]
        guard let walk = FileManager.default.enumerator(at: folder, includingPropertiesForKeys: Array(keys), options: [.skipsHiddenFiles, .skipsPackageDescendants])
        else { return [] }
        var out: [(URL, Date)] = []
        var visited = 0
        for case let u as URL in walk {
            visited += 1
            if visited > 300_000 || out.count >= limit { break }
            // build and dependency folders change all day and say nothing about one's own work
            if ["node_modules", ".build", "target", "build", "dist", "DerivedData", "vendor"].contains(u.lastPathComponent) {
                walk.skipDescendants()
                continue
            }
            guard let v = try? u.resourceValues(forKeys: keys), v.isRegularFile == true, let m = v.contentModificationDate, m >= start else { continue }
            out.append((u, m))
        }
        return out.map { (url: $0.0, modified: $0.1) }
    }
}
