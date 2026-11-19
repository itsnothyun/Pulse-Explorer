import AppKit

/// Pulse's tools for people who code (Mac): where a file sits in its Git repository, its branch and what changed, links
/// to the file on GitHub / GitLab / Bitbucket, and paths copied in the forms code and chats want.
enum Repo {
    /// The work tree `url` is in (the folder holding `.git`, a folder or a worktree's file), or nil.
    nonisolated static func root(of url: URL) -> URL? {
        var d = url.hasDirectoryPath || (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true ? url : url.deletingLastPathComponent()
        while true {
            if FileManager.default.fileExists(atPath: d.appendingPathComponent(".git").path) { return d }
            let up = d.deletingLastPathComponent()
            if up.path == d.path { return nil }
            d = up
        }
    }

    /// `git <args>` in `dir`, its output trimmed; nil when git fails or is missing.
    nonisolated static func git(_ args: [String], in dir: URL) -> String? {
        guard FileManager.default.isExecutableFile(atPath: "/usr/bin/git") else { return nil }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = args
        p.currentDirectoryURL = dir
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return nil }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        guard p.terminationStatus == 0 else { return nil }
        return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    struct Summary: Sendable {
        var branch: String
        var changed: Int
        var ahead: Int
        var behind: Int
    }

    /// Branch, how many paths changed, and how far it is ahead of / behind its upstream (one `git status`).
    nonisolated static func summary(_ dir: URL) -> Summary? {
        guard let out = git(["status", "--porcelain=v2", "--branch", "--untracked-files=normal"], in: dir) else { return nil }
        var s = Summary(branch: "", changed: 0, ahead: 0, behind: 0)
        for line in out.split(separator: "\n") {
            if line.hasPrefix("# branch.head ") {
                s.branch = String(line.dropFirst("# branch.head ".count))
            } else if line.hasPrefix("# branch.ab ") {
                for part in line.dropFirst("# branch.ab ".count).split(separator: " ") {
                    if part.hasPrefix("+") { s.ahead = Int(part.dropFirst()) ?? 0 }
                    if part.hasPrefix("-") { s.behind = Int(part.dropFirst()) ?? 0 }
                }
            } else if !line.hasPrefix("#") {
                s.changed += 1
            }
        }
        if s.branch == "(detached)", let sha = git(["rev-parse", "--short", "HEAD"], in: dir) { s.branch = sha }
        return s
    }

    /// The repository's page on the web, from `origin` (git@host:owner/repo.git, https://host/owner/repo(.git), ssh://).
    nonisolated static func webURL(_ root: URL) -> URL? {
        guard var remote = git(["config", "--get", "remote.origin.url"], in: root), !remote.isEmpty else { return nil }
        if remote.hasSuffix(".git") { remote.removeLast(4) }
        if remote.hasPrefix("git@"), let colon = remote.firstIndex(of: ":") {
            let host = remote[remote.index(remote.startIndex, offsetBy: 4)..<colon]
            return URL(string: "https://\(host)/\(remote[remote.index(after: colon)...])")
        }
        if remote.hasPrefix("ssh://"), var u = URLComponents(string: remote) {
            u.scheme = "https"
            u.user = nil
            u.port = nil
            return u.url
        }
        if var u = URLComponents(string: remote), u.scheme == "https" || u.scheme == "http" {
            u.user = nil
            u.password = nil
            return u.url
        }
        return nil
    }

    /// The file (or folder) on the web at the current branch: GitHub/Gitea `blob|tree`, GitLab `-/blob|-/tree`,
    /// Bitbucket `src`.
    nonisolated static func webURL(for url: URL, root: URL) -> URL? {
        guard let base = webURL(root) else { return nil }
        let rel = relativePath(url, root: root)
        let branch = git(["rev-parse", "--abbrev-ref", "HEAD"], in: root).flatMap { $0 == "HEAD" ? git(["rev-parse", "HEAD"], in: root) : $0 } ?? "HEAD"
        let isDir = (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true
        let host = base.host ?? ""
        let path: String
        if host.contains("gitlab") {
            path = "-/\(isDir ? "tree" : "blob")/\(branch)/\(rel)"
        } else if host.contains("bitbucket") {
            path = "src/\(branch)/\(rel)"
        } else {
            path = "\(isDir ? "tree" : "blob")/\(branch)/\(rel)"
        }
        let encoded = path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? path
        return URL(string: base.absoluteString + "/" + encoded)
    }

    nonisolated static func relativePath(_ url: URL, root: URL) -> String {
        let r = root.standardizedFileURL.path
        let p = url.standardizedFileURL.path
        return p.hasPrefix(r + "/") ? String(p.dropFirst(r.count + 1)) : p
    }
}

/// The forms "Copy path as" offers.
@MainActor
enum PathForms {
    static func copy(_ text: String, note: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        Log.write(note)
    }

    /// Single-quoted for a shell ('it'\''s').
    static func shellQuoted(_ p: String) -> String { "'" + p.replacingOccurrences(of: "'", with: "'\\''") + "'" }

    /// The "Copy path as" submenu for `urls`.
    static func menu(_ urls: [URL], into b: MenuBuilder) {
        guard !urls.isEmpty else { return }
        let root = Repo.root(of: urls[0])
        let join = { (f: (URL) -> String) in urls.map(f).joined(separator: "\n") }
        b.sub(String(localized: "Copy path as"), "clipboard-copy") { s in
            s.add(String(localized: "Full path"), "file") { copy(join { $0.path }, note: "path") }
            if let root {
                s.add(String(localized: "Path in the repository"), "git-branch") { copy(join { Repo.relativePath($0, root: root) }, note: "relative") }
            }
            s.add(String(localized: "Name"), "type") { copy(join { $0.lastPathComponent }, note: "name") }
            s.add(String(localized: "Quoted for the shell"), "square-terminal") { copy(urls.map { shellQuoted($0.path) }.joined(separator: " "), note: "quoted") }
            s.add(String(localized: "File URL"), "link") { copy(join { $0.absoluteString }, note: "file url") }
            s.add(String(localized: "Markdown link"), "hash") {
                copy(join { "[\($0.lastPathComponent)](\($0.absoluteString))" }, note: "markdown")
            }
            if urls.count == 1, !urls[0].hasDirectoryPath, let data = try? Data(contentsOf: urls[0], options: .alwaysMapped), data.count < 512 * 1024,
                let text = String(data: data, encoding: .utf8)
            {
                s.separator()
                s.add(String(localized: "Contents as text"), "file-text") { copy(text, note: "contents") }
            }
        }
    }

    /// The Git submenu for items in a repository: the file on the web, its link, the branch's name.
    static func gitMenu(_ urls: [URL], into b: MenuBuilder) {
        guard let first = urls.first, let root = Repo.root(of: first) else { return }
        b.sub(String(localized: "Git"), "git-branch") { s in
            s.add(String(localized: "Open on the web"), "globe") {
                if let u = Repo.webURL(for: first, root: root) { NSWorkspace.shared.open(u) } else { NSSound.beep() }
            }
            s.add(String(localized: "Copy web link"), "link") {
                if let u = Repo.webURL(for: first, root: root) { copy(u.absoluteString, note: "web link") } else { NSSound.beep() }
            }
            s.add(String(localized: "Open repository on the web"), "book-open") {
                if let u = Repo.webURL(root) { NSWorkspace.shared.open(u) } else { NSSound.beep() }
            }
            s.separator()
            s.add(String(localized: "Copy branch name"), "git-branch") {
                if let b = Repo.git(["rev-parse", "--abbrev-ref", "HEAD"], in: root) { copy(b, note: "branch") }
            }
            s.add(String(localized: "Open repository root"), "folder-git-2") {
                AppDelegate.shared.frontController?.navigate(to: root)
            }
        }
    }
}

/// Searching a folder and everything under it (the Windows app's search): Spotlight first, a walk of the folder when
/// Spotlight has nothing there (folders it does not index). A tab shows the results as a gathered listing, as a tag's.
enum SearchPlace {
    static let limit = 5000

    nonisolated static func url(in dir: URL, query: String) -> URL {
        var c = URLComponents()
        c.scheme = "rustyfiles"
        c.path = "search"
        c.queryItems = [URLQueryItem(name: "in", value: dir.path), URLQueryItem(name: "q", value: query)]
        return c.url!
    }

    /// (folder, query) of a search address.
    nonisolated static func parse(_ url: URL) -> (dir: URL, query: String)? {
        guard url.scheme == "rustyfiles", let c = URLComponents(url: url, resolvingAgainstBaseURL: false), c.path == "search",
            let dir = c.queryItems?.first(where: { $0.name == "in" })?.value, let q = c.queryItems?.first(where: { $0.name == "q" })?.value
        else { return nil }
        return (URL(fileURLWithPath: dir), q)
    }

    /// Paths under `dir` whose name contains `query` (case and accents ignored).
    nonisolated static func run(_ dir: URL, _ query: String) -> [String] {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return [] }
        let safe = q.replacingOccurrences(of: "\\", with: "").replacingOccurrences(of: "\"", with: "").replacingOccurrences(of: "*", with: "")
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/mdfind")
        p.arguments = ["-onlyin", dir.path, "kMDItemFSName == \"*\(safe)*\"cd"]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        var found: [String] = []
        if (try? p.run()) != nil {
            let data = out.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            found = String(decoding: data, as: UTF8.self).split(separator: "\n").prefix(limit).map(String.init)
        }
        if !found.isEmpty { return found }
        // not indexed: walk it (hidden items and the insides of packages skipped, as Finder's search does)
        guard let walk = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles, .skipsPackageDescendants])
        else { return [] }
        var visited = 0
        for case let u as URL in walk {
            visited += 1
            if visited > 300_000 || found.count >= limit { break }
            if u.lastPathComponent.range(of: q, options: [.caseInsensitive, .diacriticInsensitive]) != nil { found.append(u.path) }
        }
        return found
    }
}
