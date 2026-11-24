import Foundation

/// Run a project's scripts from the file manager: `package.json` scripts (with the package manager the project uses),
/// `Makefile` targets and `composer.json` scripts. Parsing is plain and kept in the file's order.
public enum ProjectScripts {
    public struct Script: Equatable, Sendable {
        public let name: String
        /// What it runs (the script body, or the make target's first recipe line), for the menu's hint.
        public let detail: String
        /// The command to type in a terminal, in the project's folder.
        public let command: String
    }

    public static let files: Set<String> = ["package.json", "makefile", "gnumakefile", "composer.json", "justfile"]

    public static func handles(_ url: URL) -> Bool { files.contains(url.lastPathComponent.lowercased()) }

    public static func scripts(in file: URL) -> [Script] {
        guard let text = try? String(contentsOf: file, encoding: .utf8) else { return [] }
        let dir = file.deletingLastPathComponent()
        switch file.lastPathComponent.lowercased() {
        case "package.json": return npm(text, manager: packageManager(in: dir))
        case "composer.json": return composer(text)
        case "makefile", "gnumakefile": return make(text)
        case "justfile": return just(text)
        default: return []
        }
    }

    /// pnpm, yarn or bun when their lock file is there (or a parent's, in a workspace), else npm.
    public static func packageManager(in dir: URL) -> String {
        var d = dir.standardizedFileURL.path
        for _ in 0..<6 {
            let has = { (f: String) in FileManager.default.fileExists(atPath: (d as NSString).appendingPathComponent(f)) }
            if has("pnpm-lock.yaml") { return "pnpm" }
            if has("yarn.lock") { return "yarn" }
            if has("bun.lockb") || has("bun.lock") { return "bun" }
            if has("package-lock.json") { return "npm" }
            let up = (d as NSString).deletingLastPathComponent
            if up == d || up.isEmpty { break }
            d = up
        }
        return "npm"
    }

    /// `"scripts": { … }`, in the order written (JSONSerialization would lose it).
    public static func npm(_ json: String, manager: String = "npm") -> [Script] {
        orderedObject(named: "scripts", in: json).map { name, body in
            let cmd = manager == "npm" ? "npm run \(quoteArg(name))" : "\(manager) run \(quoteArg(name))"
            return Script(name: name, detail: body, command: cmd)
        }
    }

    public static func composer(_ json: String) -> [Script] {
        orderedObject(named: "scripts", in: json).map { name, body in
            Script(name: name, detail: body, command: "composer run-script \(quoteArg(name))")
        }
    }

    /// Targets a person would run: `name:` at the start of a line, not special (.PHONY), not a pattern (%) or a variable.
    public static func make(_ text: String) -> [Script] {
        var out: [Script] = []
        var seen = Set<String>()
        let lines = text.components(separatedBy: "\n")
        for (i, line) in lines.enumerated() {
            guard let first = line.first, first != "\t", first != " ", first != "#", first != "." else { continue }
            guard let colon = line.firstIndex(of: ":"), !line[line.index(after: colon)...].hasPrefix("=") else { continue }
            let head = String(line[..<colon])
            if head.contains("=") || head.contains("%") || head.contains("$") { continue }
            for target in head.split(separator: " ").map(String.init) where !seen.contains(target) {
                seen.insert(target)
                let recipe = lines.dropFirst(i + 1).first { $0.hasPrefix("\t") }?.trimmingCharacters(in: .whitespaces) ?? ""
                out.append(Script(name: target, detail: recipe, command: "make \(quoteArg(target))"))
            }
        }
        return out
    }

    public static func just(_ text: String) -> [Script] {
        text.components(separatedBy: "\n").compactMap { line in
            guard let first = line.first, first.isLetter || first == "_", let colon = line.firstIndex(of: ":"),
                !line[line.index(after: colon)...].hasPrefix("=")
            else { return nil }
            let name = line[..<colon].split(separator: " ").first.map(String.init) ?? ""
            guard !name.isEmpty, !name.contains("=") else { return nil }
            return Script(name: name, detail: "", command: "just \(quoteArg(name))")
        }
    }

    /// The members of the top-level object `"name": { "a": "x", "b": "y" }`, in order; values that aren't strings
    /// (composer's arrays) are shown joined.
    static func orderedObject(named name: String, in json: String) -> [(String, String)] {
        guard let data = json.data(using: .utf8), let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let dict = root[name] as? [String: Any], !dict.isEmpty
        else { return [] }
        // the order: where each key first appears inside the object's text
        guard let start = json.range(of: "\"\(name)\"") else { return dict.keys.sorted().map { ($0, describe(dict[$0])) } }
        let tail = json[start.upperBound...]
        let positioned = dict.keys.map { key -> (String, String.Index) in
            (key, tail.range(of: "\"\(escape(key))\"")?.lowerBound ?? tail.endIndex)
        }
        return positioned.sorted { $0.1 < $1.1 }.map { ($0.0, describe(dict[$0.0])) }
    }

    static func describe(_ v: Any?) -> String {
        if let s = v as? String { return s }
        if let a = v as? [Any] { return a.map { "\($0)" }.joined(separator: " && ") }
        return ""
    }

    static func escape(_ s: String) -> String { s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") }

    /// A script name as one shell word ("build:web" stays bare; anything odd is single-quoted).
    public static func quoteArg(_ s: String) -> String {
        let safe = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_:./@+="))
        if !s.isEmpty, s.unicodeScalars.allSatisfy(safe.contains) { return s }
        return "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}
