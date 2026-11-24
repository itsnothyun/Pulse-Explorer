import Foundation

/// A short note on a folder ("invoices 2026, send to the accountant"), kept on the folder itself (an extended attribute),
/// so it moves, copies and syncs with it and needs no database. Shown at the top of the folder and in the preview pane.
public enum FolderNotes {
    public static let attribute = "app.pulse.note"
    /// Long enough for a few paragraphs; extended attributes are small by design.
    public static let maxBytes = 16 * 1024

    public static func read(_ folder: URL) -> String? {
        let size = getxattr(folder.path, attribute, nil, 0, 0, 0)
        guard size > 0 else { return nil }
        var data = Data(count: size)
        let got = data.withUnsafeMutableBytes { getxattr(folder.path, attribute, $0.baseAddress, size, 0, 0) }
        guard got > 0 else { return nil }
        let s = String(decoding: data.prefix(got), as: UTF8.self)
        return s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : s
    }

    /// Writes the note (an empty one removes it). Throws when the folder can't hold one (no permission, a disk that
    /// keeps no attributes) or when it is too long.
    public static func write(_ note: String, to folder: URL) throws {
        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            if removexattr(folder.path, attribute, 0) != 0, errno != ENOATTR { throw posix(errno) }
            return
        }
        let data = Data(trimmed.utf8)
        guard data.count <= maxBytes else { throw Failure.tooLong }
        let r = data.withUnsafeBytes { setxattr(folder.path, attribute, $0.baseAddress, data.count, 0, 0) }
        if r != 0 { throw posix(errno) }
    }

    public enum Failure: LocalizedError, Equatable {
        case tooLong
        case system(String)
        public var errorDescription: String? {
            switch self {
            case .tooLong: "The note is too long (16 KB at most)."
            case .system(let m): m
            }
        }
    }

    static func posix(_ code: Int32) -> Failure { .system(String(cString: strerror(code))) }
}
