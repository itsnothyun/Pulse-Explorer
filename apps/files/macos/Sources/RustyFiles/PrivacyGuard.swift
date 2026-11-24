import Foundation

/// The folders macOS asks the user about before an app may read them (Desktop, Documents, Downloads, iCloud Drive and cloud
/// drives, other apps' data, the Photos and Music libraries, other volumes).
///
/// The app reads them when the user opens them: that is the moment the question belongs to, and macOS remembers the answer.
/// What the app does on its own, the preview pane counting what a selected folder holds, a folder's size being added up,
/// the Home page's Recent list, must not ask: passing over "Desktop" with the arrow keys brought up the permission prompt,
/// and a size walk from the home folder went into all of them at once. So those stay out of such places until the user has
/// opened them once.
@MainActor
enum PrivacyGuard {
    private static let home = FileManager.default.homeDirectoryForCurrentUser.standardizedFileURL.path
    private static let key = "privacyOpened"

    /// The guarded folders under the home folder.
    private static let homeRoots: [String] = [
        "Desktop", "Documents", "Downloads",
        "Library/Mobile Documents", "Library/CloudStorage", "Library/Containers", "Library/Group Containers",
        "Library/Mail", "Library/Messages", "Library/Safari", "Library/Calendars", "Library/Reminders", "Library/HomeKit",
        "Library/Application Support/AddressBook", "Library/Application Support/CallHistoryDB", "Library/Application Support/com.apple.TCC",
        "Library/Suggestions", "Library/Cookies", "Library/Metadata/CoreSpotlight", "Library/IdentityServices", "Library/Accounts",
        // (their photo, music and TV libraries are asked about separately, and so are libraries elsewhere in them: Photo Booth)
        "Pictures", "Music", "Movies",
    ].map { home + "/" + $0 }

    /// Every guarded folder now: those above, and each mounted volume but the startup disk (looked up at most every few
    /// seconds: the Home page asks for each of its rows).
    static var roots: [String] {
        if let c = cachedRoots, Date().timeIntervalSince(c.at) < 5 { return c.list }
        let volumes = ((try? FileManager.default.contentsOfDirectory(atPath: "/Volumes")) ?? [])
            .map { "/Volumes/" + $0 }
            .filter { (try? FileManager.default.destinationOfSymbolicLink(atPath: $0)) != "/" }
        let list = homeRoots + volumes
        cachedRoots = (Date(), list)
        return list
    }
    private static var cachedRoots: (at: Date, list: [String])?

    private static var opened: Set<String> {
        get { Set(UserDefaults.standard.stringArray(forKey: key) ?? []) }
        set { UserDefaults.standard.set(Array(newValue).sorted(), forKey: key) }
    }

    /// The guarded folder `p` is in (the startup disk's data volume shows the home folder a second time, under
    /// /System/Volumes/Data).
    private static func match(_ p: String, in list: [String]) -> String? {
        let data = "/System/Volumes/Data"
        let q = p.hasPrefix(data + "/") ? String(p.dropFirst(data.count)) : p
        return list.first { q == $0 || q.hasPrefix($0 + "/") }
    }

    /// `path` with its links followed, and the guarded folder it is in. The links are followed one folder at a time and the
    /// walk stops at the first guarded folder: resolving the whole path at once (resolvingSymlinksInPath) looks at every folder
    /// on the way, inside the guarded one too, which is the very access macOS asks about (the Home page's Recent list asked
    /// for the Photo Library that way).
    private static func resolve(_ path: String) -> (path: String, root: String?) {
        let list = roots
        let start = URL(fileURLWithPath: path).standardizedFileURL.path
        if let r = match(start, in: list) { return (start, r) }
        var done = ""
        var rest = start.split(separator: "/").map(String.init)
        var hops = 0
        while !rest.isEmpty {
            done += "/" + rest.removeFirst()
            let tail = rest.map { "/" + $0 }.joined()
            if let r = match(done, in: list) { return (done + tail, r) }
            // a link (outside any guarded folder: checked just above) is read, not what it points to
            guard hops < 32, let dest = try? FileManager.default.destinationOfSymbolicLink(atPath: done) else { continue }
            hops += 1
            let target = dest.hasPrefix("/") ? dest : (done as NSString).deletingLastPathComponent + "/" + dest
            let next = URL(fileURLWithPath: target).standardizedFileURL.path + tail
            if let r = match(next, in: list) { return (next, r) }
            done = ""
            rest = next.split(separator: "/").map(String.init)
        }
        return (done.isEmpty ? "/" : done, nil)
    }

    /// The guarded folder `path` is in (or is), when it is one.
    static func root(of path: String) -> String? {
        resolve(path).root
    }

    /// The user opened `path`: if it is in a guarded folder, that folder has had its question (and is read from now on).
    static func noteOpened(_ path: String) {
        guard let r = root(of: path), !opened.contains(r) else { return }
        opened.insert(r)
    }

    /// Whether the app may look into `path` on its own (it is not guarded, or the user has opened it before).
    static func mayRead(_ path: String) -> Bool {
        guard let r = root(of: path) else { return true }
        return opened.contains(r)
    }

    /// The guarded folders under `path` the app has not been let into: a size walk from `path` leaves them out.
    static func unopened(under path: String) -> [String] {
        let p = resolve(path).path
        let seen = opened
        let shut = roots.filter { !seen.contains($0) }
        return (shut + shut.map { "/System/Volumes/Data" + $0 }).filter { $0.hasPrefix(p + "/") || p == "/" }
    }
}
