import Foundation

/// Names for files Pulse makes (pasted, converted, collected): never one that is taken, never one a file system refuses.
public enum Naming {
    /// Characters no name may hold here: "/" splits paths; ":" shows as "/" in Finder; control characters are invisible.
    public static func sanitize(_ name: String, fallback: String = "Untitled") -> String {
        var s = name.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }.map(String.init).joined()
        s = s.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
        s = s.trimmingCharacters(in: .whitespacesAndNewlines)
        // a leading dot would hide it; "." and ".." are no names at all
        while s.hasPrefix(".") { s.removeFirst() }
        if s.isEmpty { s = fallback }
        // 255 bytes is the limit of APFS and NTFS names; cut on a character boundary
        while s.utf8.count > 240 { s.removeLast() }
        return s
    }

    /// `base.ext`, or `base 2.ext`, `base 3.ext`… the first that `taken` says is free. Case is ignored, as on the Mac's
    /// and Windows' usual disks.
    /// `sanitizing: false` keeps a name as it is (an existing file's: ".env" stays ".env").
    public static func unique(base: String, ext: String, sanitizing: Bool = true, taken: (String) -> Bool) -> String {
        let b = sanitizing ? sanitize(base) : base
        let e = sanitizing ? ext.trimmingCharacters(in: CharacterSet(charactersIn: ".")).lowercased() : ext
        func name(_ n: Int) -> String {
            let stem = n == 1 ? b : "\(b) \(n)"
            return e.isEmpty ? stem : "\(stem).\(e)"
        }
        var n = 1
        while taken(name(n)) {
            n += 1
            if n > 10_000 { return name(Int(Date().timeIntervalSince1970)) }
        }
        return name(n)
    }

    /// `unique` against what is in `folder` on disk.
    public static func unique(base: String, ext: String, in folder: URL) -> String {
        let existing = Set(((try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []).map { $0.lowercased() })
        return unique(base: base, ext: ext) { existing.contains($0.lowercased()) }
    }

    /// "2026-11-21 at 14.05.09", the stamp macOS puts in screenshot names (dots: ":" can't be in a name).
    public static func stamp(_ date: Date = Date(), calendar: Calendar = .current) -> String {
        let c = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        func two(_ v: Int?) -> String { String(format: "%02d", v ?? 0) }
        return "\(c.year ?? 0)-\(two(c.month))-\(two(c.day)) at \(two(c.hour)).\(two(c.minute)).\(two(c.second))"
    }
}
