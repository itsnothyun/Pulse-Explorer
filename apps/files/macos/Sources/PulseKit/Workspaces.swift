import Foundation

/// Named sets of tabs ("Client X", "Film project"), saved and opened again from the command palette or the File menu.
public struct Workspace: Codable, Equatable, Sendable {
    public var name: String
    /// The tabs' addresses: folder paths, or Pulse's own pages (rustyfiles:home…), web pages.
    public var tabs: [String]
    public var active: Int
    public var saved: Date

    public init(name: String, tabs: [String], active: Int, saved: Date = Date()) {
        self.name = name
        self.tabs = tabs
        self.active = active
        self.saved = saved
    }
}

public final class WorkspaceStore: @unchecked Sendable {
    private let defaults: UserDefaults
    private let key: String

    public init(defaults: UserDefaults = .standard, key: String = "pulseWorkspaces") {
        self.defaults = defaults
        self.key = key
    }

    public var all: [Workspace] {
        guard let data = defaults.data(forKey: key), let list = try? JSONDecoder().decode([Workspace].self, from: data) else { return [] }
        return list.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    /// Saves (or replaces, same name ignoring case) a workspace. Empty names and empty tab lists are refused.
    @discardableResult
    public func save(_ w: Workspace) -> Bool {
        let name = w.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, !w.tabs.isEmpty else { return false }
        var list = all.filter { $0.name.lowercased() != name.lowercased() }
        var clean = w
        clean.name = name
        clean.active = min(max(w.active, 0), w.tabs.count - 1)
        list.append(clean)
        guard let data = try? JSONEncoder().encode(list) else { return false }
        defaults.set(data, forKey: key)
        return true
    }

    public func remove(named name: String) {
        let list = all.filter { $0.name.lowercased() != name.lowercased() }
        defaults.set(try? JSONEncoder().encode(list), forKey: key)
    }

    public func named(_ name: String) -> Workspace? { all.first { $0.name.lowercased() == name.lowercased() } }
}
