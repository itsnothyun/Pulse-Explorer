import Foundation

/// "Paste as file": what is on the clipboard becomes a file in the folder. The decision is made from plain values (what
/// the clipboard offers), so it is the same in the app and in the tests.
public enum ClipboardFile {
    /// What the clipboard holds, in the order Pulse prefers it.
    public enum Content: Equatable {
        case png(Data)
        case pdf(Data)
        case link(URL, title: String?)
        case text(String)
    }

    /// A file to write: its name (free in the folder) and its bytes.
    public struct Output: Equatable {
        public let name: String
        public let data: Data
    }

    /// Pictures first (a screenshot copied), then a PDF, then a web address on its own, then any text.
    /// `image` is PNG bytes (the app converts TIFF and other pictures to PNG first).
    public static func choose(image: Data?, pdf: Data?, string: String?, urlTitle: String? = nil) -> Content? {
        if let image, !image.isEmpty { return .png(image) }
        if let pdf, !pdf.isEmpty { return .pdf(pdf) }
        guard let string, !string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.contains(where: \.isWhitespace), let url = URL(string: trimmed), let scheme = url.scheme?.lowercased(),
            ["http", "https"].contains(scheme), url.host != nil
        {
            return .link(url, title: urlTitle)
        }
        return .text(string)
    }

    /// The file for `content`, named so nothing in the folder is replaced (`taken`).
    public static func output(for content: Content, now: Date = Date(), taken: (String) -> Bool) -> Output {
        let stamp = Naming.stamp(now)
        switch content {
        case .png(let d):
            return Output(name: Naming.unique(base: "Pasted image \(stamp)", ext: "png", taken: taken), data: d)
        case .pdf(let d):
            return Output(name: Naming.unique(base: "Pasted document \(stamp)", ext: "pdf", taken: taken), data: d)
        case .link(let url, let title):
            // a .webloc opens the page with a double click, on the Mac as in Finder
            let base = title.map { Naming.sanitize($0) } ?? (url.host ?? "Link")
            return Output(name: Naming.unique(base: base, ext: "webloc", taken: taken), data: webloc(url))
        case .text(let s):
            // the first line, cut short, names a note; Markdown when it looks like Markdown
            let first = s.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
            var title = first.trimmingCharacters(in: CharacterSet(charactersIn: "#*>- \t"))
            if title.count > 40 { title = String(title.prefix(40)).trimmingCharacters(in: .whitespaces) + "…" }
            let ext = looksLikeMarkdown(s) ? "md" : "txt"
            let base = title.isEmpty ? "Pasted text \(stamp)" : title
            return Output(name: Naming.unique(base: base, ext: ext, taken: taken), data: Data(s.utf8))
        }
    }

    /// The property list a .webloc file is.
    public static func webloc(_ url: URL) -> Data {
        (try? PropertyListSerialization.data(fromPropertyList: ["URL": url.absoluteString], format: .xml, options: 0)) ?? Data()
    }

    static func looksLikeMarkdown(_ s: String) -> Bool {
        let lines = s.split(whereSeparator: \.isNewline)
        let marks = lines.filter { l in
            l.hasPrefix("# ") || l.hasPrefix("## ") || l.hasPrefix("- ") || l.hasPrefix("* ") || l.hasPrefix("```") || l.hasPrefix("> ")
        }
        return !marks.isEmpty && (marks.count * 4 >= lines.count || lines.first?.hasPrefix("#") == true)
    }
}
